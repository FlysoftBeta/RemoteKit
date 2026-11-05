#pragma once
#include "browser/webview.h"

namespace remotekit::browser {
class TouchController {
 public:
  using Completion = WebView::Completion;
  explicit TouchController(WebView& owner);
  ~TouchController();
  bool AwaitingHitTest() const { return owner_state_ == OwnerState::kAwaitingHitTest; }
  bool OwnershipUnconfirmed() const { return owner_state_ == OwnerState::kUnconfirmed; }
  bool AdmissionPending() const { return AwaitingHitTest() || touch_cleanup_pending_; }
  std::optional<Status> PrepareInput(const InputEvent&);
  bool StartsNewSequence(const InputEvent&) const;
  Status SupersedeClientTouch();
  Status Momentum(const GestureInput&);
  Status BuildTouchState(const TouchInput& input,
                         bool new_sequence,
                         std::map<std::uint32_t, TouchPoint>* next) const;
  Status TouchInjectionStatus() const;
  void RefreshClientTouchOwner();
  void DevToolsAgentHostAttached(content::DevToolsAgentHost* host);
  bool HasDevToolsConflict() const;
  bool TouchTargetAlive() const;
  void CancelTouches(bool deliver);
  void ResetExecution();
  void OnClientTouchProcessed(std::uint64_t epoch,
                              InputToken token,
                              const std::string& sequence,
                              ClientTouchAckState ack,
                              bool terminal,
                              bool drained);
  void FinishTouchCleanup(std::uint64_t expected);
  Status PrepareTouchClock(const TouchInput& touch);
  Status DispatchTouches(const TouchInput& touch, const InputToken& token);
  void OnTouchTarget(std::uint64_t epoch,
                     InputToken token,
                     TouchInput touch,
                     base::WeakPtr<content::RenderWidgetHostViewBase> target,
                     std::optional<gfx::PointF> transformed);
  Status InjectTouches(const TouchInput& touch);

 private:
  friend class WebView;
  friend class WebViewExecution;
  friend class DeviceConfiguration;
  friend class NavigationCoordinator;
  friend class InputController;
  friend class LifecycleCoordinator;
  enum class OwnerState {
    kIdle,
    kAwaitingHitTest,
    kActive,
    kTerminalPending,
    kProcessed,
    kInvalidated,
    kUnconfirmed
  };
  OwnerState owner_state_ = OwnerState::kIdle;
  WebView& owner_;
  std::map<std::uint32_t, TouchPoint> touches_;
  std::optional<TouchInput::Clock> touch_clock_;
  base::TimeTicks touch_clock_origin_;
  std::uint64_t touch_source_gestures_{}, touch_fallback_gestures_{}, touch_clock_rejected_{},
      touch_cancelled_{}, touch_samples_{};
  double touch_last_dispatch_wall_ms_{}, touch_last_source_age_ms_{};
  scoped_refptr<ClientGestureBridge> client_gesture_bridge_;
  std::vector<scoped_refptr<ClientGestureBridge>> draining_gesture_bridges_;
  std::optional<InputToken> client_touch_token_;
  std::string client_touch_sequence_;
  bool client_touch_ack_mismatch_{};
  base::WeakPtr<content::RenderWidgetHostViewBase> touch_target_view_;
  base::WeakPtr<content::RenderFrameHostImpl> touch_target_frame_;
  std::optional<blink::DocumentToken> touch_target_document_;
  std::map<std::uint32_t, int> touch_pointer_ids_;
  std::uint64_t touch_epoch_{};
  std::uint64_t touch_ack_epoch_{};
  std::size_t touch_pending_callbacks_{};
  bool touch_cleanup_pending_{false};
  double touch_root_offset_x_{}, touch_root_offset_y_{};
  Status touch_status_;
  base::OneShotTimer touch_hit_test_timer_;
  base::WeakPtrFactory<TouchController> weak_factory_{this};
};
}  // namespace remotekit::browser
