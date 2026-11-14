#pragma once
#include "auth/face_auth.hpp"
#include "auth/raw_camera.hpp"
#include "rtc/authorization.hpp"
#include "rtc/event.hpp"
#include "util/retry_unit.hpp"
#include <atomic>
#include <condition_variable>
#include <thread>
namespace remotekit {
class AuthorizationController;
class FaceController {
 public:
  ~FaceController() { Stop(); }
  enum class State { kStopped, kRunning, kStopping, kFailed };
  FaceController(media::Sdk& sdk,
                 std::string tenant,
                 std::string id,
                 AuthorizationController& authorization)
      : sdk(sdk),
        tenant(std::move(tenant)),
        id(std::move(id)),
        authorization(authorization),
        faces(FaceModels()) {}
  void Start(uint64_t peer);
  void Stop();
  void Cancel();
  void Receive(const RtcEvent& event);
  static fs::path FaceModels();
  static int64_t CameraNow();
  bool FacePending(uint64_t epoch, std::string_view challenge);
  void WakeCamera();
  void CameraLoop();
  RetryUnit::Snapshot CameraRetryStatus() const;
  static Json FaceCapabilities();
  Result<Json> FaceCommand(const std::string& method,
                           const Json& request,
                           uint64_t generation,
                           const std::function<bool()>& management_current);

 private:
  friend class NativeRetryOwnerProbe;
  void DeliverCamera(const rk::auth::RawCamera::Pending& pending, int64_t now);
  mutable std::mutex camera_retry_mutex_;
  RetryUnit camera_retry_{"camera.delivery"};
  std::optional<rk::auth::RawCamera::Message> delivery_;
  media::Sdk& sdk;
  const std::string tenant, id;
  AuthorizationController& authorization;
  rk::auth::Faces faces;
  rk::auth::RawCamera raw_camera;
  std::mutex camera_mutex;
  std::condition_variable camera_wake;
  bool camera_changed = false;
  std::thread camera_thread;
  std::atomic<State> state{State::kStopped};
};
}  // namespace remotekit
