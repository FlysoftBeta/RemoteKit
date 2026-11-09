#include "browser/webview_lifecycle.h"
#include "browser/webview_internal.h"
#include "browser/webview_execution.h"
#include "browser/device_configuration.h"
#include "browser/webview_navigation.h"
#include "browser/webview_input.h"
#include "browser/webview_touch.h"

namespace remotekit::browser {
bool LifecycleCoordinator::PreservesDiscard() const {
  const auto* model = owner_.model_->FindWebView(owner_.session_, owner_.view_);
  return (residency_ == ResidencyState::kDiscarding && discard_acknowledged_) ||
         (model && model->actual == Residency::discarded && !lifecycle_request_);
}
bool LifecycleCoordinator::IsDiscardDocument() const {
  const auto* model = owner_.model_->FindWebView(owner_.session_, owner_.view_);
  return residency_ == ResidencyState::kDiscarding ||
         (model && model->actual == Residency::discarded && !lifecycle_request_);
}
LifecycleCoordinator::LifecycleCoordinator(WebView& owner) : owner_(owner) {}
LifecycleCoordinator::~LifecycleCoordinator() = default;
bool LifecycleCoordinator::RestoringNavigation() const {
  return residency_ == ResidencyState::kRestoring && lifecycle_request_ &&
         lifecycle_request_->action == Lifecycle::restore &&
         (restore_origin_ == Residency::discarded || restore_origin_ == Residency::unloaded);
}
void LifecycleCoordinator::SynchronizeResidency() {
  const auto* model = owner_.model_->FindWebView(owner_.session_, owner_.view_);
  if (!model)
    return;
  switch (model->actual) {
    case Residency::live:
      residency_ = ResidencyState::kLive;
      break;
    case Residency::frozen:
      residency_ = ResidencyState::kFrozen;
      break;
    case Residency::discarded:
      residency_ = ResidencyState::kDiscarded;
      break;
    case Residency::unloaded:
      residency_ = ResidencyState::kUnloaded;
      break;
  }
}
Status LifecycleCoordinator::CheckQuiescent() const {
  if (!owner_.contents())
    return Fail(ErrorCode::kConflict, "WebView is unloaded");
  if (owner_.contents()->GetVisibility() != content::Visibility::HIDDEN)
    return Fail(ErrorCode::kConflict, "WebView is visible");
  if (owner_.contents()->IsCurrentlyAudible())
    return Fail(ErrorCode::kConflict, "WebView is playing audio");
  if (owner_.contents()->IsLoading() ||
      owner_.contents()->HasUncommittedNavigationInPrimaryMainFrame() ||
      owner_.contents()->GetController().GetPendingEntry())
    return Fail(ErrorCode::kConflict, "Navigation is in progress");
  if (owner_.contents()->IsCrashed())
    return Fail(ErrorCode::kConflict, "Renderer has crashed");
  if (owner_.contents()->IsBeingDestroyed())
    return Fail(ErrorCode::kConflict, "WebView is being destroyed");
  if (!owner_.contents()->GetPrimaryMainFrame())
    return Fail(ErrorCode::kConflict, "Live main frame required");
  if (owner_.contents()->GetPrimaryMainFrame()->GetSiteInstance()->GetRelatedActiveContentsCount() >
      1)
    return Fail(ErrorCode::kConflict, "Related active WebContents prevents lifecycle transition");
  if (owner_.contents()->IsBeingCaptured() || owner_.contents()->HasPictureInPictureVideo() ||
      owner_.contents()->HasPictureInPictureDocument() || owner_.contents()->IsFullscreen() ||
      owner_.contents()->GetCurrentlyPlayingVideoCount() > 0 ||
      owner_.contents()->HasFileSystemAccessHandles() ||
      !owner_.contents()->GetInnerWebContents().empty())
    return Fail(
        ErrorCode::kConflict,
        "Active capture, media, filesystem, or inner contents prevents lifecycle transition");
  using Capability = content::WebContentsCapabilityType;
  for (auto type :
       {Capability::kUSB, Capability::kBluetoothConnected, Capability::kBluetoothScanning,
        Capability::kHID, Capability::kSerial, Capability::kGeolocation})
    if (owner_.contents()->IsCapabilityActive(type))
      return Fail(ErrorCode::kConflict, "Active device capability prevents lifecycle transition");
  auto* impl = static_cast<content::WebContentsImpl*>(owner_.contents());
  if (impl->GetKeyboardLockWidget() || impl->GetPointerLockWidget())
    return Fail(ErrorCode::kConflict, "Active input lock prevents lifecycle transition");
  for (auto* node : impl->GetPrimaryFrameTree().Nodes())
    if (node->HasNavigation() || node->HasPendingCommitNavigation() ||
        node->HasPendingCrossDocumentNavigation())
      return Fail(ErrorCode::kConflict, "Frame navigation prevents lifecycle transition");
  bool media_stream = false;
  auto* main = owner_.contents()->GetPrimaryMainFrame();
  if (!main || !main->IsRenderFrameLive())
    return Fail(ErrorCode::kConflict, "Live main frame required");
  main->ForEachRenderFrameHost([&](content::RenderFrameHost* frame) {
    auto* frame_impl = static_cast<content::RenderFrameHostImpl*>(frame);
    media_stream |=
        frame_impl->HasMediaStreams(content::RenderFrameHostImpl::kCapturingMediaStream) ||
        frame_impl->HasMediaStreams(content::RenderFrameHostImpl::kPlayingAudioStream);
  });
  return media_stream
             ? Fail(ErrorCode::kConflict, "Active media stream prevents lifecycle transition")
             : Status{};
}
Status LifecycleCoordinator::CanDiscard() const {
  if (lifecycle_request_)
    return Fail(ErrorCode::kBusy, "Lifecycle transition pending");
  if (lifecycle_uncertain_)
    return Fail(ErrorCode::kConflict, "Browser lifecycle state uncertain; unload required");
  const auto* model = owner_.model_->FindWebView(owner_.session_, owner_.view_);
  if (!model)
    return Fail(ErrorCode::kNotFound, "WebView model missing");
  if (model->pending)
    return Fail(ErrorCode::kBusy, "Lifecycle operation pending");
  if (model->actual != Residency::live && model->actual != Residency::frozen)
    return Fail(ErrorCode::kConflict, "Discard requires live or frozen state");
  if (owner_.touch_->touch_cleanup_pending_ ||
      (owner_.touch_->client_gesture_bridge_ &&
       (!owner_.touch_->touches_.empty() || owner_.touch_->touch_pending_callbacks_)))
    return Fail(ErrorCode::kBusy, "Touch cancellation must drain before discard; retry");
  if (owner_.touch_->OwnershipUnconfirmed())
    return Fail(ErrorCode::kConflict, "Touch cleanup uncertain; unload required");
  if (owner_.contents() && owner_.contents()->NeedToFireBeforeUnloadOrUnloadEvents())
    return Fail(ErrorCode::kConflict, "Beforeunload or unload handler prevents discard");
  auto quiet = CheckQuiescent();
  if (!quiet)
    return quiet;
  if (!base::FeatureList::IsEnabled(::features::kWebContentsDiscard))
    return Fail(ErrorCode::kRejected, "WebContentsDiscard feature is disabled");
  if (owner_.contents()->WasDiscarded())
    return Fail(ErrorCode::kConflict, "WebContents is already marked discarded");
  return CaptureNavigationState(*owner_.contents()).status;
}
bool LifecycleCoordinator::UpdateLifecycleViews(bool frozen) {
  if (!owner_.contents() || owner_.contents()->GetVisibility() != content::Visibility::HIDDEN ||
      !owner_.contents()->GetPrimaryMainFrame() ||
      !owner_.contents()->GetPrimaryMainFrame()->IsRenderFrameLive())
    return false;
  auto* impl = static_cast<content::WebContentsImpl*>(owner_.contents());
  bool all = true;
  const bool draining_freeze = frozen && freeze_cancelled_;
  std::set<content::RenderViewHostImpl*> current;
  // The primary FrameTree includes OOPIF and speculative RVHs. A navigation
  // may replace any of them while a lifecycle request is pending.
  impl->GetPrimaryFrameTree().ForEachRenderViewHost([&](content::RenderViewHostImpl* host) {
    current.insert(host);
    const auto target = lifecycle_views_.find(host);
    const auto generation = host->page_broadcast_generation();
    const bool requested = target != lifecycle_views_.end() && target->second.host &&
                           target->second.broadcast_generation == generation;
    if (!host->IsRenderViewLive()) {
      // A retired renderer has no live state to acknowledge. Clear the local
      // explicit freeze bit on thaw in case this RVH is reused by a new pipe.
      if (!frozen)
        host->SetIsFrozen(false);
      lifecycle_views_.erase(host);
      return;
    }
    if (draining_freeze && !requested) {
      lifecycle_views_.erase(host);
      return;
    }
    auto* manager = host->GetPageLifecycleStateManager();
    const auto& remote = host->GetAssociatedPageBroadcast();
    if (!manager || !remote || !remote.is_connected() || manager->IsInBackForwardCache()) {
      all = false;
      return;
    }
    if (!requested) {
      const auto request = ++lifecycle_view_request_;
      auto weak_host = host->GetWeakPtr();
      lifecycle_views_.insert_or_assign(host, LifecycleView{weak_host, generation, request});
      if (!manager->SetIsFrozenWithAck(
              frozen, base::BindOnce(&LifecycleCoordinator::OnLifecycleViewAcknowledged,
                                     weak_factory_.GetWeakPtr(), std::move(weak_host), request)))
        lifecycle_views_.erase(host);
      all = false;
      return;
    }
    all &= target->second.acknowledged;
  });
  std::erase_if(lifecycle_views_,
                [&](const auto& target) { return !current.contains(target.first); });
  return !current.empty() && all;
}
void LifecycleCoordinator::OnLifecycleViewAcknowledged(
    base::WeakPtr<content::RenderViewHostImpl> host,
    std::uint64_t request) {
  if (!host)
    return;
  const auto target = lifecycle_views_.find(host.get());
  if (target != lifecycle_views_.end() && target->second.request == request &&
      target->second.broadcast_generation == host->page_broadcast_generation())
    target->second.acknowledged = true;
}
void LifecycleCoordinator::StartLifecycleTimer() {
  lifecycle_deadline_ = base::TimeTicks::Now() + base::Seconds(10);
  lifecycle_timer_.Start(
      FROM_HERE, base::Milliseconds(50),
      base::BindRepeating(&LifecycleCoordinator::PollLifecycle, weak_factory_.GetWeakPtr()));
}
Status LifecycleCoordinator::CanRecoverLifecycle() const {
  if (lifecycle_request_ || !lifecycle_uncertain_ || !navigation_state_)
    return Fail(ErrorCode::kConflict, "No stable navigation checkpoint for lifecycle recovery");
  return CheckAutomaticNavigationRestore(*navigation_state_);
}
Status LifecycleCoordinator::RequestLifecycle(Lifecycle action,
                                              Completion completion,
                                              bool recover_uncertain) {
  if (lifecycle_request_)
    return Fail(ErrorCode::kBusy, "Lifecycle transition pending");
  if (lifecycle_uncertain_ && action != Lifecycle::unload)
    return Fail(ErrorCode::kConflict, "Browser lifecycle state uncertain; unload required");
  if (action == Lifecycle::freeze || action == Lifecycle::discard) {
    // Freezing/discarding before the cancel ACK can strand the old sequence.
    // Reject before creating a lifecycle request; callers may retry after drain.
    if (owner_.touch_->client_gesture_bridge_ &&
        (!owner_.touch_->touches_.empty() || owner_.touch_->touch_pending_callbacks_))
      owner_.input_->ReleasePointer(true);
    if (owner_.touch_->touch_cleanup_pending_)
      return Fail(ErrorCode::kBusy, "Touch cancellation must drain before freeze/discard; retry");
    if (owner_.touch_->OwnershipUnconfirmed())
      return Fail(ErrorCode::kConflict, "Touch cleanup uncertain; unload required");
  }
  const auto* model = owner_.model_->FindWebView(owner_.session_, owner_.view_);
  if (!model)
    return Fail(ErrorCode::kNotFound, "WebView model missing");
  if (action == Lifecycle::discard) {
    auto allowed = CanDiscard();
    if (!allowed)
      return allowed;
  }
  const Residency previous = model->actual;
  auto next_state = residency_;
  if (action == Lifecycle::freeze || action == Lifecycle::discard) {
    auto guard = CheckQuiescent();
    if (!guard)
      return guard;
    if (action == Lifecycle::discard) {
      if (!base::FeatureList::IsEnabled(::features::kWebContentsDiscard))
        return Fail(ErrorCode::kRejected, "WebContentsDiscard feature is disabled");
      if (owner_.contents()->WasDiscarded())
        return Fail(ErrorCode::kConflict, "WebContents is already marked discarded");
      next_state = ResidencyState::kDiscarding;
    } else
      next_state = ResidencyState::kFreezing;
  } else if (action == Lifecycle::restore) {
    if (previous == Residency::frozen) {
      if (!owner_.contents() || owner_.contents()->IsBeingDestroyed() ||
          owner_.contents()->IsCrashed() ||
          owner_.contents()->GetVisibility() != content::Visibility::HIDDEN)
        return Fail(ErrorCode::kConflict, "Thaw requires a hidden WebView with an intact renderer");
      next_state = ResidencyState::kRestoring;
    } else if (previous == Residency::discarded) {
      if (!owner_.contents() || !owner_.contents()->WasDiscarded() ||
          !owner_.contents()->GetController().NeedsReload() ||
          owner_.contents()->HasUncommittedNavigationInPrimaryMainFrame() ||
          owner_.contents()->GetController().GetPendingEntry())
        return Fail(ErrorCode::kConflict,
                    "Discard restore requires its idle retained NavigationController");
      auto captured = CaptureNavigationState(*owner_.contents());
      if (!captured)
        return captured.status;
      auto allowed = CheckAutomaticNavigationRestore(captured.value);
      if (!allowed)
        return allowed;
      next_state = ResidencyState::kRestoring;
    } else if (previous == Residency::unloaded) {
      if (!navigation_state_)
        return Fail(ErrorCode::kNotFound, "No saved navigation history is available");
      auto allowed = CheckAutomaticNavigationRestore(*navigation_state_);
      if (!allowed)
        return allowed;
      next_state = ResidencyState::kRestoring;
    }
  } else if (action != Lifecycle::unload)
    return Fail(ErrorCode::kInvalidRequest, "Unknown lifecycle action");
  // Snapshot before modifying the browser/model. A failed discard/freeze can
  // then be safely unloaded using the last stable complete controller state.
  if (recover_uncertain) {
    // The guarded runtime request has checked that the retained checkpoint is
    // automatically restorable before detaching output and page requests.
    if (action != Lifecycle::unload || !lifecycle_uncertain_ || !navigation_state_)
      return Fail(ErrorCode::kConflict, "Lifecycle recovery checkpoint is no longer available");
  } else if (owner_.contents() && (action == Lifecycle::unload || action == Lifecycle::freeze ||
                                   action == Lifecycle::discard)) {
    auto captured = CaptureNavigationState(*owner_.contents());
    if (captured)
      navigation_state_ = std::make_unique<NavigationState>(std::move(captured.value));
    else if (!lifecycle_uncertain_ || !navigation_state_)
      return captured.status;
  }
  auto request = owner_.model_->RequestLifecycle(owner_.session_, owner_.view_, action);
  if (!request)
    return request.status;
  if (auto* focused = owner_.input_->FocusedWidget())
    owner_.input_->PrepareKeyboardTarget(focused);
  owner_.input_->ReleaseKeyboard(action == Lifecycle::freeze, true);
  owner_.input_->ReleasePointer(true);
  if (auto* root = RootWidget(owner_.contents())) {
    root->SetActive(false);
    root->Blur();
  }
  if (action == Lifecycle::unload) {
    residency_ = ResidencyState::kUnloading;
    owner_.Observe(nullptr);
    owner_.execution_->DropContents();
    owner_.touch_->CancelTouches(false);
    owner_.input_->input_commit_navigations_.clear();
    lifecycle_uncertain_ = false;
    auto result = owner_.model_->CompleteLifecycle(owner_.session_, request.value, true);
    SynchronizeResidency();
    uncertainty_reason_.clear();
    if (completion)
      completion(result);
    return {};
  }
  lifecycle_request_ = request.value;
  restore_origin_ = previous;
  residency_ = next_state;
  freeze_cancelled_ = false;
  discard_acknowledged_ = false;
  completion_ = std::move(completion);
  restore_navigation_ = -1;
  StartLifecycleTimer();
  if (residency_ == ResidencyState::kFreezing ||
      (residency_ == ResidencyState::kRestoring && previous == Residency::frozen)) {
    UpdateLifecycleViews(residency_ == ResidencyState::kFreezing);
    return {};
  }
  if (residency_ == ResidencyState::kDiscarding) {
    owner_.contents()->Discard(base::BindOnce(
        &LifecycleCoordinator::OnDiscarded, weak_factory_.GetWeakPtr(), request.value.generation));
    return {};
  }
  if (residency_ == ResidencyState::kRestoring && previous == Residency::discarded) {
    // Keep WebContents, controller history, storage partition, and all browser
    // side controller state. Chromium determines what PageState can restore.
    owner_.contents()->GetController().LoadIfNecessary();
    return {};
  }
  const auto restored = owner_.execution_->RestoreContents(*navigation_state_);
  if (!restored) {
    FinishLifecycle(false, restored);
    return {};
  }
  // DidStartNavigation identifies this controller's selected history restore;
  // actual becomes live only after its non-error main-frame commit.
  owner_.contents()->GetController().LoadIfNecessary();
  return {};
}
Status LifecycleCoordinator::FinishLifecycle(bool success, Status status, bool uncertain) {
  if (!lifecycle_request_)
    return Fail(ErrorCode::kConflict, "No pending lifecycle operation");
  lifecycle_timer_.Stop();
  auto result = owner_.model_->CompleteLifecycle(owner_.session_, *lifecycle_request_, success,
                                                 status.message, status.error);
  lifecycle_request_.reset();
  SynchronizeResidency();
  freeze_cancelled_ = false;
  lifecycle_views_.clear();
  restore_navigation_ = -1;
  discard_acknowledged_ = false;
  auto callback = std::move(completion_);
  if ((!success && uncertain) || !result) {
    lifecycle_uncertain_ = true;
    uncertainty_reason_ = result ? status.message : result.message;
  }
  if (!result)
    status = result;
  PostCompletion(std::move(callback), status);
  return status;
}
void LifecycleCoordinator::PollLifecycle() {
  if (!lifecycle_request_) {
    lifecycle_timer_.Stop();
    return;
  }
  const auto* model = owner_.model_->FindWebView(owner_.session_, owner_.view_);
  if (!model || !model->pending || model->pending->generation != lifecycle_request_->generation) {
    FinishLifecycle(false,
                    Fail(ErrorCode::kConflict, "Lifecycle operation invalidated externally"));
    return;
  }
  if (residency_ == ResidencyState::kDiscarding && discard_acknowledged_) {
    if (!owner_.contents() || !owner_.contents()->WasDiscarded() ||
        !owner_.contents()->GetController().NeedsReload() ||
        owner_.contents()->HasUncommittedNavigationInPrimaryMainFrame() ||
        owner_.contents()->GetController().GetPendingEntry()) {
      FinishLifecycle(false, Fail(ErrorCode::kOutcomeUnknown,
                                  "Discard completion did not retain idle reload state"));
      return;
    }
    FinishLifecycle(true, {});
    return;
  }
  if (base::TimeTicks::Now() >= lifecycle_deadline_) {
    FinishLifecycle(false,
                    Fail(ErrorCode::kOutcomeUnknown,
                         "Lifecycle completion timed out after 10 seconds; unload required"));
    return;
  }
  if (residency_ == ResidencyState::kFreezing) {
    freeze_cancelled_ |= !CheckQuiescent();
    if (!UpdateLifecycleViews(true))
      return;
    if (!freeze_cancelled_) {
      FinishLifecycle(true, {});
      return;
    }
    // The earlier freeze is now confirmed. Keep input gated until this phase's
    // own thaw replies arrive, including any renderer views created meanwhile.
    residency_ = ResidencyState::kRestoring;
    lifecycle_views_.clear();
    StartLifecycleTimer();
    UpdateLifecycleViews(false);
  } else if ((residency_ == ResidencyState::kRestoring && !RestoringNavigation()) &&
             UpdateLifecycleViews(false)) {
    if (lifecycle_request_->action == Lifecycle::freeze)
      FinishLifecycle(false, Fail(ErrorCode::kConflict, "Freeze cancelled when page became active"),
                      false);
    else
      FinishLifecycle(true, {});
  }
}
void LifecycleCoordinator::OnDiscarded(std::uint64_t generation) {
  if (!lifecycle_request_ || lifecycle_request_->generation != generation ||
      residency_ != ResidencyState::kDiscarding)
    return;
  // The closure is invoked after the renderer's discard response (or upstream
  // detects renderer teardown). WasDiscarded alone is only a request-time flag.
  // Defer the user callback to the next poll: Chromium still accesses its RFH
  // after invoking this closure, while user completion may destroy WebContents.
  if (base::TimeTicks::Now() < lifecycle_deadline_)
    discard_acknowledged_ = true;
}
void LifecycleCoordinator::DidStartNavigation(content::NavigationHandle* navigation,
                                              bool in_primary_page) {
  if (!lifecycle_request_)
    return;
  if (residency_ == ResidencyState::kFreezing && in_primary_page)
    freeze_cancelled_ = true;
  if (RestoringNavigation() && navigation->IsInPrimaryMainFrame() &&
      !navigation->IsSameDocument() && restore_navigation_ == -1)
    restore_navigation_ = navigation->GetNavigationId();
}
void LifecycleCoordinator::DidFinishNavigation(content::NavigationHandle* navigation) {
  if (!navigation->IsInPrimaryMainFrame())
    return;
  const auto* model = owner_.model_->FindWebView(owner_.session_, owner_.view_);
  // Discard commits an internal empty document. It is not a remote navigation
  // and must not advance the logical document generation a second time.
  if (residency_ == ResidencyState::kDiscarding ||
      (model && model->actual == Residency::discarded && !lifecycle_request_))
    return;
  const bool committed = navigation->HasCommitted() && !navigation->IsSameDocument();
  if (lifecycle_request_ && navigation->GetNavigationId() == restore_navigation_ &&
      RestoringNavigation()) {
    const bool success = committed && !navigation->IsErrorPage();
    // Callbacks run last because they may destroy this adapter.
    auto callback = std::move(completion_);
    auto status =
        FinishLifecycle(success, success ? Status{}
                                         : Fail(ErrorCode::kOutcomeUnknown,
                                                "Restore navigation did not commit successfully"));
    if (success)
      owner_.model_->CommitDocument(owner_.session_, owner_.view_);
    PostCompletion(std::move(callback), status);
    return;
  }
  if (committed && !lifecycle_uncertain_) {
    owner_.model_->CommitDocument(owner_.session_, owner_.view_);
  }
}
void LifecycleCoordinator::PrimaryMainFrameRenderProcessGone(base::TerminationStatus) {
  const auto* model = owner_.model_->FindWebView(owner_.session_, owner_.view_);
  auto callback = std::move(completion_);
  if (lifecycle_request_)
    FinishLifecycle(
        false, Fail(ErrorCode::kOutcomeUnknown, "Renderer exited during lifecycle transition"));
  else if (model && model->actual == Residency::frozen)
    // A frozen renderer can no longer acknowledge thaw. Its pre-freeze
    // checkpoint remains available to the guarded recovery request.
    lifecycle_uncertain_ = true;
  if (lifecycle_uncertain_)
    uncertainty_reason_ = "Renderer exited during lifecycle transition";
  owner_.model_->InvalidateInstance(owner_.session_, owner_.view_);
  PostCompletion(std::move(callback),
                 Fail(ErrorCode::kOutcomeUnknown, "Renderer exited during lifecycle transition"));
}
}  // namespace remotekit::browser
