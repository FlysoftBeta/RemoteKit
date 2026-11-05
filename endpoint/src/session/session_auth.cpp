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
}  // namespace remotekit
