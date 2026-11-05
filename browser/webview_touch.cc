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
bool TouchController::ReadsTerminalReceipt(const InputEvent& input) const {
  using TouchState = ClientTouchRetirement::State;
  const auto* incoming_touch = std::get_if<TouchInput>(&input.payload);
  bool cancel_reads_receipt = false;
  if (incoming_touch && incoming_touch->clock &&
      incoming_touch->action == TouchInput::Action::cancel) {
    const auto state = owner_.ClientTouchStatus(input.token, incoming_touch->clock->sequence_id);
    cancel_reads_receipt = state == TouchState::pending || state == TouchState::processed;
  }
  return cancel_reads_receipt;
}
std::optional<Status> TouchController::PrepareInput(const InputEvent& input,
                                                    bool cancel_reads_receipt,
                                                    bool* admitted) {
  std::map<std::uint32_t, TouchPoint> next_touches;
  if (const auto* touch = std::get_if<TouchInput>(&input.payload)) {
    if (touch->clock) {
      const auto prior = owner_.ClientTouchStatus(input.token, touch->clock->sequence_id);
      if (touch->action == TouchInput::Action::start &&
          prior != ClientTouchRetirement::State::unknown)
        return Fail(ErrorCode::invalid_request,
                    "Completed or retiring client touch cannot restart");
      if (cancel_reads_receipt) {
        // A routed terminal owns the sequence until its canonical ACK. A
        // second cleanup only observes that receipt, even during cleanup.
        auto accepted = owner_.model_->AcceptInput(owner_.session_, input);
        if (accepted && admitted)
          *admitted = true;
        return accepted;
      }
    }
    if (touch->clock && owner_.ClientTouchRetired(input.token, touch->clock->sequence_id)) {
      auto accepted = owner_.model_->AcceptInput(owner_.session_, input);
      if (!accepted)
        return accepted;
      if (touch->action == TouchInput::Action::start)
        return Fail(ErrorCode::invalid_request, "Retired client touch sequence cannot restart");
      return Fail(ErrorCode::stale_identity, "Client touch owner explicitly invalidated");
    }
    if (touch->clock && client_touch_token_ &&
        (!touches_.empty() || touch->action != TouchInput::Action::start) &&
        (*client_touch_token_ != input.token ||
         touch->clock->sequence_id != client_touch_sequence_))
      return Fail(ErrorCode::stale_identity,
                  "Client touch sequence does not own the current contacts");
    if (OwnershipUnconfirmed())
      return Fail(ErrorCode::unavailable,
                  "Touch ownership became uncertain; reload WebView required");
    if (HasDevToolsConflict())
      return Fail(ErrorCode::unsupported, "Remote touch is exclusive with attached DevTools");
    std::size_t changed_points = touch->points.size();
    for (const auto& sample : touch->samples)
      changed_points += sample.points.size();
    if (changed_points > 64)
      return Fail(ErrorCode::invalid_request, "Too many touch history contacts");
    if (touch_pending_callbacks_ + changed_points + 1 > 128 ||
        (touch->action == TouchInput::Action::start && touches_.empty() &&
         touch_pending_callbacks_))
      return Fail(ErrorCode::busy, "Touch ACK queue busy; retry this input with the same sequence");
    auto status = BuildTouchState(*touch, &next_touches);
    if (!status)
      return status;
  }
  return std::nullopt;
}
Status TouchController::Momentum(const GestureInput& gesture) {
  if (!TouchTargetAlive() || !client_gesture_bridge_)
    return Fail(ErrorCode::stale_identity, "Momentum document/target lost");
  return client_gesture_bridge_->Momentum(gesture);
}
Status TouchController::BuildTouchState(const TouchInput& input,
                                        std::map<std::uint32_t, TouchPoint>* next) const {
  *next = owner_.input_->PointerTargetAlive() ? touches_ : std::map<std::uint32_t, TouchPoint>{};
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
ClientTouchRetirement::State TouchController::RetireClientTouch(const InputToken& token,
                                                                const std::string& sequence) {
  using State = ClientTouchRetirement::State;
  RefreshClientTouchOwner();
  const auto prior = owner_.ClientTouchStatus(token, sequence);
  if ((prior != State::unknown && prior != State::unconfirmed) || client_touch_token_ != token ||
      client_touch_sequence_ != sequence ||
      (client_gesture_bridge_ && client_gesture_bridge_->has_routed_terminal()))
    return prior;
  auto weak = weak_factory_.GetWeakPtr();
  if (AwaitingHitTest()) {
    // This owner has never routed a raw event.
    retired_client_touches_.Retire(token, sequence, true);
    CancelTouches(false);
  } else if (!touches_.empty() && TouchTargetAlive()) {
    // Cancel on the latched owner, with its last accepted positions/clock.
    // This path never remaps an event into the replacement layout.
    CancelTouches(true);
  }
  return weak ? owner_.ClientTouchStatus(token, sequence) : State::unknown;
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
  if (invalidated)
    owner_state_ = OwnerState::kInvalidated;
  if (client_touch_token_)
    retired_client_touches_.Retire(*client_touch_token_, client_touch_sequence_, invalidated);
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
void TouchController::OnClientTouchProcessed(InputToken token,
                                             const std::string& sequence,
                                             ClientTouchAckState ack,
                                             bool terminal,
                                             bool drained) {
  if (client_touch_token_ != token || client_touch_sequence_ != sequence)
    return;
  using State = ClientTouchRetirement::State;
  if (ack != ClientTouchAckState::timeout && touch_pending_callbacks_)
    --touch_pending_callbacks_;
  if (ack != ClientTouchAckState::canonical) {
    const bool invalidated = !TouchTargetAlive();
    if (ack == ClientTouchAckState::target_mismatch)
      client_touch_ack_mismatch_ = true;
    if (invalidated)
      retired_client_touches_.Retire(token, sequence, true);
    else
      retired_client_touches_.Resolve(token, sequence, State::unconfirmed);
    owner_state_ = invalidated ? OwnerState::kInvalidated : OwnerState::kUnconfirmed;
    touch_status_ = Fail(ErrorCode::stale_identity, "Client touch owner/ACK invalidated");
    if (invalidated)
      CancelTouches(false);
  } else if (terminal && drained && !touch_pending_callbacks_ && !client_touch_ack_mismatch_) {
    retired_client_touches_.Resolve(token, sequence, State::processed);
    if (owner_.ClientTouchStatus(token, sequence) == State::processed) {
      owner_state_ = OwnerState::kProcessed;
      touch_status_ = {};
    }
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
  const bool first = touch.action == TouchInput::Action::start && touches_.empty();
  if (first) {
    if (client_gesture_bridge_)
      client_gesture_bridge_->Cancel(true);
    client_gesture_bridge_.reset();
    client_touch_ack_mismatch_ = false;
    client_touch_token_ = token;
    client_touch_sequence_ = touch.clock ? touch.clock->sequence_id : std::string();
  }
  auto clock = PrepareTouchClock(touch);
  if (!clock) {
    if (first)
      retired_client_touches_.Retire(token, touch.clock->sequence_id, true);
    return clock;
  }
  if (touch.action == TouchInput::Action::start && touches_.empty()) {
    if (touch_pending_callbacks_)
      return Fail(ErrorCode::unavailable, "Previous touch sequence is still being acknowledged");
    auto* root = owner_.input_->pointer_root_widget_.get();
    if (!root || !root->delegate()) {
      retired_client_touches_.Retire(token, touch.clock->sequence_id, true);
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
              // The first raw event cannot route until
              // this hit test completes.
              if (self->client_touch_token_)
                self->retired_client_touches_.Retire(*self->client_touch_token_,
                                                     self->client_touch_sequence_, true);
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
  // A failed initial hit test has never routed a raw touch. Retire only this
  // requested owner, so a later exact cleanup can recover from a lost reply.
  const auto reject = [&](ErrorCode error, const char* reason) {
    retired_client_touches_.Retire(token, touch.clock->sequence_id, true);
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
                          token, touch.clock->sequence_id));

  auto weak = weak_factory_.GetWeakPtr();
  auto bridge = client_gesture_bridge_;
  const auto result = InjectTouches(touch);
  if (weak && !result && bridge && !bridge->has_routed_raw())
    retired_client_touches_.Retire(token, touch.clock->sequence_id, true);
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
    const auto terminal_owner = event.IsTouchSequenceEnd() ? client_touch_token_ : std::nullopt;
    const auto terminal_sequence = terminal_owner ? client_touch_sequence_ : std::string();
    if (terminal_owner)
      owner_state_ = OwnerState::kTerminalPending;
    if (terminal_owner)
      retired_client_touches_.Begin(*terminal_owner, terminal_sequence);
    ++touch_pending_callbacks_;
    auto result = client_gesture_bridge_->Dispatch(event, gestures, touch.clock->elapsed_us);
    if (!weak_self)
      return Fail(ErrorCode::stale_identity, "Touch owner destroyed");
    if (!result) {
      if (touch_pending_callbacks_)
        --touch_pending_callbacks_;
      if (terminal_owner)
        retired_client_touches_.Resolve(*terminal_owner, terminal_sequence,
                                        ClientTouchRetirement::State::unconfirmed);
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
