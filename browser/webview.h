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
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "base/values.h"
#include "browser/navigation_operations.h"
#include "browser/client_touch_retirement.h"
#include "content/public/browser/devtools_agent_host_observer.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_contents.h"
#include "remotekit/core.hpp"
#include "remotekit/shared_atlas.h"
#include "third_party/blink/public/common/tokens/tokens.h"
#include "ui/gfx/geometry/point_f.h"
#include "url/gurl.h"

namespace content {
class BrowserContext;
class WebContents;
class RenderWidgetHostImpl;
class RenderFrameHostImpl;
class RenderWidgetHostViewBase;
}  // namespace content
namespace blink::web_pref { struct WebPreferences; }
namespace input {
class TouchEmulator;
}
namespace blink {
class WebTouchEvent;
}
namespace remotekit::browser {
class NavigationState;
class OffscreenHost;
class ClientGestureBridge;

// UI-sequence-only execution adapter. BrowserContext and Endpoint outlive this.
// Unload restore retains complete committed history/PageState and same-process
// sessionStorage namespaces. Discard restore retains the same controller.
// Live DOM/JS heaps and cross-browser sessionStorage recovery are not preserved.
// Input positions/deltas are root-widget DIPs; modifier bits use WebInputEvent.
// Mouse button: 0 none, 1 left, 2 middle, 3 right, 4 back, 5 forward.
// Touch points describe changed contacts; unchanged active contacts are retained.
class WebView final : public content::WebContentsObserver,
                      public content::DevToolsAgentHostObserver {
 public:
  using Completion = std::function<void(Status)>;
  WebView(content::BrowserContext*, Endpoint*, SessionId, WebViewId,
          bool offscreen_host = false, std::unique_ptr<content::WebContents> adopted = {});
  ~WebView() override;
  WebView(const WebView&) = delete;
  WebView& operator=(const WebView&) = delete;

  content::WebContents* contents() const { return contents_.get(); }
  OffscreenHost* offscreen_host() const { return offscreen_host_.get(); }
  SessionId session_id() const { return session_; }
  WebViewId view_id() const { return view_; }
  Status Navigate(const GURL&, const base::DictValue* operation = nullptr);
  Status NavigationCommand(const base::DictValue&);
  Status AcknowledgeNavigation(const base::DictValue&);
  base::ListValue NavigationOperationSnapshot() const;
  std::optional<Status> ExistingNavigationOperation(const GURL&, const base::DictValue&);
  NavigationOperations ReleaseNavigationOperations();
  void RestoreNavigationOperations(NavigationOperations operations);
  Status SetVisible(bool);
  Status Focus(bool);
  void SetNativeFocusEnabled(bool enabled);
  void ConfigureDevice(int width, int height, bool tablet, float scale = 1,
                       bool match_page_backing = false);
  // Service rendering follows page DPR; demo rendering follows native DPI.
  // Also called from the existing output timer to notice host-DPI changes.
  void RefreshBackingScale();
  void SetRenderDemand(bool enabled, uint32_t fps);
  void InvalidateLayoutInput();
  static void OverridePreferences(content::WebContents*, blink::web_pref::WebPreferences*);
  SharedAtlasTextInput TextInputState() const;
  Status DispatchInput(const InputEvent&);
  // Acceptance/processing status, never a renderer/JavaScript execution ACK.
  // A first touch start resolves its OOPIF target asynchronously. All remote
  // input is busy during that resolution; callers must retry rejected input.
  Status TouchInjectionStatus() const;
  bool TouchProcessingPending() const {
    return touch_hit_test_pending_ || touch_cleanup_pending_ || touch_pending_callbacks_;
  }
  std::string ClientTouchSequence() const;
  void RefreshClientTouchOwner();
  bool ClientTouchRetired(const InputToken& token, const std::string& sequence) const {
    return retired_client_touches_.Contains(token, sequence);
  }
  // UI-sequence diagnostic snapshot; absent fields mean no current native view
  // or submitted frame. Reads cached state without requesting frame reports.
  base::DictValue CompositorDiagnostics() const;
  bool lifecycle_uncertain() const { return lifecycle_uncertain_; }
  // Opaque navigation-only persistence, no external file I/O. Import requires
  // an unloaded adapter and carries no cross-process sessionStorage contents.
  Result<std::string> ExportNavigation() const;
  std::uint64_t navigation_revision() const { return navigation_revision_; }
  Status ImportNavigation(std::string_view);
  // Return value reports whether a request was accepted. Completion runs once
  // for accepted operations (possibly synchronously). Rejected requests never
  // invoke it. Renderer ack/poll and navigation completion have a 10s bound.
  // A timeout leaves browser state uncertain: only unload is then allowed.
  Status RequestLifecycle(Lifecycle, Completion = {});
  // Read-only eligibility. Execution repeats this guard on the UI sequence.
  Status CanDiscard() const;

 private:
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
  void OnWebContentsFocused(content::RenderWidgetHost*) override;
  void OnWebContentsLostFocus(content::RenderWidgetHost*) override;
  void RenderFrameDeleted(content::RenderFrameHost*) override;
  void RenderFrameHostChanged(content::RenderFrameHost*, content::RenderFrameHost*) override;
  void CreateContents(std::unique_ptr<content::WebContents> adopted = {});
  void AttachOffscreenHost();
  void DropContents();
  void ApplyDevice(content::RenderFrameHost* frame = nullptr);
  void ApplyBackingScale(content::RenderWidgetHostViewBase*);
  content::RenderWidgetHostImpl* FocusedWidget() const;
  void CancelTouches(bool deliver);
  bool HasTouchEmulatorConflict() const;
  bool TouchTargetAlive() const;
  Status EnsureTouchEmulator();
  Status DispatchTouches(const TouchInput&, const InputToken&);
  void OnTouchTarget(std::uint64_t,
                     InputToken,
                     TouchInput,
                     base::WeakPtr<content::RenderWidgetHostViewBase>,
                     std::optional<gfx::PointF>);
  Status InjectTouches(const TouchInput&);
  Status PrepareTouchClock(const TouchInput&);
  Status SendTouchEvent(const blink::WebTouchEvent&);
  void OnTouchProcessed(std::uint64_t);
  void OnClientTouchProcessed(bool);
  void FinishTouchCleanup(std::uint64_t);
  void PrepareKeyboardTarget(content::RenderWidgetHostImpl*);
  bool KeyboardTargetAlive() const;
  bool PointerTargetAlive() const;
  void ReleaseKeyboard(bool finish_composition, bool deliver);
  void ReleasePointer(bool deliver);
  void RememberPointerTarget();
  enum class PendingKind { none, freeze, thaw, discard, restore_unloaded, restore_discarded };
  Status FinishLifecycle(bool success, Status);
  Status CheckQuiescent() const;
  bool AllPageViewsAcknowledged(bool frozen) const;
  void PollLifecycle();
  void OnDiscarded(std::uint64_t generation);
  void StartLifecycleTimer();
  Status BuildTouchState(const TouchInput&, std::map<std::uint32_t, TouchPoint>*) const;
  Status RunNavigation(const std::string& action, const GURL&, const base::DictValue*);
  void BindNavigation(content::NavigationHandle*, bool started);
  void PollNavigationOperations();

  content::BrowserContext* context_;
  Endpoint* endpoint_;
  SessionId session_;
  WebViewId view_;
  std::unique_ptr<content::WebContents> contents_;
  std::uint64_t navigation_revision_ = 1;
  NavigationOperations navigation_operations_;
  std::optional<NavigationOperations::Identity> issuing_navigation_;
  std::map<std::int64_t, base::WeakPtr<content::NavigationHandle>> navigation_handles_;
  base::RepeatingTimer navigation_operation_timer_;
  const bool use_offscreen_host_;
  std::unique_ptr<OffscreenHost> offscreen_host_;
  bool render_demand_ = false;
  uint32_t render_fps_ = 60;
  int viewport_width_ = 0, viewport_height_ = 0;
  bool tablet_ = false;
  float device_scale_ = 1;
  bool match_page_backing_ = false;
  float backing_host_scale_ = 0;
  base::WeakPtr<content::RenderWidgetHostViewBase> backing_view_;
  bool visible_{false};
  bool native_focus_enabled_{true};
  std::unique_ptr<NavigationState> navigation_state_;
  std::optional<LifecycleRequest> lifecycle_request_;
  PendingKind pending_kind_{PendingKind::none};
  bool lifecycle_uncertain_{false};
  bool discard_acknowledged_{false};
  std::int64_t restore_navigation_{-1};
  base::TimeTicks lifecycle_deadline_;
  base::RepeatingTimer lifecycle_timer_;
  Completion completion_;
  std::map<std::uint32_t, TouchPoint> touches_;
  std::optional<TouchInput::Clock> touch_clock_;
  base::TimeTicks touch_clock_origin_;
  std::uint64_t touch_source_gestures_{}, touch_fallback_gestures_{}, touch_clock_rejected_{}, touch_cancelled_{}, touch_samples_{};
  double touch_last_dispatch_wall_ms_{}, touch_last_source_age_ms_{};
  // This is the WebContents' shared emulator, not an adapter-owned emulator.
  // Claim it only while disabled, and never change it while CDP is attached.
  base::WeakPtr<input::TouchEmulator> touch_emulator_;
  scoped_refptr<ClientGestureBridge> client_gesture_bridge_;
  ClientTouchRetirement retired_client_touches_;
  std::optional<InputToken> client_touch_token_;
  std::string client_touch_sequence_;
  bool client_touch_mode_{};
  base::WeakPtr<content::RenderWidgetHostViewBase> touch_target_view_;
  base::WeakPtr<content::RenderFrameHostImpl> touch_target_frame_;
  std::optional<blink::DocumentToken> touch_target_document_;
  std::map<std::uint32_t, int> touch_pointer_ids_;
  std::uint64_t touch_epoch_{};
  std::uint64_t touch_ack_epoch_{};
  std::size_t touch_pending_callbacks_{};
  bool touch_hit_test_pending_{false};
  bool touch_emulator_owned_{false};
  bool touch_cleanup_pending_{false};
  bool touch_owner_lost_{false};
  double touch_root_offset_x_{}, touch_root_offset_y_{};
  Status touch_status_;
  base::OneShotTimer touch_hit_test_timer_;
  base::WeakPtr<content::RenderWidgetHostImpl> input_widget_;
  base::WeakPtr<content::RenderFrameHostImpl> input_frame_;
  std::optional<blink::DocumentToken> input_document_;
  std::map<std::uint32_t, KeyInput> pressed_keys_;
  base::WeakPtr<content::RenderWidgetHostImpl> pointer_root_widget_;
  base::WeakPtr<content::RenderWidgetHostViewBase> pointer_root_view_;
  base::WeakPtr<content::RenderFrameHostImpl> pointer_frame_;
  std::optional<blink::DocumentToken> pointer_document_;
  std::set<std::uint8_t> pressed_mouse_buttons_;
  MouseInput last_mouse_;
  std::set<std::int64_t> input_commit_navigations_;
  // Must be last: pending timer/discard callbacks cannot outlive the adapter.
  base::WeakPtrFactory<WebView> weak_factory_{this};
};
}  // namespace remotekit::browser
#endif
