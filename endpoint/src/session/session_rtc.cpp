#include "session/session.hpp"
namespace remotekit {
void Session::HandlePeerEvent(const RtcEvent& event) {
  if (event.type == REMOTEKIT_RTC_AUTH_DATA_STATE) {
    raw_camera.State(event.peer, event.value == 1);
    WakeCamera();
    return;
  }
  if (event.type == REMOTEKIT_RTC_AUTH_DATA) {
    raw_camera.Receive(
        event.peer, event.value == 1, event.bytes.data(), event.bytes.size(), CameraNow(),
        [this](uint64_t epoch, std::string_view challenge) {
          return FacePending(epoch, challenge);
        },
        [this](int width, int height, const uint8_t* rgb, int stride) {
          faces.SubmitRGB24(width, height, rgb, stride);
        });
    WakeCamera();
    return;
  }
  if (event.type == REMOTEKIT_RTC_SDP_ANSWER)
    MarkConnection(ConnectionPhase::answer);
  else if (event.type == REMOTEKIT_RTC_ICE)
    MarkConnection(ConnectionPhase::first_candidate);
  else if (event.type == REMOTEKIT_RTC_ICE_COMPLETE)
    MarkConnection(ConnectionPhase::gather_complete);
  else if (event.type == REMOTEKIT_RTC_STATE && event.value == 2)
    MarkConnection(ConnectionPhase::connected);
  else if (event.type == REMOTEKIT_RTC_DATA_STATE && event.value == 1)
    MarkConnection(ConnectionPhase::data_open);
  if (event.type == REMOTEKIT_RTC_DATA) {
    auto routed = data_router.Receive(event);
    if (!routed)
      fprintf(stderr, "DataChannel receive: %s\n", routed.error().message.c_str());
    return;
  }
  if (event.type == REMOTEKIT_RTC_DATA_STATE) {
    data_router.DataState(event);
    return;
  }
  {
    std::lock_guard lock(event_mutex);
    if (events.size() < 1024)
      events.push_back(event);
  }
  event_wake.notify_all();
}

void Session::FlushSignals() {
  const auto stamp = authorization.Stamp();
  if (stamp)
    direct_services.DispatchPending(
        peer_controller.Handle(), 1000.0 * QpcNow() / QpcFrequency(), [&](const Json& message) {
          if (!authorization.Current(stamp))
            return false;
          return management.SendEvent(Json({{"event", "client.action"},
                                            {"tenantId", tenant},
                                            {"connectionId", peer_controller.Connection()},
                                            {"authEpoch", authorization.Epoch()},
                                            {"operationGeneration", message["operationGeneration"]},
                                            {"operationId", message["operationId"]},
                                            {"action", message["action"]}}),
                                      authorization.ManagementGeneration());
        });
  data_router.Drain();
  peer_controller.FlushSignals();
  direct_services.Editable(peer_controller.Handle(), pool.LatestMetadata(), output_suspended);
  FlushControl();
  FlushServices();
}
Result<Json> Session::Offer(const Json& request, uint64_t generation) {
  auto started = Start();
  if (!started)
    return started.error();
  comp_bitrate = options.encoding.bitrate;
  comp_fps = policy_max_fps.load();
  return peer_controller.Offer(request, generation, policy_max_fps.load(),
                               policy_degradation.load());
}
Result<void> Session::StartPeerResources(uint64_t handle, const std::string& sdp) {
  last_media_refresh_qpc = 0;
  stop_camera = false;
  camera_thread = std::thread([this] {
    RunThread(
        "camera", [this] { CameraLoop(); },
        [this] {
          stop_camera = true;
          std::lock_guard lock(camera_mutex);
          raw_camera.Cancel();
        });
  });
  if (sdp.find("m=audio ") != std::string::npos) {
    auto opened = OpenAudio();
    if (!opened)
      return opened.error();
  }
  input.Start(handle);
  media_thread = std::thread([this] {
    RunThread(
        "media", [this] { MediaLoop(); },
        [this] {
          stop_media = true;
          peer_controller.Failed();
        });
  });
  return {};
}
void Session::BindPeerResources(uint64_t handle) {
  for (auto& phase : connection_phases)
    phase = 0;
  connection_started_qpc = QpcNow();
  authorization.Bind();
  raw_camera.Bind(handle);
  refresh_connected = false;
  presentation.Bind(handle);
  control_outbox.Bind({handle, authorization.Stamp()});
  stop_media = false;
}
void Session::StopPeerResources() {
  authorization.Close();
  data_router.Clear();
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
    auto closed = browser.Rpc().Request({{"method", "audio.close"}});
    if (!closed)
      fprintf(stderr, "audio close: %s\n", closed.error().message.c_str());
  }

  audio_ring.Close();
  input.Stop();
  stop_media = true;
  event_wake.notify_all();
  if (media_thread.joinable())
    media_thread.join();
  presentation.Bind(0);
  control_outbox.Bind({});
  direct_services.Bind(0);
  presentation.InvalidateLayout("rtc-closed");
}
void Session::DrainPeerResources() {
  std::map<uint64_t, std::unique_ptr<EncoderWorker>> remaining;
  {
    std::lock_guard lock(encoder_mutex);
    remaining.swap(encoders);
  }
  remaining.clear();
  // Producer shutdown and render FIFO draining have independent completion.
  if (browser.Rpc().Control() && !ProducerExited()) {
    auto closed = browser.Rpc().Request({{"method", "output.close"}});
    if (!closed)
      fprintf(stderr, "product output close unfinished: %s\n", closed.error().message.c_str());
  }
  std::string close_error;
  if (!pool.Close(close_error))
    fprintf(stderr, "render close: %s\n", close_error.c_str());
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
void Session::ClosePeer() {
  peer_controller.Close();
}
}  // namespace remotekit
