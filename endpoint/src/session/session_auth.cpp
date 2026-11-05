#include "session/session.hpp"
namespace remotekit {
int64_t Session::CameraNow() {
  return static_cast<int64_t>(1000.0 * QpcNow() / QpcFrequency());
}

bool Session::FacePending(uint64_t epoch, std::string_view challenge) {
  const auto result = faces.Status(epoch, challenge);
  return result && result->state == rk::auth::FaceState::pending;
}

void Session::WakeCamera() {
  {
    std::lock_guard lock(camera_mutex);
    camera_changed = true;
  }
  camera_wake.notify_one();
}

void Session::CameraLoop() {
  const auto pending = [&](uint64_t epoch, std::string_view challenge) {
    return FacePending(epoch, challenge);
  };
  while (!stop_camera) {
    {
      if (auto message = raw_camera.Next(CameraNow(), pending)) {
        if (sdk.remotekit_rtc_send_auth_data(message->peer, message->json.data(),
                                             message->json.size(), 0) != 0)
          raw_camera.Failed(*message);
        else
          raw_camera.Sent(*message, CameraNow());
      }
    }
    const bool active = raw_camera.Active();
    std::unique_lock lock(camera_mutex);
    const auto ready = [&] { return stop_camera || camera_changed; };
    if (active)
      camera_wake.wait_for(lock, std::chrono::milliseconds(20), ready);
    else
      camera_wake.wait(lock, ready);
    camera_changed = false;
  }
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
  auto transition = authorization.LockTransition();
  {
    auto require_auth_peer_result_2 = authorization.RequireAuthPeer(request);
    if (!require_auth_peer_result_2)
      return require_auth_peer_result_2.error();
  }
  auto authorization_epoch_result_2 = AuthorizationController::AuthorizationEpoch(request);
  if (!authorization_epoch_result_2)
    return authorization_epoch_result_2.error();
  const auto epoch = std::move(authorization_epoch_result_2).value();
  if (epoch != authorization.Epoch() || authorization.ManagementGeneration() != generation ||
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
  rk::auth::FaceChallenge face_challenge{epoch, challenge, kind, timeout.get<uint32_t>(), {}};
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
    face_challenge.face_template = value;
  }
  // Do not let a final chunk from the old challenge enter the new worker.
  raw_camera.Cancel();
  if (!faces.Begin(std::move(face_challenge)))
    return Error{ErrorCode::kUnavailable, "face_challenge_unavailable"};
  raw_camera.Begin(peer_controller.Handle(), epoch, challenge,
                   CameraNow() + timeout.get<uint32_t>());
  WakeCamera();
  return Json{{"accepted", true}};
}

}  // namespace remotekit
