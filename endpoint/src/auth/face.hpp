#pragma once
#include "auth/face_auth.hpp"
#include "auth/raw_camera.hpp"
#include "rtc/authorization.hpp"
#include "rtc/event.hpp"
#include "session/context.hpp"
namespace remotekit {
class AuthorizationController;
class FaceController : private ControllerContext {
 public:
  ~FaceController() { Stop(); }
  enum class State { kStopped, kRunning, kStopping, kFailed };
  State GetState() const { return state.load(); }
  FaceController(ControllerContext context, AuthorizationController& authorization)
      : ControllerContext(context), authorization(authorization), faces(FaceModels()) {}
  void Start(uint64_t peer);
  void Stop();
  void Cancel();
  void Receive(const RtcEvent& event);
  static fs::path FaceModels();
  static int64_t CameraNow();
  bool FacePending(uint64_t epoch, std::string_view challenge);
  void WakeCamera();
  void CameraLoop();
  static Json FaceCapabilities();
  Result<Json> FaceCommand(const std::string& method,
                           const Json& request,
                           uint64_t generation,
                           const std::function<bool()>& management_current);

 private:
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
