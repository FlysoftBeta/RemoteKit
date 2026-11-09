#include "browser/webview.h"
#include "browser/signin.h"
#include "browser/webview_internal.h"
#include "browser/webview_execution.h"
#include "browser/device_configuration.h"
#include "browser/webview_navigation.h"
#include "browser/webview_input.h"
#include "browser/webview_touch.h"
#include "browser/webview_lifecycle.h"

namespace remotekit::browser {
WebView::WebView(content::BrowserContext* context,
                 ViewModel* view_model,
                 SessionId session,
                 WebViewId view,
                 std::unique_ptr<content::WebContents> adopted,
                 std::string sign_in)
    : context_(context),
      model_(view_model),
      session_(session),
      view_(view),
      sign_in_(sign_in.empty() ? nullptr : std::make_unique<SignIn>(std::move(sign_in), view)),
      execution_(std::make_unique<WebViewExecution>(*this)),
      device_(std::make_unique<DeviceConfiguration>(*this)),
      navigation_(std::make_unique<NavigationCoordinator>(*this)),
      input_(std::make_unique<InputController>(*this)),
      touch_(std::make_unique<TouchController>(*this)),
      lifecycle_(std::make_unique<LifecycleCoordinator>(*this)) {
  CHECK(context_);
  CHECK(model_);
  content::DevToolsAgentHost::AddObserver(this);
  CHECK(model_->FindWebView(session_, view_));
  const auto* model = model_->FindWebView(session_, view_);
  if (model->actual == Residency::live)
    execution_->CreateContents(std::move(adopted));
}
WebView::~WebView() {
  content::DevToolsAgentHost::RemoveObserver(this);
  lifecycle_->lifecycle_timer_.Stop();
  navigation_->navigation_operation_timer_.Stop();
  navigation_->weak_factory_.InvalidateWeakPtrs();
  touch_->weak_factory_.InvalidateWeakPtrs();
  lifecycle_->weak_factory_.InvalidateWeakPtrs();

  if (auto* focused = input_->FocusedWidget())
    input_->PrepareKeyboardTarget(focused);
  input_->ReleaseKeyboard(false, true);
  input_->ReleasePointer(true);
  Observe(nullptr);
  execution_->DropContents();
  auto callback = std::move(lifecycle_->completion_);
  if (lifecycle_->lifecycle_request_)
    model_->CompleteLifecycle(session_, *lifecycle_->lifecycle_request_, false);
  model_->InvalidateInstance(session_, view_);
  if (callback)
    callback(Fail(ErrorCode::kOutcomeUnknown, "WebView adapter destroyed"));
}
void WebView::SetSessionStorageShouldPersist(bool persist) {
  if (contents()) {
    for (const auto& [config, handle] : contents()->GetController().GetSessionStorageNamespaceMap())
      handle->SetShouldPersist(persist);
  }
  if (lifecycle_->navigation_state_)
    lifecycle_->navigation_state_->SetSessionStorageShouldPersist(persist);
}
Status WebView::Navigate(const GURL& url, std::optional<NavigationOperations::Identity> operation) {
  return navigation_->Navigate(url, operation);
}
Status WebView::NavigationCommand(const std::string& action,
                                  std::optional<NavigationOperations::Identity> operation) {
  return navigation_->NavigationCommand(action, std::move(operation));
}
Status WebView::AcknowledgeNavigation(const NavigationOperations::Identity& identity) {
  return navigation_->AcknowledgeNavigation(identity);
}
base::ListValue WebView::NavigationOperationSnapshot() const {
  return navigation_->NavigationOperationSnapshot();
}
std::optional<Status> WebView::ExistingNavigationOperation(
    const GURL& url,
    const std::optional<NavigationOperations::Identity>& operation) {
  return navigation_->ExistingNavigationOperation(url, operation);
}
NavigationOperations WebView::ReleaseNavigationOperations() {
  return navigation_->ReleaseNavigationOperations();
}
void WebView::RestoreNavigationOperations(NavigationOperations operations) {
  return navigation_->RestoreNavigationOperations(std::move(operations));
}
Status WebView::CanShow() const {
  const auto* model = model_->FindWebView(session_, view_);
  if (!execution_->contents_ || lifecycle_->lifecycle_uncertain_ || !model ||
      model->actual != Residency::live || model->pending)
    return {ErrorCode::kConflict, "Restore must complete before showing the WebView"};
  return {};
}
Status WebView::SetVisible(bool visible) {
  return execution_->SetVisible(visible);
}
void WebView::ReleaseRemoteInput() {
  input_->ReleaseKeyboard(true, true);
  input_->ReleasePointer(true);
}
Status WebView::Focus(bool focused) {
  return input_->Focus(focused);
}
void WebView::ConfigureDevice(int width, int height, float scale) {
  return device_->ConfigureDevice(width, height, scale);
}
void WebView::RefreshBackingScale() {
  return device_->RefreshBackingScale();
}
void WebView::SetRenderDemand(bool enabled) {
  return execution_->SetRenderDemand(enabled);
}
void WebView::InvalidateLayoutInput(bool remains_visible) {
  return input_->InvalidateLayoutInput(remains_visible);
}
SharedAtlasTextInput WebView::TextInputState() {
  return input_->TextInputState();
}
Status WebView::DispatchInput(const InputEvent& input, bool* admitted) {
  return input_->DispatchInput(input, admitted);
}
Status WebView::TouchInjectionStatus() const {
  return touch_->TouchInjectionStatus();
}
void WebView::RefreshClientTouchOwner() {
  return touch_->RefreshClientTouchOwner();
}
base::DictValue WebView::CompositorDiagnostics() const {
  return execution_->CompositorDiagnostics();
}
Result<std::string> WebView::ExportNavigation() const {
  return navigation_->ExportNavigation();
}
Status WebView::ImportNavigation(std::string_view bytes) {
  return navigation_->ImportNavigation(bytes);
}
Status WebView::RequestLifecycle(Lifecycle action, Completion completion, bool recover_uncertain) {
  return lifecycle_->RequestLifecycle(action, std::move(completion), recover_uncertain);
}
Status WebView::CanRecoverLifecycle() const {
  return lifecycle_->CanRecoverLifecycle();
}
Status WebView::CanDiscard() const {
  return lifecycle_->CanDiscard();
}
void WebView::OnUpdateTextInputStateCalled(content::TextInputManager* manager,
                                           content::RenderWidgetHostViewBase* view,
                                           bool changed) {
  input_->OnUpdateTextInputStateCalled(manager, view, changed);
}
void WebView::DevToolsAgentHostAttached(content::DevToolsAgentHost* host) {
  return touch_->DevToolsAgentHostAttached(host);
}
void WebView::DidFinishNavigation(content::NavigationHandle* navigation) {
  navigation_->DidFinishNavigation(navigation);
  input_->DidFinishNavigation(navigation, lifecycle_->IsDiscardDocument());
  lifecycle_->DidFinishNavigation(navigation);
}
void WebView::NavigationEntryCommitted(const content::LoadCommittedDetails& details) {
  return navigation_->NavigationEntryCommitted(details);
}
void WebView::NavigationEntryChanged(const content::EntryChangedDetails& details) {
  return navigation_->NavigationEntryChanged(details);
}
void WebView::NavigationListPruned(const content::PrunedDetails& details) {
  return navigation_->NavigationListPruned(details);
}
void WebView::DidStartNavigation(content::NavigationHandle* navigation) {
  navigation_->DidStartNavigation(navigation);
  const bool in_primary_page = execution_->IsInPrimaryPage(navigation);
  input_->DidStartNavigation(navigation, in_primary_page);
  lifecycle_->DidStartNavigation(navigation, in_primary_page);
}
void WebView::DidRedirectNavigation(content::NavigationHandle* navigation) {
  return navigation_->DidRedirectNavigation(navigation);
}
void WebView::BeforeUnloadDialogCancelled() {
  return navigation_->BeforeUnloadDialogCancelled();
}
void WebView::ReadyToCommitNavigation(content::NavigationHandle* navigation) {
  if (navigation->IsInPrimaryMainFrame())
    device_->ApplyDevice(navigation->GetRenderFrameHost());
  input_->ReadyToCommitNavigation(navigation);
}
void WebView::RenderFrameDeleted(content::RenderFrameHost* frame) {
  return input_->RenderFrameDeleted(frame);
}
void WebView::RenderFrameHostChanged(content::RenderFrameHost* old_frame,
                                     content::RenderFrameHost* new_frame) {
  device_->ApplyDevice(new_frame);
  input_->RenderFrameHostChanged(old_frame, new_frame);
}
void WebView::PrimaryMainFrameRenderProcessGone(base::TerminationStatus status) {
  input_->PrimaryMainFrameRenderProcessGone();
  if (lifecycle_->PreservesDiscard())
    return;
  navigation_->PrimaryMainFrameRenderProcessGone();
  lifecycle_->PrimaryMainFrameRenderProcessGone(status);
}
void WebView::RenderViewReady() {
  device_->ApplyDevice();
}
content::WebContents* WebView::contents() const {
  return execution_->contents_.get();
}
OffscreenHost* WebView::offscreen_host() const {
  return execution_->offscreen_host_.get();
}
bool WebView::lifecycle_uncertain() const {
  return lifecycle_->lifecycle_uncertain_;
}
std::uint64_t WebView::navigation_revision() const {
  return navigation_->navigation_revision_;
}
bool WebView::TouchProcessingPending() const {
  return touch_->AwaitingHitTest() || touch_->touch_cleanup_pending_ ||
         touch_->touch_pending_callbacks_;
}
}  // namespace remotekit::browser
