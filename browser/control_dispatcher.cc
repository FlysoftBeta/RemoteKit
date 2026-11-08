#include "browser/control_dispatcher.h"
#include "browser/clipboard_bridge.h"
#include "browser/control_requests.h"
#include "browser/control_response.h"
#include "browser/browser_runtime.h"

namespace remotekit::browser {
namespace {
template <class Request,
          Result<Request> (*Decode)(const base::DictValue&, RequestEnvelope),
          ControlResult (ControlDispatcher::*Handle)(const Request&)>
base::DictValue Invoke(ControlDispatcher& dispatcher,
                       const base::DictValue& wire,
                       RequestEnvelope envelope) {
  auto decoded = Decode(wire, envelope);
  if (!decoded)
    return ControlResult::Failure(envelope.id, decoded.status.error, decoded.status.message);
  return (dispatcher.*Handle)(decoded.value).TakeFields();
}
}  // namespace
void ControlDispatcher::Dispatch(const base::DictValue& request, Reply reply) {
  const auto id = request.FindInt("id").value_or(0);
  const auto* name = request.FindString("method");
  if (runtime_.shutting_down && (!name || *name != protocol::kBrowserShutdown)) {
    std::move(reply).Run(
        ControlResult::Failure(id, ErrorCode::unavailable, "Browser shutdown started"));
    return;
  }
  if (id <= 0 || request.FindInt("version") != protocol::kControlVersion || !name) {
    std::move(reply).Run(
        ControlResult::Failure(id, ErrorCode::invalid_request, "Invalid control envelope"));
    return;
  }
  if (*name == "clipboard.read") {
    std::move(reply).Run(runtime_.clipboard->Read(id));
    return;
  }
  if (*name == "clipboard.write") {
    std::move(reply).Run(runtime_.clipboard->Write(id, request));
    return;
  }
  if (*name == protocol::kViewAppInfo) {
    auto decoded = DecodeAppInfo(request, {id, protocol::kViewAppInfo});
    if (!decoded) {
      std::move(reply).Run(
          ControlResult::Failure(id, decoded.status.error, decoded.status.message));
      return;
    }
    HandleAppInfo(decoded.value, std::move(reply));
    return;
  }
  struct Method {
    std::string_view name;
    base::DictValue (*handler)(ControlDispatcher&, const base::DictValue&, RequestEnvelope);
  };
  static constexpr Method methods[] = {
      {protocol::kIdentity,
       &Invoke<IdentityRequest, DecodeIdentity, &ControlDispatcher::HandleIdentity>},
      {protocol::kStorageImport,
       &Invoke<StorageImportRequest, DecodeStorageImport, &ControlDispatcher::HandleStorageImport>},
      {protocol::kStorageImportStatus,
       &Invoke<StorageImportStatusRequest, DecodeStorageImportStatus,
               &ControlDispatcher::HandleStorageImportStatus>},
      {protocol::kBrowserShutdown,
       &Invoke<ShutdownRequest, DecodeShutdown, &ControlDispatcher::HandleShutdown>},
      {protocol::kStorageScavenge, &Invoke<StorageScavengeRequest, DecodeStorageScavenge,
                                           &ControlDispatcher::HandleStorageScavenge>},
      {"output.configure", &Invoke<OutputConfigureRequest, DecodeOutputConfigure,
                                   &ControlDispatcher::HandleOutputConfigure>},
      {"output.open",
       &Invoke<OutputOpenRequest, DecodeOutputOpen, &ControlDispatcher::HandleOutputOpen>},
      {"output.describe",
       &Invoke<OutputOpenRequest, DecodeOutputOpen, &ControlDispatcher::HandleOutputOpen>},
      {"output.status",
       &Invoke<OutputStatusRequest, DecodeOutputStatus, &ControlDispatcher::HandleOutputStatus>},
      {"output.close",
       &Invoke<OutputCloseRequest, DecodeOutputClose, &ControlDispatcher::HandleOutputClose>},
      {"audio.open",
       &Invoke<AudioOpenRequest, DecodeAudioOpen, &ControlDispatcher::HandleAudioOpen>},
      {"audio.close",
       &Invoke<AudioCloseRequest, DecodeAudioClose, &ControlDispatcher::HandleAudioClose>},
      {"view.closed.ack",
       &Invoke<ClosedAckRequest, DecodeClosedAck, &ControlDispatcher::HandleClosedAck>},
      {"snapshot", &Invoke<SnapshotRequest, DecodeSnapshot, &ControlDispatcher::HandleSnapshot>},
      {"session.sitePreferences", &Invoke<SitePreferencesRequest, DecodeSitePreferences,
                                          &ControlDispatcher::HandleSitePreferences>},
      {"view.create",
       &Invoke<CreateViewRequest, DecodeCreateView, &ControlDispatcher::HandleCreateView>},
      {"view.adopt",
       &Invoke<CreateViewRequest, DecodeCreateView, &ControlDispatcher::HandleCreateView>},
      {"view.close",
       &Invoke<CloseViewRequest, DecodeCloseView, &ControlDispatcher::HandleCloseView>},
      {"view.recreate",
       &Invoke<RecreateViewRequest, DecodeRecreateView, &ControlDispatcher::HandleRecreateView>},
      {"view.configure",
       &Invoke<ConfigureViewRequest, DecodeConfigureView, &ControlDispatcher::HandleConfigureView>},
      {"profile.permissions", &Invoke<ProfileCommandRequest, DecodeProfileCommand,
                                      &ControlDispatcher::HandleProfileCommand>},
      {"profile.downloads", &Invoke<ProfileCommandRequest, DecodeProfileCommand,
                                    &ControlDispatcher::HandleProfileCommand>},
      {"page.contextMenu",
       &Invoke<PageControlRequest, DecodePageRequest, &ControlDispatcher::HandlePageRequest>},
      {"page.requests",
       &Invoke<PageControlRequest, DecodePageRequest, &ControlDispatcher::HandlePageRequest>},
      {"page.reply",
       &Invoke<PageControlRequest, DecodePageRequest, &ControlDispatcher::HandlePageRequest>},
      {"page.command",
       &Invoke<PageControlRequest, DecodePageRequest, &ControlDispatcher::HandlePageRequest>},
      {"page.fileStatus",
       &Invoke<PageControlRequest, DecodePageRequest, &ControlDispatcher::HandlePageRequest>},
      {"page.exitFullscreen", &Invoke<ExitFullscreenRequest, DecodeExitFullscreen,
                                      &ControlDispatcher::HandleExitFullscreen>},
      {"navigation.ack", &Invoke<NavigationTransferRequest, DecodeNavigationTransfer,
                                 &ControlDispatcher::HandleNavigationTransfer>},
      {"navigation.export.begin", &Invoke<NavigationTransferRequest, DecodeNavigationTransfer,
                                          &ControlDispatcher::HandleNavigationTransfer>},
      {"navigation.import.begin", &Invoke<NavigationTransferRequest, DecodeNavigationTransfer,
                                          &ControlDispatcher::HandleNavigationTransfer>},
      {"navigation.transfer.cancel", &Invoke<NavigationTransferRequest, DecodeNavigationTransfer,
                                             &ControlDispatcher::HandleNavigationTransfer>},
      {"navigation.export.chunk", &Invoke<NavigationTransferRequest, DecodeNavigationTransfer,
                                          &ControlDispatcher::HandleNavigationTransfer>},
      {"navigation.import.chunk", &Invoke<NavigationTransferRequest, DecodeNavigationTransfer,
                                          &ControlDispatcher::HandleNavigationTransfer>},
      {"navigation.import.commit", &Invoke<NavigationTransferRequest, DecodeNavigationTransfer,
                                           &ControlDispatcher::HandleNavigationTransfer>},
      {"focus", &Invoke<FocusRequest, DecodeFocus, &ControlDispatcher::HandleFocus>},
      {"visible", &Invoke<VisibleRequest, DecodeVisible, &ControlDispatcher::HandleVisible>},
      {"navigate", &Invoke<NavigateRequest, DecodeNavigate, &ControlDispatcher::HandleNavigate>},
      {"lifecycle",
       &Invoke<LifecycleControlRequest, DecodeLifecycle, &ControlDispatcher::HandleLifecycle>},
      {"input", &Invoke<InputRequest, DecodeInput, &ControlDispatcher::HandleInput>},
  };
  for (const auto& method : methods) {
    if (method.name == *name) {
      std::move(reply).Run(method.handler(*this, request, {id, method.name}));
      return;
    }
  }
  std::move(reply).Run(
      ControlResult::Failure(id, ErrorCode::unsupported, "Unknown control method"));
}
}  // namespace remotekit::browser
