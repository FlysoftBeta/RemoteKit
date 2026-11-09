#include "browser/webview_navigation.h"
#include "browser/signin.h"
#include "browser/signin_result.h"
#include "browser/page_requests.h"
#include "browser/webview_internal.h"
#include "browser/webview_execution.h"
#include "browser/device_configuration.h"
#include "browser/webview_input.h"
#include "browser/webview_touch.h"
#include "browser/webview_lifecycle.h"

namespace remotekit::browser {
NavigationCoordinator::NavigationCoordinator(WebView& owner) : owner_(owner) {}
NavigationCoordinator::~NavigationCoordinator() = default;
Result<std::string> NavigationCoordinator::ExportNavigation() const {
  if (owner_.lifecycle_->lifecycle_request_ || owner_.lifecycle_->lifecycle_uncertain_)
    return {{}, Fail(ErrorCode::kBusy, "Navigation state is transitioning or uncertain")};
  const auto* model = owner_.model_->FindWebView(owner_.session_, owner_.view_);
  if (!model)
    return {{}, Fail(ErrorCode::kNotFound, "WebView model missing")};
  Result<std::string> payload;
  if (owner_.contents()) {
    auto captured = CaptureNavigationState(*owner_.contents());
    if (!captured)
      return {{}, captured.status};
    payload = ExportNavigationState(captured.value);
  } else {
    if (!owner_.lifecycle_->navigation_state_)
      return {{}, Fail(ErrorCode::kNotFound, "No saved navigation state")};
    payload = ExportNavigationState(*owner_.lifecycle_->navigation_state_);
  }
  if (!payload)
    return payload;
  base::Pickle envelope;
  envelope.WriteString(kNavigationOwnerMagic);
  envelope.WriteInt(2);
  envelope.WriteUInt64(owner_.session_);
  envelope.WriteUInt64(model->profile);
  envelope.WriteString(kNavigationRevision);
  envelope.WriteString(payload.value);
  if (envelope.AsBytes().size() > kMaxOwnedNavigationBytes)
    return {{}, Fail(ErrorCode::kLimitExceeded, "Owned navigation snapshot exceeds size limit")};
  return {std::string(envelope.AsStringView()), {}};
}
Status NavigationCoordinator::ImportNavigation(std::string_view bytes) {
  const auto* model = owner_.model_->FindWebView(owner_.session_, owner_.view_);
  if (owner_.contents() || owner_.lifecycle_->lifecycle_request_ || !model ||
      model->actual != Residency::unloaded)
    return Fail(ErrorCode::kConflict, "Navigation import requires an unloaded WebView");
  if (bytes.size() < sizeof(std::uint32_t) || bytes.size() > kMaxOwnedNavigationBytes)
    return Fail(ErrorCode::kInvalidRequest, "Invalid owned navigation size");
  auto input = base::PickleIterator::WithData(base::as_byte_span(bytes));
  if (input.RemainingBytes() != bytes.size() - sizeof(std::uint32_t))
    return Fail(ErrorCode::kInvalidRequest, "Invalid owned navigation header");
  std::string magic, revision, payload;
  int schema = 0;
  std::uint64_t owner_session = 0, owner_profile = 0;
  if (!input.ReadString(&magic) || magic != kNavigationOwnerMagic || !input.ReadInt(&schema) ||
      schema != 2 || !input.ReadUInt64(&owner_session) || !input.ReadUInt64(&owner_profile) ||
      !input.ReadString(&revision) || revision != kNavigationRevision)
    return Fail(ErrorCode::kInvalidRequest,
                "Unsupported owned navigation schema or Chromium revision");
  if (owner_session != owner_.session_ || owner_profile != model->profile)
    return Fail(ErrorCode::kConflict, "Navigation snapshot belongs to another Session/Profile");
  if (!input.ReadString(&payload) || !input.ReachedEnd())
    return Fail(ErrorCode::kInvalidRequest, "Invalid owned navigation payload length");
  auto imported = ImportNavigationState(payload, owner_.context_);
  if (!imported)
    return imported.status;
  owner_.lifecycle_->navigation_state_ =
      std::make_unique<NavigationState>(std::move(imported.value));
  return {};
}
Status NavigationCoordinator::Navigate(const GURL& url,
                                       std::optional<NavigationOperations::Identity> operation) {
  if (!url.is_valid())
    return Fail(ErrorCode::kInvalidRequest, "Invalid navigation URL");
  return RunNavigation("navigate", url, operation);
}
Status NavigationCoordinator::NavigationCommand(
    const std::string& action,
    std::optional<NavigationOperations::Identity> operation) {
  if (action != "back" && action != "forward" && action != "reload" && action != "stop")
    return Fail(ErrorCode::kInvalidRequest, "Invalid navigation action");
  return RunNavigation(action, GURL(), std::move(operation));
}
std::optional<Status> NavigationCoordinator::ExistingNavigationOperation(
    const GURL& url,
    const std::optional<NavigationOperations::Identity>& operation) {
  if (!operation)
    return std::nullopt;
  const auto result = navigation_operations_.Check(*operation, "navigate\n" + url.spec());
  using Acceptance = NavigationOperations::Acceptance;
  if (result == Acceptance::fresh)
    return std::nullopt;
  if (result == Acceptance::duplicate) {
    const auto* record = navigation_operations_.Find(*operation);
    return record->admitted ? Status{} : Status{record->error_code, record->error};
  }
  if (result == Acceptance::stale)
    return Fail(ErrorCode::kConflict, "stale_navigation_operation");
  if (result == Acceptance::full)
    return Fail(ErrorCode::kBusy, "navigation_operation_capacity");
  return Fail(ErrorCode::kInvalidRequest, "navigation_operation_conflict");
}
NavigationOperations NavigationCoordinator::ReleaseNavigationOperations() {
  navigation_operations_.Supersede();
  navigation_handles_.clear();
  navigation_operation_timer_.Stop();
  return std::move(navigation_operations_);
}
void NavigationCoordinator::RestoreNavigationOperations(NavigationOperations operations) {
  navigation_operations_ = std::move(operations);
}
Status NavigationCoordinator::AcknowledgeNavigation(
    const NavigationOperations::Identity& identity) {
  return navigation_operations_.Ack(identity)
             ? Status{}
             : Fail(ErrorCode::kBusy, "Navigation operation pending");
}
base::ListValue NavigationCoordinator::NavigationOperationSnapshot() const {
  base::ListValue result;
  for (const auto& [key, record] : navigation_operations_.records()) {
    base::DictValue value;
    value.Set("operationId", record.identity.id);
    value.Set("operationGeneration", record.identity.generation);
    value.Set("operationSequence", base::NumberToString(record.identity.sequence));
    value.Set("state", record.state);
    if (record.terminal()) {
      value.Set("documentCommitted", record.document_committed);
      value.Set("isErrorPage", record.is_error_page);
    }
    if (record.navigation_id)
      value.Set("navigationId", base::NumberToString(record.navigation_id));
    if (!record.url.empty())
      value.Set("url", record.url);
    if (!record.error.empty())
      value.Set("error", record.error);
    result.Append(std::move(value));
  }
  return result;
}
Status NavigationCoordinator::RunNavigation(
    const std::string& action,
    const GURL& url,
    std::optional<NavigationOperations::Identity> identity) {
  NavigationOperations::Record* operation = nullptr;
  if (identity) {
    const auto accepted = navigation_operations_.Accept(*identity, action + "\n" + url.spec());
    using Acceptance = NavigationOperations::Acceptance;
    if (accepted == Acceptance::duplicate) {
      const auto* original = navigation_operations_.Find(*identity);
      return original->admitted ? Status{} : Status{original->error_code, original->error};
    }
    if (accepted == Acceptance::full)
      return Fail(ErrorCode::kBusy, "navigation_operation_capacity");
    if (accepted == Acceptance::stale)
      return Fail(ErrorCode::kConflict, "stale_navigation_operation");
    if (accepted != Acceptance::fresh)
      return Fail(ErrorCode::kInvalidRequest, "navigation_operation_conflict");
    operation = navigation_operations_.Find(*identity);
    operation->url = SignInNavigationUrl(url);
  }
  const auto* model = owner_.model_->FindWebView(owner_.session_, owner_.view_);
  if (owner_.lifecycle_->lifecycle_uncertain_ || !owner_.contents() || !model ||
      model->actual != Residency::live || model->pending) {
    if (operation) {
      operation->error_code = ErrorCode::kConflict;
      navigation_operations_.Finish(*operation, "failed", "view_unavailable");
    }
    return Fail(ErrorCode::kConflict, "WebView cannot navigate in this state");
  }
  auto& controller = owner_.contents()->GetController();
  const char* invalid = nullptr;
  if (action == "back" && !controller.CanGoBack())
    invalid = "no_back_entry";
  if (action == "forward" && !controller.CanGoForward())
    invalid = "no_forward_entry";
  if (invalid) {
    if (operation) {
      operation->error_code = ErrorCode::kConflict;
      navigation_operations_.Finish(*operation, "failed", invalid);
    }
    return Fail(ErrorCode::kConflict, invalid);
  }
  if (action == "navigate" && owner_.sign_in_ &&
      !(url.SchemeIs("remotekit-signin") && url.path() == "/done")) {
    owner_.sign_in_->Reset();
    owner_.sign_in_->Attach(owner_.contents());
  }
  if (operation)
    operation->admitted = true;
  if (action == "stop") {
    for (const auto& [key, record] : navigation_operations_.records()) {
      if (operation == &record)
        continue;
      if (auto* current = navigation_operations_.Find(record.identity))
        navigation_operations_.Finish(*current, "cancelled", "stopped");
    }
    owner_.contents()->Stop();
    if (operation)
      navigation_operations_.Finish(*operation, "committed");
    return {};
  }
  // A command owns only handles created by this controller call. Subsequent
  // renderer/JS navigations never inherit its product identity.
  navigation_operations_.Supersede(identity ? &*identity : nullptr);
  issuing_navigation_ = identity;
  std::vector<base::WeakPtr<content::NavigationHandle>> handles;
  bool no_navigation = false;
  bool cancelled_during_start = false;
  bool waiting_for_repost = false;
  if (action == "navigate") {
    content::NavigationController::LoadURLParams params(url);
    params.override_user_agent = content::NavigationController::UA_OVERRIDE_FALSE;
    auto result = controller.LoadURLWithParamsForResult(params);
    if (result.has_value())
      handles.push_back(result.value());
    else {
      no_navigation = true;
      cancelled_during_start =
          result.error() == content::NavigationNotStartedReason::kCancelledDuringStart;
    }
  } else if (action == "back") {
    handles = controller.GoBack();
  } else if (action == "forward") {
    handles = controller.GoForward();
  } else {
    auto* requests = PageRequests::ForContents(owner_.contents());
    if (requests)
      requests->SetRepostHandler(
          base::BindOnce(&NavigationCoordinator::ReplyToRepost, weak_factory_.GetWeakPtr(),
                         owner_.contents()->GetPrimaryMainFrame()->GetWeakDocumentPtr(), identity));
    controller.Reload(content::ReloadType::NORMAL, true);
    if (requests) {
      waiting_for_repost = requests->HasPendingRepost();
      requests->SetRepostHandler({});
    }
    if (auto handle = PendingReloadNavigation())
      handles.push_back(handle);
  }
  if (waiting_for_repost) {
    issuing_navigation_.reset();
    return {};
  }
  FinishNavigationCollection(operation, handles, no_navigation, cancelled_during_start);
  return {};
}
base::WeakPtr<content::NavigationHandle> NavigationCoordinator::PendingReloadNavigation() const {
  auto* request = static_cast<content::WebContentsImpl*>(owner_.contents())
                      ->GetPrimaryFrameTree()
                      .root()
                      ->navigation_request();
  if (request && request->GetReloadType() != content::ReloadType::NONE)
    return request->GetWeakPtr();
  return {};
}
void NavigationCoordinator::ReplyToRepost(content::WeakDocumentPtr document,
                                          std::optional<NavigationOperations::Identity> identity,
                                          bool accept) {
  auto* operation = identity ? navigation_operations_.Find(*identity) : nullptr;
  auto* contents = owner_.contents();
  if (!contents)
    return;
  if (!accept || document.AsRenderFrameHostIfValid() != contents->GetPrimaryMainFrame() ||
      (identity && (!operation || operation->terminal()))) {
    contents->GetController().CancelPendingReload();
    if (operation)
      navigation_operations_.Finish(*operation, "cancelled", "repost_cancelled");
    return;
  }
  issuing_navigation_ = identity;
  contents->GetController().ContinuePendingReload();
  std::vector<base::WeakPtr<content::NavigationHandle>> handles;
  if (auto handle = PendingReloadNavigation())
    handles.push_back(handle);
  FinishNavigationCollection(operation, handles);
}
void NavigationCoordinator::FinishNavigationCollection(
    NavigationOperations::Record* operation,
    const std::vector<base::WeakPtr<content::NavigationHandle>>& handles,
    bool no_navigation,
    bool cancelled_during_start) {
  for (const auto& handle : handles) {
    if (!handle)
      continue;
    BindNavigation(handle.get(), false);
    navigation_handles_[handle->GetNavigationId()] = handle;
  }
  issuing_navigation_.reset();
  if (operation) {
    navigation_operations_.EndCollection(*operation);
    if (!operation->terminal() && operation->handles.empty())
      navigation_operations_.Finish(*operation, cancelled_during_start ? "cancelled" : "failed",
                                    cancelled_during_start ? "navigation_cancelled_during_start"
                                    : no_navigation        ? "navigation_not_started"
                                                           : "no_navigation_created");
  }
  if (!navigation_handles_.empty() && !navigation_operation_timer_.IsRunning())
    navigation_operation_timer_.Start(FROM_HERE, base::Milliseconds(50), this,
                                      &NavigationCoordinator::PollNavigationOperations);
}
void NavigationCoordinator::BindNavigation(content::NavigationHandle* navigation, bool started) {
  auto* record = navigation_operations_.ByNavigation(navigation->GetNavigationId());
  if (!record && issuing_navigation_ && !navigation->IsRendererInitiated()) {
    record = navigation_operations_.Find(*issuing_navigation_);
    if (record && record->terminal())
      record = nullptr;
  }
  if (!record)
    return;
  navigation_operations_.Bind(*record, navigation->GetNavigationId(),
                              navigation->IsInPrimaryMainFrame(), started,
                              SignInNavigationUrl(navigation->GetURL()));
}
void NavigationCoordinator::PollNavigationOperations() {
  for (auto it = navigation_handles_.begin(); it != navigation_handles_.end();) {
    auto* record = navigation_operations_.ByNavigation(it->first);
    if (!record || !it->second) {
      // Chromium explicitly permits a pre-start handle to disappear without
      // DidFinishNavigation. A committed handle has already been made terminal
      // in DidFinishNavigation before its weak pointer expires.
      if (record)
        navigation_operations_.Complete(*record, it->first, "cancelled",
                                        "navigation_destroyed_before_finish");
      it = navigation_handles_.erase(it);
    } else
      ++it;
  }
  if (navigation_handles_.empty())
    navigation_operation_timer_.Stop();
}
void NavigationCoordinator::BeforeUnloadDialogCancelled() {
  PollNavigationOperations();
}
void NavigationCoordinator::DidRedirectNavigation(content::NavigationHandle* navigation) {
  BindNavigation(navigation, false);
}
void NavigationCoordinator::NavigationEntryCommitted(const content::LoadCommittedDetails&) {
  ++navigation_revision_;
}
void NavigationCoordinator::NavigationEntryChanged(const content::EntryChangedDetails&) {
  ++navigation_revision_;
}
void NavigationCoordinator::NavigationListPruned(const content::PrunedDetails&) {
  ++navigation_revision_;
}
void NavigationCoordinator::DidStartNavigation(content::NavigationHandle* navigation) {
  BindNavigation(navigation, true);
}
void NavigationCoordinator::DidFinishNavigation(content::NavigationHandle* navigation) {
  if (auto* operation = navigation_operations_.ByNavigation(navigation->GetNavigationId())) {
    if (navigation->IsInPrimaryMainFrame())
      operation->url = SignInNavigationUrl(navigation->GetURL());
    if (navigation->HasCommitted() && !navigation->IsErrorPage() &&
        navigation->GetNetErrorCode() == net::OK)
      navigation_operations_.Complete(*operation, navigation->GetNavigationId(), "committed", {},
                                      navigation->HasCommitted(), navigation->IsErrorPage());
    else if (navigation->GetNetErrorCode() == net::ERR_ABORTED)
      navigation_operations_.Complete(*operation, navigation->GetNavigationId(), "cancelled",
                                      "navigation_aborted", navigation->HasCommitted(),
                                      navigation->IsErrorPage());
    else
      navigation_operations_.Complete(*operation, navigation->GetNavigationId(), "failed",
                                      navigation->GetNetErrorCode() == net::OK
                                          ? "navigation_not_committed"
                                          : net::ErrorToShortString(navigation->GetNetErrorCode()),
                                      navigation->HasCommitted(), navigation->IsErrorPage());
  }
  navigation_handles_.erase(navigation->GetNavigationId());
}
void NavigationCoordinator::PrimaryMainFrameRenderProcessGone() {
  for (const auto& [key, record] : navigation_operations_.records())
    if (auto* operation = navigation_operations_.Find(record.identity))
      navigation_operations_.Finish(*operation, "failed", "renderer_exited");
  navigation_handles_.clear();
  navigation_operation_timer_.Stop();
}
}  // namespace remotekit::browser
