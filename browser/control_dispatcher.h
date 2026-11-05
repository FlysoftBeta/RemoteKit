#pragma once
#include "base/values.h"
namespace remotekit::browser {
class BrowserRuntime;
struct ShutdownRequest;
struct OutputConfigureRequest;
struct OutputOpenRequest;
struct OutputStatusRequest;
struct OutputCloseRequest;
struct AudioOpenRequest;
struct AudioCloseRequest;
struct ClosedAckRequest;
struct SnapshotRequest;
struct SitePreferencesRequest;
struct CreateViewRequest;
struct CloseViewRequest;
struct RecreateViewRequest;
struct ConfigureViewRequest;
struct ProfileCommandRequest;
struct PageControlRequest;
struct ExitFullscreenRequest;
struct NavigationTransferRequest;
struct TouchStatusRequest;
struct FocusRequest;
struct VisibleRequest;
struct NavigateRequest;
struct LifecycleControlRequest;
struct InputRequest;
class ControlDispatcher {
 public:
  explicit ControlDispatcher(BrowserRuntime& runtime) : runtime_(runtime) {}
  base::DictValue Dispatch(const base::DictValue&);
  base::DictValue HandleShutdown(const ShutdownRequest&);
  base::DictValue HandleOutputConfigure(const OutputConfigureRequest&);
  base::DictValue HandleOutputOpen(const OutputOpenRequest&);
  base::DictValue HandleOutputStatus(const OutputStatusRequest&);
  base::DictValue HandleOutputClose(const OutputCloseRequest&);
  base::DictValue HandleAudioOpen(const AudioOpenRequest&);
  base::DictValue HandleAudioClose(const AudioCloseRequest&);
  base::DictValue HandleClosedAck(const ClosedAckRequest&);
  base::DictValue HandleSnapshot(const SnapshotRequest&);
  base::DictValue HandleSitePreferences(const SitePreferencesRequest&);
  base::DictValue HandleCreateView(const CreateViewRequest&);
  base::DictValue HandleCloseView(const CloseViewRequest&);
  base::DictValue HandleRecreateView(const RecreateViewRequest&);
  base::DictValue HandleConfigureView(const ConfigureViewRequest&);
  base::DictValue HandleProfileCommand(const ProfileCommandRequest&);
  base::DictValue HandlePageRequest(const PageControlRequest&);
  base::DictValue HandleExitFullscreen(const ExitFullscreenRequest&);
  base::DictValue HandleNavigationTransfer(const NavigationTransferRequest&);
  base::DictValue HandleTouchStatus(const TouchStatusRequest&);
  base::DictValue HandleFocus(const FocusRequest&);
  base::DictValue HandleVisible(const VisibleRequest&);
  base::DictValue HandleNavigate(const NavigateRequest&);
  base::DictValue HandleLifecycle(const LifecycleControlRequest&);
  base::DictValue HandleInput(const InputRequest&);

 private:
  BrowserRuntime& runtime_;
};
}  // namespace remotekit::browser
