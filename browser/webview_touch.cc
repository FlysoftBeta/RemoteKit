#include "browser/webview_touch.h"
#include "browser/webview_internal.h"
#include "browser/webview_execution.h"
#include "browser/device_configuration.h"
#include "browser/webview_navigation.h"
#include "browser/webview_input.h"
#include "browser/webview_lifecycle.h"

namespace remotekit::browser {
TouchController::TouchController(WebView& owner) : owner_(owner) {}
TouchController::~TouchController() = default;
bool TouchController::StartsNewSequence(const InputEvent& input) const {
  const auto* touch = std::get_if<TouchInput>(&input.payload);
  return touch && touch->clock && touch->action == TouchInput::Action::start &&
         (client_touch_token_ != input.token ||
          client_touch_sequence_ != touch->clock->sequence_id);
}
std::optional<Status> TouchController::PrepareInput(const InputEvent& input) {
  if (const auto* touch = std::get_if<TouchInput>(&input.payload)) {
    const bool new_sequence = StartsNewSequence(input);
    if (!new_sequence && touch->clock && client_touch_token_ &&
        (*client_touch_token_ != input.token ||
         touch->clock->sequence_id != client_touch_sequence_))
      return Fail(ErrorCode::stale_identity,
                  "Client touch sequence does not own the current contacts");
    if (!new_sequence && OwnershipUnconfirmed())
      return Fail(ErrorCode::unavailable, "Touch ACK timed out; start a new touch sequence");
    if (HasDevToolsConflict())
      return Fail(ErrorCode::unsupported, "Remote touch is exclusive with attached DevTools");
    std::size_t changed_points = touch->points.size();
    for (const auto& sample : touch->samples)
      changed_points += sample.points.size();
    if (changed_points > 64)
      return Fail(ErrorCode::invalid_request, "Too many touch history contacts");
    std::size_t pending = client_gesture_bridge_ ? client_gesture_bridge_->pending_ack_count() : 0;
    for (const auto& bridge : draining_gesture_bridges_)
      pending += bridge->pending_ack_count();
    const auto cancellation = new_sequence && !touches_.empty() ? 1u : 0u;
    if (pending + changed_points + cancellation + 1 > 128)
      return Fail(ErrorCode::busy, "Touch ACK queue busy; retry this input with the same sequence");
    std::map<std::uint32_t, TouchPoint> next_touches;
    auto status = BuildTouchState(*touch, new_sequence, &next_touches);
    if (!status)
      return status;
  }
  return std::nullopt;
}
Status TouchController::SupersedeClientTouch() {
  auto weak = weak_factory_.GetWeakPtr();
  auto bridge = client_gesture_bridge_;
  if (bridge) {
    if (TouchTargetAlive()) {
      bridge->StopMomentum();
      if (!weak)
        return Fail(ErrorCode::stale_identity, "Touch owner destroyed");
      if (!touches_.empty() && !bridge->has_routed_terminal()) {
        TouchInput cancel;
        cancel.action = TouchInput::Action::cancel;
        cancel.clock = touch_clock_;
        const auto status = InjectTouches(cancel);
        if (!weak)
          return Fail(ErrorCode::stale_identity, "Touch owner destroyed");
        if (!status)
          return status;
        bridge->Cancel(true);
        if (!weak)
          return Fail(ErrorCode::stale_identity, "Touch owner destroyed");
      }
      // A queued terminal retains arbitration until its canonical ACK so an
      // admitted tap can produce its click before the next sequence's gestures.
      if (bridge->awaiting_ack())
        draining_gesture_bridges_.push_back(std::move(bridge));
    } else {
      bridge->Cancel(false);
      if (!weak)
        return Fail(ErrorCode::stale_identity, "Touch owner destroyed");
    }
  }
  client_gesture_bridge_.reset();
  owner_state_ = OwnerState::kIdle;
  touch_hit_test_timer_.Stop();
  ++touch_epoch_;
  ++touch_ack_epoch_;
  touch_cleanup_pending_ = false;
  touch_pending_callbacks_ = 0;
  client_touch_ack_mismatch_ = false;
  client_touch_token_.reset();
  client_touch_sequence_.clear();
  touches_.clear();
  touch_pointer_ids_.clear();
  touch_clock_.reset();
  touch_target_view_.reset();
  touch_target_frame_.reset();
  touch_target_document_.reset();
  touch_root_offset_x_ = touch_root_offset_y_ = 0;
  touch_status_ = {};
  return {};
}
Status TouchController::Momentum(const GestureInput& gesture) {
  if (!TouchTargetAlive() || !client_gesture_bridge_)
    return Fail(ErrorCode::stale_identity, "Momentum document/target lost");
  return client_gesture_bridge_->Momentum(gesture);
}
Status TouchController::BuildTouchState(const TouchInput& input,
                                        bool new_sequence,
                                        std::map<std::uint32_t, TouchPoint>* next) const {
  *next = !new_sequence && owner_.input_->PointerTargetAlive()
              ? touches_
              : std::map<std::uint32_t, TouchPoint>{};
  for (const auto& sample : input.samples)
    for (const auto& point : sample.points)
      if (!next->contains(point.id) || !FloatFits(point.x) || !FloatFits(point.y))
        return Fail(ErrorCode::invalid_request, "Invalid touch history contact");
  for (const auto& point : input.points) {
    if (!FloatFits(point.x) || !FloatFits(point.y))
      return Fail(ErrorCode::invalid_request, "Touch point outside Blink representation");
    bool exists = next->contains(point.id);
    if ((input.action == TouchInput::Action::start && exists) ||
        ((input.action == TouchInput::Action::move || input.action == TouchInput::Action::end) &&
         !exists))
      return Fail(ErrorCode::invalid_request, "Invalid touch contact transition");
    if (input.action != TouchInput::Action::cancel)
      (*next)[point.id] = point;
  }
  if (next->size() > blink::WebTouchEvent::kTouchesLengthCap)
    return Fail(ErrorCode::unsupported, "At most 16 simultaneous touch contacts supported");
  if (input.action == TouchInput::Action::cancel && next->empty())
    return Fail(ErrorCode::invalid_request, "No touch sequence to cancel");
  return {};
}
Status TouchController::TouchInjectionStatus() const {
  if (touch_cleanup_pending_)
    return Fail(ErrorCode::busy, "Draining remote touch");
  if (AwaitingHitTest())
    return Fail(ErrorCode::busy, "Resolving touch target; retry subsequent input");
  if (HasDevToolsConflict())
    return Fail(ErrorCode::unsupported, "Remote touch is exclusive with DevTools touch emulation");
  if (!touches_.empty() && !TouchTargetAlive())
    return Fail(ErrorCode::stale_identity, "Touch target/document is no longer current");
  if (touch_pending_callbacks_)
    return {ErrorCode::none,
            "Submitted to Chromium; input processing pending, execution unconfirmed"};
  return touch_status_;
}
void TouchController::RefreshClientTouchOwner() {
  if (client_gesture_bridge_ && !TouchTargetAlive()) {
    CancelTouches(false);
    touch_status_ = Fail(ErrorCode::stale_identity, "Client touch target/document invalidated");
  }
}
void TouchController::DevToolsAgentHostAttached(content::DevToolsAgentHost* host) {
  if (!owner_.contents() || host->GetWebContents() != owner_.contents())
    return;
  // Remember a takeover even if CDP attaches and detaches between two remote
  // calls. Its private mode can change before we next inspect IsEnabled().
  CancelTouches(false);
  touch_status_ =
      Fail(ErrorCode::unsupported, "DevTools attachment invalidated remote touch ownership");
}
bool TouchController::HasDevToolsConflict() const {
  if (!owner_.contents())
    return false;
  // IsDebuggerAttached only checks the main-frame/tab hosts. Include attached
  // OOPIF hosts too: DevTools may take over input on any local root.
  for (const auto& host : content::DevToolsAgentHost::GetAll())
    if (host->IsAttached() && host->GetWebContents() == owner_.contents())
      return true;
  return false;
}
bool TouchController::TouchTargetAlive() const {
  return owner_.input_->PointerTargetAlive() && touch_target_view_ && touch_target_frame_ &&
         touch_target_document_ && InputFrameReady(touch_target_frame_.get()) &&
         touch_target_frame_->GetDocumentToken() == *touch_target_document_ &&
         touch_target_frame_->GetRenderWidgetHost()->GetView() == touch_target_view_.get() &&
         touch_target_view_->GetRootView() == owner_.input_->pointer_root_view_.get() &&
         owner_.input_->pointer_root_widget_->GetInputEventRouter() &&
         owner_.input_->pointer_root_widget_->GetInputEventRouter()->IsViewInMap(
             touch_target_view_.get());
}
void TouchController::ResetExecution() {
  CancelTouches(false);
  owner_state_ = OwnerState::kIdle;
  touch_status_ = {};
}
void TouchController::CancelTouches(bool deliver) {
  auto weak_self = weak_factory_.GetWeakPtr();
  const bool invalidated = !TouchTargetAlive();
  if (invalidated || !deliver) {
    for (const auto& bridge : draining_gesture_bridges_)
      bridge->Cancel(false);
    draining_gesture_bridges_.clear();
  }

  if (invalidated)
    owner_state_ = OwnerState::kInvalidated;
  if (client_gesture_bridge_) {
    if (invalidated) {
      touch_pending_callbacks_ = 0;
      touch_cleanup_pending_ = false;
    }
    if (touch_cleanup_pending_)
      return;
    if (deliver && TouchTargetAlive() && !touches_.empty()) {
      TouchInput cancel;
      cancel.action = TouchInput::Action::cancel;
      cancel.clock = touch_clock_;
      InjectTouches(cancel);
      if (!weak_self)
        return;
    }
    client_gesture_bridge_->Cancel(deliver);
    if (!weak_self)
      return;
    touch_cleanup_pending_ = touch_pending_callbacks_ != 0;
    touches_.clear();
    touch_pointer_ids_.clear();
    touch_clock_.reset();
    if (AwaitingHitTest())
      owner_state_ = OwnerState::kIdle;
    ++touch_epoch_;
    if (touch_cleanup_pending_)
      return;
    client_gesture_bridge_.reset();
  }
  if (!touches_.empty() || AwaitingHitTest())
    ++touch_cancelled_;
  touch_clock_.reset();
  ++touch_epoch_;
  if (AwaitingHitTest())
    owner_state_ = OwnerState::kIdle;
  touch_hit_test_timer_.Stop();
  touch_cleanup_pending_ = false;
  ++touch_ack_epoch_;
  touch_pending_callbacks_ = 0;
  touches_.clear();
  touch_pointer_ids_.clear();
  touch_target_view_.reset();
  touch_target_frame_.reset();
  touch_target_document_.reset();
  touch_root_offset_x_ = touch_root_offset_y_ = 0;
}
void TouchController::OnClientTouchProcessed(std::uint64_t epoch,
                                             InputToken token,
                                             const std::string& sequence,
                                             ClientTouchAckState ack,
                                             bool terminal,
                                             bool drained) {
  std::erase_if(draining_gesture_bridges_,
                [](const auto& bridge) { return !bridge->awaiting_ack(); });
  if (touch_ack_epoch_ != epoch || client_touch_token_ != token ||
      client_touch_sequence_ != sequence)
    return;
  if (ack == ClientTouchAckState::timeout)
    touch_pending_callbacks_ = 0;
  else if (touch_pending_callbacks_)
    --touch_pending_callbacks_;
  if (ack != ClientTouchAckState::canonical) {
    const bool invalidated = !TouchTargetAlive();
    if (ack == ClientTouchAckState::target_mismatch)
      client_touch_ack_mismatch_ = true;
    owner_state_ = invalidated ? OwnerState::kInvalidated : OwnerState::kUnconfirmed;
    touch_status_ = Fail(ErrorCode::stale_identity, "Client touch owner/ACK invalidated");
    if (invalidated)
      CancelTouches(false);
  } else if (terminal && drained && !touch_pending_callbacks_ && !client_touch_ack_mismatch_) {
    owner_state_ = OwnerState::kProcessed;
    touch_status_ = {};
  }
  if (touch_cleanup_pending_ && !touch_pending_callbacks_) {
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&TouchController::FinishTouchCleanup, weak_factory_.GetWeakPtr(),
                                  touch_ack_epoch_));
  }
}
void TouchController::FinishTouchCleanup(std::uint64_t expected) {
  if (!touch_cleanup_pending_ || touch_ack_epoch_ != expected || touch_pending_callbacks_)
    return;
  touch_cleanup_pending_ = false;
  CancelTouches(false);
}
Status TouchController::PrepareTouchClock(const TouchInput& touch) {
  const bool first = touch.action == TouchInput::Action::start && touches_.empty();
  const auto reject = [&]() {
    ++touch_clock_rejected_;
    CancelTouches(true);
    return Fail(ErrorCode::invalid_request, "Invalid touch source clock; sequence cancelled");
  };
  if (first) {
    touch_clock_.reset();
    touch_clock_origin_ = base::TimeTicks::Now();
    if (!touch.clock)
      return reject();
    if (touch.clock->elapsed_us != 0)
      return reject();
    touch_clock_ = touch.clock;
    if (!touch.clock->source) {
      ++touch_fallback_gestures_;
      return {};
    }
    // Wall is consulted exactly once. Every subsequent event uses this fixed
    // monotonic origin, including gestures spanning a system-wall adjustment.
    const auto now = base::TimeTicks::Now();
    const auto wall_us = (base::Time::Now() - base::Time::UnixEpoch()).InMicroseconds();
    const auto age = TouchStartAgeUs(touch.clock->start_wall_us, wall_us);
    if (!age)
      return reject();
    touch_clock_origin_ = now - base::Microseconds(*age);
    ++touch_source_gestures_;
    return {};
  }
  if (touch_clock_.has_value() != touch.clock.has_value())
    return reject();
  if (!touch.clock)
    return reject();
  if (touch_clock_->sequence_id != touch.clock->sequence_id ||
      touch_clock_->source != touch.clock->source ||
      touch_clock_->start_wall_us != touch.clock->start_wall_us ||
      touch.clock->elapsed_us < touch_clock_->elapsed_us)
    return reject();
  auto previous = touch_clock_->elapsed_us;
  for (const auto& sample : touch.samples) {
    if (sample.elapsed_us < previous)
      return reject();
    previous = sample.elapsed_us;
  }
  if (!TouchElapsedValid(touch_clock_->elapsed_us, touch.clock->elapsed_us,
                         (base::TimeTicks::Now() - touch_clock_origin_).InMicroseconds(),
                         touch.clock->source))
    return reject();
  touch_clock_->elapsed_us = touch.clock->elapsed_us;
  return {};
}
Status TouchController::DispatchTouches(const TouchInput& touch, const InputToken& token) {
  if (touch.action == TouchInput::Action::start &&
      (client_touch_token_ != token || client_touch_sequence_ != touch.clock->sequence_id)) {
    auto weak = weak_factory_.GetWeakPtr();
    const auto status = SupersedeClientTouch();
    if (!weak)
      return Fail(ErrorCode::stale_identity, "Touch owner destroyed");
    if (!status)
      return status;
  }
  const bool first = touch.action == TouchInput::Action::start && touches_.empty();
  if (first) {
    client_touch_ack_mismatch_ = false;
    client_touch_token_ = token;
    client_touch_sequence_ = touch.clock ? touch.clock->sequence_id : std::string();
  }
  auto clock = PrepareTouchClock(touch);
  if (!clock)
    return clock;
  if (touch.action == TouchInput::Action::start && touches_.empty()) {
    auto* root = owner_.input_->pointer_root_widget_.get();
    if (!root || !root->delegate()) {
      return Fail(ErrorCode::unavailable, "Touch hit testing unavailable");
    }
    owner_state_ = OwnerState::kAwaitingHitTest;
    touch_status_ = {};
    const auto epoch = ++touch_epoch_;
    touch_hit_test_timer_.Start(
        FROM_HERE, base::Seconds(2),
        base::BindOnce(
            [](base::WeakPtr<TouchController> self, std::uint64_t expected) {
              if (!self || self->touch_epoch_ != expected)
                return;
              self->CancelTouches(true);
              self->touch_status_ = Fail(ErrorCode::unavailable, "Touch hit test timed out");
            },
            weak_factory_.GetWeakPtr(), epoch));
    // As in DevTools InputHandler, hit test once before injection. Injecting
    // into rootView directly would skip OOPIF hit testing entirely.
    root->delegate()->GetRenderWidgetHostAtPointAsynchronously(
        owner_.input_->pointer_root_view_.get(),
        gfx::PointF(static_cast<float>(touch.points.front().x),
                    static_cast<float>(touch.points.front().y)),
        base::BindOnce(&TouchController::OnTouchTarget, weak_factory_.GetWeakPtr(), epoch, token,
                       touch));
    // The hit tester may complete synchronously. Otherwise this means accepted,
    // not delivered: TouchInjectionStatus() exposes the eventual result.
    return AwaitingHitTest() ? Status{} : touch_status_;
  }
  auto weak = weak_factory_.GetWeakPtr();
  const auto result = InjectTouches(touch);
  if (weak && !result && touch.action == TouchInput::Action::cancel)
    CancelTouches(true);
  if (weak)
    touch_status_ = result;
  return result;
}
void TouchController::OnTouchTarget(std::uint64_t epoch,
                                    InputToken token,
                                    TouchInput touch,
                                    base::WeakPtr<content::RenderWidgetHostViewBase> target,
                                    std::optional<gfx::PointF> transformed) {
  if (epoch != touch_epoch_ || !AwaitingHitTest())
    return;
  if (AwaitingHitTest())
    owner_state_ = OwnerState::kIdle;
  touch_hit_test_timer_.Stop();
  const auto reject = [&](ErrorCode error, const char* reason) {
    owner_state_ = OwnerState::kInvalidated;
    touch_status_ = Fail(error, reason);
  };
  const auto* model = owner_.model_->FindWebView(owner_.session_, owner_.view_);
  if (!owner_.input_->PointerTargetAlive() || !owner_.input_->input_commit_navigations_.empty() ||
      !model || model->instance != token.instance || model->document != token.document ||
      model->focus_generation != token.focus || !model->focused || model->pending ||
      model->actual != Residency::live) {
    reject(ErrorCode::stale_identity, "Touch target resolution crossed a document/focus boundary");
    return;
  }
  if (!target || !transformed || target->GetRootView() != owner_.input_->pointer_root_view_.get()) {
    reject(ErrorCode::unavailable, "No current touch target in this WebView");
    return;
  }
  auto* widget = target->GetRenderWidgetHost();
  content::RenderFrameHostImpl* target_frame = nullptr;
  owner_.contents()->GetPrimaryMainFrame()->ForEachRenderFrameHost(
      [&](content::RenderFrameHost* frame) {
        if (frame->GetRenderWidgetHost() == widget &&
            (!frame->GetParent() || frame->GetParent()->GetRenderWidgetHost() != widget))
          target_frame = static_cast<content::RenderFrameHostImpl*>(frame);
      });
  if (!InputFrameReady(target_frame)) {
    reject(ErrorCode::unavailable, "Touch target has no active local-root document");
    return;
  }
  // The router expects root coordinates even when its explicit target is an
  // OOPIF. Preserve the same coordinate conversion used by DevTools.
  const gfx::PointF root_point = target->TransformPointToRootCoordSpaceF(*transformed);
  touch_root_offset_x_ = root_point.x() - touch.points.front().x;
  touch_root_offset_y_ = root_point.y() - touch.points.front().y;
  touch_target_view_ = std::move(target);
  touch_target_frame_ = target_frame->GetWeakPtr();
  touch_target_document_ = target_frame->GetDocumentToken();
  owner_state_ = OwnerState::kActive;

  client_gesture_bridge_ = base::MakeRefCounted<ClientGestureBridge>(
      owner_.input_->pointer_root_widget_->GetInputEventRouter(),
      owner_.input_->pointer_root_view_.get(), touch_target_view_.get(), touch.clock->sequence_id,
      touch_clock_origin_,
      base::BindRepeating(&TouchController::OnClientTouchProcessed, weak_factory_.GetWeakPtr(),
                          touch_ack_epoch_, token, touch.clock->sequence_id));

  auto weak = weak_factory_.GetWeakPtr();
  const auto result = InjectTouches(touch);
  if (weak)
    touch_status_ = result;
}
Status TouchController::InjectTouches(const TouchInput& touch) {
  auto weak_self = weak_factory_.GetWeakPtr();
  if (!TouchTargetAlive()) {
    CancelTouches(false);
    return Fail(ErrorCode::stale_identity, "Touch target/document changed");
  }
  if (touch_pending_callbacks_ + touch.points.size() + 1 > 128)
    return Fail(ErrorCode::unavailable, "Touch ACK queue full");
  for (const auto& point : touch.points)
    if (!FloatFits(point.x + touch_root_offset_x_) || !FloatFits(point.y + touch_root_offset_y_))
      return Fail(ErrorCode::invalid_request,
                  "Transformed touch point outside Blink representation");
  if (!touch.samples.empty()) {
    TouchInput history = touch;
    history.samples.clear();
    history.gestures.clear();
    for (const auto& sample : touch.samples) {
      history.points = sample.points;
      history.clock->elapsed_us = sample.elapsed_us;
      auto status = InjectTouches(history);
      if (!weak_self)
        return Fail(ErrorCode::stale_identity, "Touch owner destroyed");
      if (!status)
        return status;
    }
    history.points = touch.points;
    history.clock = touch.clock;
    history.gestures = touch.gestures;
    return InjectTouches(history);
  }
  const auto emit = [&](Type type, std::optional<std::uint32_t> changed) -> Status {
    const auto now = base::TimeTicks::Now();
    const auto sampled = touch.clock.has_value()
                             ? touch_clock_origin_ + base::Microseconds(touch.clock->elapsed_us)
                             : now;
    ++touch_samples_;
    touch_last_dispatch_wall_ms_ = base::Time::Now().InMillisecondsFSinceUnixEpoch();
    touch_last_source_age_ms_ = (now - sampled).InMillisecondsF();
    // Keep unclamped source age for calibration diagnostics. Native input uses
    // the Browser clock even if a later packet has less delay than the first.
    if (!client_gesture_bridge_)
      return Fail(ErrorCode::stale_identity, "Client gesture bridge missing");
    const auto dispatched = client_gesture_bridge_->NativeTimestamp(sampled);
    blink::WebTouchEvent event(type, 0, dispatched);
    event.dispatch_type = type == Type::kTouchCancel
                              ? blink::WebInputEvent::DispatchType::kEventNonBlocking
                              : blink::WebInputEvent::DispatchType::kBlocking;
    for (const auto& [id, point] : touches_) {
      auto& p = event.touches[event.touches_length++];
      p.id = touch_pointer_ids_.at(id);
      p.pointer_type = blink::WebPointerProperties::PointerType::kTouch;
      p.SetPositionInWidget(static_cast<float>(point.x + touch_root_offset_x_),
                            static_cast<float>(point.y + touch_root_offset_y_));
      p.SetPositionInScreen(
          ViewportToScreen(owner_.input_->pointer_root_view_.get(), p.PositionInWidget()));
      p.force = static_cast<float>(point.pressure);
      using State = blink::WebTouchPoint::State;
      p.state = type == Type::kTouchCancel  ? State::kStateCancelled
                : changed != id             ? State::kStateStationary
                : type == Type::kTouchStart ? State::kStatePressed
                : type == Type::kTouchMove  ? State::kStateMoved
                                            : State::kStateReleased;
    }

    std::vector<TouchInput::Gesture> gestures;
    for (const auto& gesture : touch.gestures) {
      const bool first = gesture.type == TouchInput::Gesture::Type::tap_down;
      if (!changed || (!touch.points.empty() &&
                       changed == (first ? touch.points.front().id : touch.points.back().id)))
        gestures.push_back(gesture);
    }
    for (auto& gesture : gestures) {
      gesture.x += touch_root_offset_x_;
      gesture.y += touch_root_offset_y_;
    }
    if (event.IsTouchSequenceEnd())
      owner_state_ = OwnerState::kTerminalPending;
    ++touch_pending_callbacks_;
    auto result = client_gesture_bridge_->Dispatch(event, gestures, touch.clock->elapsed_us);
    if (!weak_self)
      return Fail(ErrorCode::stale_identity, "Touch owner destroyed");
    if (!result) {
      if (touch_pending_callbacks_)
        --touch_pending_callbacks_;
      owner_state_ = OwnerState::kUnconfirmed;
    }
    return result;
  };
  if (touch.action == TouchInput::Action::cancel) {
    ++touch_cancelled_;
    // MotionEventWeb requires ALL contacts cancelled in a cancellation event.
    auto status = emit(Type::kTouchCancel, std::nullopt);
    if (!weak_self)
      return Fail(ErrorCode::stale_identity, "Touch owner destroyed");
    if (status) {
      touches_.clear();
      touch_pointer_ids_.clear();
    }
    return status;
  }
  for (const auto& point : touch.points) {
    std::optional<TouchPoint> previous;
    if (touch.action != TouchInput::Action::start)
      previous = touches_.at(point.id);
    if (touch.action == TouchInput::Action::start) {
      // Android-derived gesture code requires compact pointer IDs <= 31.
      // External IDs remain arbitrary uint32; only this per-sequence map is compact.
      int pointer_id = 0;
      while (std::any_of(touch_pointer_ids_.begin(), touch_pointer_ids_.end(),
                         [pointer_id](const auto& pair) { return pair.second == pointer_id; }))
        ++pointer_id;
      touch_pointer_ids_[point.id] = pointer_id;
    }
    touches_[point.id] = point;
    auto status = emit(touch.action == TouchInput::Action::start  ? Type::kTouchStart
                       : touch.action == TouchInput::Action::move ? Type::kTouchMove
                                                                  : Type::kTouchEnd,
                       point.id);
    if (!weak_self)
      return Fail(ErrorCode::stale_identity, "Touch owner destroyed");
    if (!status) {
      if (previous)
        touches_[point.id] = *previous;
      else {
        touches_.erase(point.id);
        touch_pointer_ids_.erase(point.id);
      }

      CancelTouches(true);
      return status;
    }
    if (touch.action == TouchInput::Action::end) {
      touches_.erase(point.id);
      touch_pointer_ids_.erase(point.id);
    }
  }
  return {};
}
}  // namespace remotekit::browser
