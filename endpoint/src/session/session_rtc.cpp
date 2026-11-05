#include "session/session.hpp"
namespace remotekit {
Result<Json> Session::Offer(const Json& request, uint64_t generation) {
  {
    auto start_result = Start();
    if (!start_result)
      return start_result.error();
  }
  ClosePeer();
  peer_management_generation = generation;
  for (auto& phase : connection_phases)
    phase = 0;
  connection_started_qpc = QpcNow();
  connection = Required(request, "connectionId");
  {
    std::lock_guard lock(signal_mutex);
    signal_events.clear();
    signal_overflow = false;
  }
  remotekit_rtc_options config{};
  config.struct_size = sizeof(config);
  config.abi_version = REMOTEKIT_RTC_ABI_VERSION;
  config.auth_required = 1;
  config.context = this;
  config.event = EventCallback;
  config.encoder.struct_size = sizeof(config.encoder);
  config.encoder.create = CreateEncoder;
  config.encoder.configure = ConfigureEncoder;
  config.encoder.encode = Encode;
  config.encoder.set_rates = Rates;
  config.encoder.request_keyframe = Keyframe;
  config.encoder.destroy = DestroyEncoder;
  config.min_bitrate_bps = 500000;
  config.start_bitrate_bps = options.encoding.bitrate;
  config.max_bitrate_bps = options.encoding.max_bitrate;
  comp_bitrate = options.encoding.bitrate;
  comp_fps = policy_max_fps.load();
  uint64_t handle = 0;
  if (sdk.remotekit_rtc_create(&config, &handle) != 0)
    return Error{ErrorCode::kRejected, "RTC create failed"};
  if (sdk.remotekit_rtc_set_degradation_preference(handle, policy_degradation) != 0 ||
      sdk.remotekit_rtc_set_source_max_fps(handle, policy_max_fps) != 0) {
    sdk.remotekit_rtc_close(handle);
    return Error{ErrorCode::kRejected, "RTC media policy rejected"};
  }
  {
    std::lock_guard transition(authorization_mutex);
    std::lock_guard admission(admission_mutex);
    authorization.Bind();
    raw_camera.Bind(handle);
    management_generation = generation;
    receive_level = 0;
    refresh_connected = false;
    presentation.Bind(handle);
    control_outbox.Bind(handle);
    layout_prepare.reset();
    peer = handle;
    input_sequence.Bind(handle);
    stop_media = false;
    data_open = false;
    layout = Json();
  }
  last_media_refresh_qpc = 0;
  {
    const int status = sdk.remotekit_rtc_set_playout_delay(handle, RuntimeOptions::kRtcPlayoutMinMs,
                                                           RuntimeOptions::kRtcPlayoutMaxMs);
    if (status != 0) {
      ClosePeer();
      return Error{ErrorCode::kRejected,
                   "RTC playout delay rejected (SDK " + std::to_string(status) + ")"};
    }
  }
  auto sdp = Required(request, "sdp");
  if (sdk.remotekit_rtc_set_remote_description(handle, 1, sdp.data(), sdp.size()) != 0) {
    ClosePeer();
    return Error{ErrorCode::kRejected, "RTC remote offer rejected"};
  }
  {
    stop_camera = false;
    {
      camera_thread = std::thread([this] {
        RunThread(
            "camera", [this] { CameraLoop(); },
            [this] {
              stop_camera = true;
              std::lock_guard lock(camera_mutex);
              raw_camera.Cancel();
            });
      });
    }
  }
  if (sdp.find("m=audio ") != std::string::npos) {
    {
      {
        auto open_audio_result = OpenAudio();
        if (!open_audio_result) {
          const Error operation_error = open_audio_result.error();
          ClosePeer();
          return operation_error;
        }
      }
    }
  }
  uint32_t level = 0;
  if (sdk.remotekit_rtc_get_receive_level(handle, &level) != 0 || !level) {
    ClosePeer();
    return Error{ErrorCode::kInvalidRequest, "peer has no compatible receiving H264 level"};
  }
  receive_level = level;
  stop_input = false;
  input_thread = std::thread([this] {
    RunThread(
        "input", [this] { InputLoop(); },
        [this] {
          stop_input = true;
          input_authorization = 0;
        });
  });
  media_thread = std::thread([this] {
    RunThread(
        "media", [this] { MediaLoop(); },
        [this] {
          stop_media = true;
          rtc_connected = false;
        });
  });
  return Json{{"accepted", true}, {"pending", true}, {"connectionId", connection}};
}

void Session::FlushSignals() {
  const auto stamp = authorization.Stamp();
  if (stamp)
    direct_services.DispatchPending(
        peer.load(), 1000.0 * QpcNow() / QpcFrequency(), [&](const Json& message) {
          if (!authorization.Current(stamp))
            return false;
          return management.SendEvent(Json({{"event", "client.action"},
                                            {"tenantId", tenant},
                                            {"connectionId", connection},
                                            {"authEpoch", authorization.Epoch()},
                                            {"operationGeneration", message["operationGeneration"]},
                                            {"operationId", message["operationId"]},
                                            {"action", message["action"]}}),
                                      management_generation);
        });
  std::deque<Event> pending;
  {
    std::lock_guard lock(signal_mutex);
    pending.swap(signal_events);
  }
  for (const auto& event : pending) {
    if (!peer.load() || event.peer != peer.load())
      continue;
    Json signal;
    if (event.type == REMOTEKIT_RTC_SDP_ANSWER)
      signal = {{"type", "answer"}, {"sdp", event.bytes}};
    else if (event.type == REMOTEKIT_RTC_ICE)
      signal = {{"type", "ice"},
                {"candidate",
                 {{"candidate", event.bytes},
                  {"sdpMid", event.auxiliary},
                  {"sdpMLineIndex", event.value}}}};
    else if (event.type == REMOTEKIT_RTC_ICE_COMPLETE)
      signal = {{"type", "complete"}};
    else if (event.type == REMOTEKIT_RTC_ERROR)
      signal = {{"type", "error"}, {"message", event.bytes}};
    else
      continue;
    management.SendEvent(Json({{"event", "rtc.signal"},
                               {"tenantId", tenant},
                               {"connectionId", connection},
                               {"signal", signal}}),
                         event.management_generation);
  }
}

int Session::RevokeProduct() {
  {
    std::lock_guard admission(admission_mutex);
    authorization.Close();
    frame_authorization = 0;
    input_authorization = 0;
    file_services.Bind(0);
  }
  raw_camera.Cancel();
  faces.Cancel();
  WakeCamera();
  const auto handle = peer.load();
  const int status = handle ? sdk.remotekit_rtc_set_media_authorized(handle, 0) : 0;
  direct_services.Bind(0);
  {
    std::lock_guard lock(input_mutex);
    input_queue.clear();
  }
  event_wake.notify_all();
  return status;
}

Result<uint64_t> Session::AuthorizationEpoch(const Json& request) {
  const auto& value = request.at("epoch");
  if (!value.is_number_unsigned() || !value.get<uint64_t>() ||
      value.get<uint64_t>() > 9007199254740991ULL)
    return Error{ErrorCode::kForbidden, "invalid_authorization_epoch"};
  return value.get<uint64_t>();
}

Result<void> Session::RequireAuthPeer(const Json& request) {
  if (!peer.load() || Required(request, "connectionId") != connection)
    return Error{ErrorCode::kConflict, "stale_rtc_connection"};

  return {};
}

Result<Json> Session::Authorize(const Json& request,
                                uint64_t generation,
                                const std::function<bool()>& management_current) {
  std::lock_guard transition(authorization_mutex);
  {
    auto require_auth_peer_result = RequireAuthPeer(request);
    if (!require_auth_peer_result)
      return require_auth_peer_result.error();
  }
  if (!management_current())
    return Error{ErrorCode::kUnavailable, "management_disconnected"};
  auto authorization_epoch_result = AuthorizationEpoch(request);
  if (!authorization_epoch_result)
    return authorization_epoch_result.error();
  const auto epoch = std::move(authorization_epoch_result).value();
  const bool unlocked = request.at("unlocked").get<bool>();
  const auto decision = authorization.Check(epoch, unlocked);
  using Decision = remotekit::ProductAuthorization::Decision;
  if (decision == Decision::reject)
    return Error{ErrorCode::kConflict, "stale_authorization_epoch"};
  if (decision == Decision::change) {
    management_generation = generation;
    if (RevokeProduct() != 0)
      return Error{ErrorCode::kForbidden, "rtc_media_authorization_failed"};
    if (unlocked) {
      const auto handle = peer.load();
      if (sdk.remotekit_rtc_set_media_authorized(handle, 1) != 0)
        return Error{ErrorCode::kForbidden, "rtc_media_authorization_failed"};
      direct_services.Bind(handle, connection);
      {
        std::lock_guard admission(admission_mutex);
        file_services.Bind(handle, connection);
        audio_authorized_after = QpcNow();
        authorization.Commit(epoch, true);
        authorization.Open();
      }
      if (!management_current()) {
        RevokeProduct();
        return Error{ErrorCode::kUnavailable, "management_disconnected"};
      }
    }
    if (!unlocked)
      authorization.Commit(epoch, false);
    event_wake.notify_all();
  }
  management_generation = generation;
  return Json{{"applied", true}, {"epoch", epoch}};
}

Json Session::FaceCapabilities() {
  const auto capability = rk::auth::Faces::Capabilities(FaceModels());
  Json result = {{"available", capability.available}, {"modelVersion", capability.model_version}};
  if (!capability.reason.empty())
    result["reason"] = capability.reason;
  return result;
}

Result<Json> Session::FaceCommand(const std::string& method,
                                  const Json& request,
                                  uint64_t generation,
                                  const std::function<bool()>& management_current) {
  std::lock_guard transition(authorization_mutex);
  {
    auto require_auth_peer_result_2 = RequireAuthPeer(request);
    if (!require_auth_peer_result_2)
      return require_auth_peer_result_2.error();
  }
  auto authorization_epoch_result_2 = AuthorizationEpoch(request);
  if (!authorization_epoch_result_2)
    return authorization_epoch_result_2.error();
  const auto epoch = std::move(authorization_epoch_result_2).value();
  if (epoch != authorization.Epoch() || management_generation != generation ||
      !management_current())
    return Error{ErrorCode::kConflict, "stale_authorization_epoch"};
  const auto challenge = Required(request, "challengeId");
  if (!rk::auth::CameraChallengeId(challenge))
    return Error{ErrorCode::kInvalidRequest, "invalid_face_challenge"};
  if (method == "auth.face.cancel") {
    raw_camera.Cancel(epoch, challenge);
    faces.Cancel(epoch, challenge);
    return Json{{"cancelled", true}};
  }
  if (method == "auth.face.status") {
    const auto result = faces.Status(epoch, challenge);
    if (!result)
      return Error{ErrorCode::kConflict, "stale_face_challenge"};
    using State = rk::auth::FaceState;
    const char* state = nullptr;
    switch (result->state) {
      case State::pending:
        state = "pending";
        break;
      case State::matched:
        state = "matched";
        break;
      case State::enrolled:
        state = "enrolled";
        break;
      case State::absent:
        state = "absent";
        break;
      case State::failed:
        state = "failed";
        break;
      case State::expired:
        state = "expired";
        break;
    }
    Json reply = {{"challengeId", challenge}, {"status", state}};
    if (result->state == State::enrolled && result->face_template)
      reply["template"] = *result->face_template;
    if (!result->reason.empty())
      reply["reason"] = result->reason;
    return reply;
  }
  if (method != "auth.face.begin")
    return Error{ErrorCode::kInvalidRequest, "unknown_face_method"};
  using Purpose = rk::auth::FacePurpose;
  const auto purpose = Required(request, "purpose");
  Purpose kind;
  uint32_t maximum;
  if (purpose == "enroll") {
    kind = Purpose::enroll;
    maximum = 60000;
  } else if (purpose == "verify") {
    kind = Purpose::verify;
    maximum = 30000;
  } else if (purpose == "presence") {
    kind = Purpose::presence;
    maximum = 120000;
  } else
    return Error{ErrorCode::kInvalidRequest, "invalid_face_purpose"};
  const bool unlocked = authorization.Stamp() != 0;
  if ((kind == Purpose::enroll && !unlocked) || (kind == Purpose::verify && unlocked))
    return Error{ErrorCode::kForbidden, "invalid_face_authorization"};
  const auto& timeout = request.at("timeoutMs");
  if (!timeout.is_number_unsigned() || !timeout.get<uint64_t>() ||
      timeout.get<uint64_t>() > maximum)
    return Error{ErrorCode::kInvalidRequest, "invalid_face_timeout"};
  rk::auth::FaceChallenge input{epoch, challenge, kind, timeout.get<uint32_t>(), {}};
  const auto model = request.find("template");
  if (kind == Purpose::enroll) {
    if (model != request.end())
      return Error{ErrorCode::kInvalidRequest, "unexpected_face_template"};
  } else {
    rk::auth::FaceTemplate value{};
    if (model == request.end() || !model->is_array() || model->size() != value.size())
      return Error{ErrorCode::kInvalidRequest, "invalid_face_template"};
    double norm = 0;
    for (size_t i = 0; i < value.size(); ++i) {
      if (!(*model)[i].is_number())
        return Error{ErrorCode::kInvalidRequest, "invalid_face_template"};
      const double sample = (*model)[i].get<double>();
      if (!std::isfinite(sample) || std::abs(sample) > 1.01)
        return Error{ErrorCode::kInvalidRequest, "invalid_face_template"};
      value[i] = static_cast<float>(sample);
      norm += sample * sample;
    }
    if (std::abs(norm - 1) > 0.01)
      return Error{ErrorCode::kInvalidRequest, "invalid_face_template"};
    input.face_template = value;
  }
  // Do not let a final chunk from the old challenge enter the new worker.
  raw_camera.Cancel();
  if (!faces.Begin(std::move(input)))
    return Error{ErrorCode::kUnavailable, "face_challenge_unavailable"};
  raw_camera.Begin(peer.load(), epoch, challenge, CameraNow() + timeout.get<uint32_t>());
  WakeCamera();
  return Json{{"accepted", true}};
}

void Session::ClosePeer() {
  {
    std::lock_guard transition(authorization_mutex);
    RevokeProduct();
    management_generation = 0;
    peer_management_generation = 0;
  }
  stop_camera = true;
  raw_camera.Bind(0);
  WakeCamera();
  if (camera_thread.joinable())
    camera_thread.join();
  const bool had_audio = audio_ring.IsOpen();
  stop_audio = true;
  if (audio_thread.joinable())
    audio_thread.join();
  if (had_audio && browser.Rpc().Control() && Alive()) {
    {
      auto audio_close_result = browser.Rpc().Request({{"method", "audio.close"}});
      if (!audio_close_result) {
        const Error error = audio_close_result.error();
        fprintf(stderr, "audio close: %s\n", error.message.c_str());
      }
    }
  }

  audio_ring.Close();
  stop_input = true;
  input_wake.notify_all();
  if (input_thread.joinable())
    input_thread.join();
  stop_media = true;
  event_wake.notify_all();
  if (media_thread.joinable())
    media_thread.join();
  rtc_connected = false;
  presentation.Bind(0);
  control_outbox.Bind(0);
  direct_services.Bind(0);
  layout_prepare.reset();
  InvalidateLayout("rtc-closed");
  {
    std::lock_guard lock(input_mutex);
    input_queue.clear();
    input_sequence.Bind(0);
  }
  auto handle = peer.exchange(0);
  media_feedback.Bind(0, "", "");
  if (handle)
    sdk.remotekit_rtc_close(handle);
  std::map<uint64_t, std::unique_ptr<EncoderWorker>> remaining;
  {
    std::lock_guard lock(encoder_mutex);
    remaining.swap(encoders);
  }
  remaining.clear();
  // Product output stop and the render generation FIFO barrier are separate.
  // Stop/Stopped can drain accepted Begins even if the browser.Rpc().Control() RPC failed.
  if (browser.Rpc().Control() && !ProducerExited()) {
    {
      {
        auto output_close_result = browser.Rpc().Request({{"method", "output.close"}});
        if (!output_close_result) {
          const Error error = output_close_result.error();
          fprintf(stderr, "product output close unfinished: %s\n", error.message.c_str());
        }
      }
    }
  }
  std::string close_error;
  if (!pool.Close(close_error))
    fprintf(stderr, "render close: %s\n", close_error.c_str());
  data_open = false;
  connection.clear();
  {
    std::lock_guard lock(stats->mutex);
    stats->sender_rtc_stats = nullptr;
  }
  {
    std::lock_guard lock(event_mutex);
    events.clear();
  }
  if (trace)
    trace->Flush();
}
}  // namespace remotekit
