#ifndef REMOTEKIT_BROWSER_WEBVIEW_H_
#define REMOTEKIT_BROWSER_WEBVIEW_H_

#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <string_view>

#include "base/memory/weak_ptr.h"
#include "base/scoped_observation.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "base/values.h"
#include "browser/navigation_operations.h"
#include "content/browser/renderer_host/text_input_manager.h"  // nogncheck
#include "content/public/browser/devtools_agent_host_observer.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_contents.h"
#include "remotekit/browser/view_model.h"
#include "protocol/shared_render_slots.h"
#include "third_party/blink/public/common/tokens/tokens.h"
#include "ui/gfx/geometry/point_f.h"
#include "url/gurl.h"

namespace content {
class BrowserContext;
class WebContents;
class RenderWidgetHostImpl;
class RenderFrameHostImpl;
class RenderViewHostImpl;
class RenderWidgetHostViewBase;
}  // namespace content
namespace blink {
class WebTouchEvent;
}
namespace remotekit::browser {
class WebViewExecution;
class DeviceConfiguration;
class NavigationCoordinator;
class InputController;
class TouchController;
class LifecycleCoordinator;
class NavigationState;
class OffscreenHost;
class ClientGestureBridge;
enum class ClientTouchAckState;

// UI-sequence-only execution adapter. BrowserContext and ViewModel outlive this.
// Unload restore retains complete committed history/PageState and same-process
// sessionStorage namespaces. Discard restore retains the same controller.
// Live DOM/JS heaps and cross-browser sessionStorage recovery are not preserved.
// Input positions/deltas are root-widget DIPs; modifier bits use WebInputEvent.
// Mouse button: 0 none, 1 left, 2 middle, 3 right, 4 back, 5 forward.
// Touch points describe changed contacts; unchanged active contacts are retained.
class WebView final : public content::WebContentsObserver,
                      public content::DevToolsAgentHostObserver,
                      public content::TextInputManager::Observer {
 public:
  using Completion = std::function<void(Status)>;
  WebView(content::BrowserContext*,
          ViewModel*,
          SessionId,
          WebViewId,
          std::unique_ptr<content::WebContents> adopted = {});
  ~WebView() override;
  WebView(const WebView&) = delete;
  WebView& operator=(const WebView&) = delete;

  content::WebContents* contents() const;
  OffscreenHost* offscreen_host() const;
  SessionId session_id() const { return session_; }
  WebViewId view_id() const { return view_; }
  Status Navigate(const GURL&,
                  std::optional<NavigationOperations::Identity> operation = std::nullopt);
  Status NavigationCommand(const std::string& action,
                           std::optional<NavigationOperations::Identity> operation);
  Status AcknowledgeNavigation(const NavigationOperations::Identity&);
  base::ListValue NavigationOperationSnapshot() const;
  std::optional<Status> ExistingNavigationOperation(
      const GURL&,
      const std::optional<NavigationOperations::Identity>& operation);
  NavigationOperations ReleaseNavigationOperations();
  void RestoreNavigationOperations(NavigationOperations operations);
  Status CanShow() const;
  Status SetVisible(bool);
  Status Focus(bool);
  void ConfigureDevice(int width, int height, float scale = 1);
  // Keep page DPR applied as render views and backing hosts change.
  void RefreshBackingScale();
  void SetRenderDemand(bool enabled);
  void InvalidateLayoutInput(bool remains_visible);
  SharedAtlasTextInput TextInputState();
  Status DispatchInput(const InputEvent&, bool* admitted = nullptr);
  // Acceptance/processing status, never a renderer/JavaScript execution ACK.
  // A first touch start resolves its OOPIF target asynchronously. A new touch
  // sequence supersedes it; other input retries BUSY during target resolution.
  Status TouchInjectionStatus() const;
  bool TouchProcessingPending() const;
  void RefreshClientTouchOwner();
  // UI-sequence diagnostic snapshot; absent fields mean no current native view
  // or submitted frame. Reads cached state without requesting frame reports.
  base::DictValue CompositorDiagnostics() const;
  bool lifecycle_uncertain() const;
  // Opaque navigation-only persistence, no external file I/O. Import requires
  // an unloaded adapter and carries no cross-process sessionStorage contents.
  Result<std::string> ExportNavigation() const;
  std::uint64_t navigation_revision() const;
  Status ImportNavigation(std::string_view);
  // Return value reports whether a request was accepted. Completion runs once
  // for accepted operations (possibly synchronously). Rejected requests never
  // invoke it. Renderer ack/poll and navigation completion have a 10s bound.
  // A timeout leaves browser state uncertain: only unload is then allowed.
  Status RequestLifecycle(Lifecycle, Completion = {}, bool recover_uncertain = false);
  Status CanRecoverLifecycle() const;
  // Read-only eligibility. Execution repeats this guard on the UI sequence.
  Status CanDiscard() const;

 private:
  friend class WebViewExecution;
  friend class DeviceConfiguration;
  friend class NavigationCoordinator;
  friend class InputController;
  friend class TouchController;
  friend class LifecycleCoordinator;
  void OnUpdateTextInputStateCalled(content::TextInputManager*,
                                    content::RenderWidgetHostViewBase*,
                                    bool) override;
  void DevToolsAgentHostAttached(content::DevToolsAgentHost*) override;
  void DidFinishNavigation(content::NavigationHandle*) override;
  void NavigationEntryCommitted(const content::LoadCommittedDetails&) override;
  void NavigationEntryChanged(const content::EntryChangedDetails&) override;
  void NavigationListPruned(const content::PrunedDetails&) override;
  void DidStartNavigation(content::NavigationHandle*) override;
  void DidRedirectNavigation(content::NavigationHandle*) override;
  void BeforeUnloadDialogCancelled() override;
  void ReadyToCommitNavigation(content::NavigationHandle*) override;
  void RenderViewReady() override;
  void PrimaryMainFrameRenderProcessGone(base::TerminationStatus) override;
  void RenderFrameDeleted(content::RenderFrameHost*) override;
  void RenderFrameHostChanged(content::RenderFrameHost*, content::RenderFrameHost*) override;

  content::BrowserContext* context_;
  ViewModel* model_;
  SessionId session_;
  WebViewId view_;

  std::unique_ptr<WebViewExecution> execution_;
  std::unique_ptr<DeviceConfiguration> device_;
  std::unique_ptr<NavigationCoordinator> navigation_;
  std::unique_ptr<InputController> input_;
  std::unique_ptr<TouchController> touch_;
  std::unique_ptr<LifecycleCoordinator> lifecycle_;
};
}  // namespace remotekit::browser
#endif
