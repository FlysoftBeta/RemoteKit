#pragma once
#include "base/values.h"
namespace remotekit::browser {
class BrowserRuntime;
class ControlResult;
struct ShutdownRequest;
struct StorageScavengeRequest;
struct IdentityRequest;
struct StorageImportRequest;
struct StorageImportStatusRequest;
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
struct FocusRequest;
struct VisibleRequest;
struct NavigateRequest;
struct LifecycleControlRequest;
struct InputRequest;
class ControlDispatcher {
 public:
  explicit ControlDispatcher(BrowserRuntime& runtime) : runtime_(runtime) {}
  base::DictValue Dispatch(const base::DictValue&);
  ControlResult HandleShutdown(const ShutdownRequest&);
  ControlResult HandleIdentity(const IdentityRequest&);
  ControlResult HandleStorageImport(const StorageImportRequest&);
  ControlResult HandleStorageImportStatus(const StorageImportStatusRequest&);
  ControlResult HandleStorageScavenge(const StorageScavengeRequest&);
  ControlResult HandleOutputConfigure(const OutputConfigureRequest&);
  ControlResult HandleOutputOpen(const OutputOpenRequest&);
  ControlResult HandleOutputStatus(const OutputStatusRequest&);
  ControlResult HandleOutputClose(const OutputCloseRequest&);
  ControlResult HandleAudioOpen(const AudioOpenRequest&);
  ControlResult HandleAudioClose(const AudioCloseRequest&);
  ControlResult HandleClosedAck(const ClosedAckRequest&);
  ControlResult HandleSnapshot(const SnapshotRequest&);
  ControlResult HandleSitePreferences(const SitePreferencesRequest&);
  ControlResult HandleCreateView(const CreateViewRequest&);
  ControlResult HandleCloseView(const CloseViewRequest&);
  ControlResult HandleRecreateView(const RecreateViewRequest&);
  ControlResult HandleConfigureView(const ConfigureViewRequest&);
  ControlResult HandleProfileCommand(const ProfileCommandRequest&);
  ControlResult HandlePageRequest(const PageControlRequest&);
  ControlResult HandleExitFullscreen(const ExitFullscreenRequest&);
  ControlResult HandleNavigationTransfer(const NavigationTransferRequest&);
  ControlResult HandleFocus(const FocusRequest&);
  ControlResult HandleVisible(const VisibleRequest&);
  ControlResult HandleNavigate(const NavigateRequest&);
  ControlResult HandleLifecycle(const LifecycleControlRequest&);
  ControlResult HandleInput(const InputRequest&);

 private:
  BrowserRuntime& runtime_;
};
}  // namespace remotekit::browser
