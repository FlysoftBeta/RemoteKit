#pragma once
#include "browser/webview.h"

namespace remotekit::browser {
class LifecycleCoordinator {
 public:
  using Completion = WebView::Completion;
  explicit LifecycleCoordinator(WebView& owner);
  ~LifecycleCoordinator();
  Status CheckQuiescent() const;
  Status CanDiscard() const;
  bool UpdateLifecycleViews(bool frozen);
  void OnLifecycleViewAcknowledged(base::WeakPtr<content::RenderViewHostImpl> host,
                                   std::uint64_t request);
  void StartLifecycleTimer();
  Status CanRecoverLifecycle() const;
  Status CanRequestLifecycle(Lifecycle action, bool recover_uncertain = false) const;
  Status RequestLifecycle(Lifecycle action,
                          Completion completion = {},
                          bool recover_uncertain = false);
  Status FinishLifecycle(bool success, Status status, bool uncertain = true);
  void PollLifecycle();
  void OnDiscarded(std::uint64_t generation);
  void DidStartNavigation(content::NavigationHandle* navigation, bool in_primary_page);
  bool PreservesDiscard() const;
  bool IsDiscardDocument() const;
  void DidFinishNavigation(content::NavigationHandle* navigation);
  void PrimaryMainFrameRenderProcessGone(base::TerminationStatus);

 private:
  friend class WebView;
  friend class WebViewExecution;
  friend class DeviceConfiguration;
  friend class NavigationCoordinator;
  friend class InputController;
  friend class TouchController;
  WebView& owner_;
  struct LifecycleView {
    base::WeakPtr<content::RenderViewHostImpl> host;
    std::uint64_t broadcast_generation;
    std::uint64_t request;
    bool acknowledged = false;
  };
  std::unique_ptr<NavigationState> navigation_state_;
  std::optional<LifecycleRequest> lifecycle_request_;
  enum class ResidencyState {
    kLive,
    kFreezing,
    kFrozen,
    kDiscarding,
    kDiscarded,
    kUnloading,
    kUnloaded,
    kRestoring
  };
  ResidencyState residency_ = ResidencyState::kLive;
  Residency restore_origin_ = Residency::live;
  std::string uncertainty_reason_;
  bool RestoringNavigation() const;
  void SynchronizeResidency();
  bool lifecycle_uncertain_{false};
  bool freeze_cancelled_{false};
  std::uint64_t lifecycle_view_request_ = 0;
  std::map<content::RenderViewHostImpl*, LifecycleView> lifecycle_views_;
  bool discard_acknowledged_{false};
  std::int64_t restore_navigation_{-1};
  base::TimeTicks lifecycle_deadline_;
  base::RepeatingTimer lifecycle_timer_;
  Completion completion_;
  base::WeakPtrFactory<LifecycleCoordinator> weak_factory_{this};
};
}  // namespace remotekit::browser
