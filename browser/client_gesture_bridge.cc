#include "browser/client_gesture_bridge.h"

#include "base/functional/bind.h"
#include "components/input/events_helper.h"
#include "components/input/input_router.h"
#include "components/input/render_widget_host_view_input.h"
#include "content/browser/renderer_host/input/motion_event_web.h"  // nogncheck
#include "ui/events/base_event_utils.h"
#include "ui/events/blink/blink_event_util.h"

namespace remotekit::browser {
ClientGestureBridge::ClientGestureBridge(
    input::RenderWidgetHostInputEventRouter* router,
    input::RenderWidgetHostViewInput* root,
    input::RenderWidgetHostViewInput* target,
    std::string sequence,
    base::TimeTicks origin,
    base::RepeatingCallback<void(ClientTouchAckState, bool, bool)> processed)
    : router_(router->GetWeakPtr()),
      root_(root->GetInputWeakPtr()),
      target_(target->GetInputWeakPtr()),
      sequence_(std::move(sequence)),
      origin_(origin),
      processed_(std::move(processed)),
      native_clock_(origin, base::TimeTicks::Now()) {
  // Source deltas are authoritative; ACK/network latency must not scale them.
  filter_.DisableScrollUpdateCompensation();
}
ClientGestureBridge::~ClientGestureBridge() {
  filter_.Shutdown();
}

Status ClientGestureBridge::Dispatch(blink::WebTouchEvent event,
                                     const std::vector<TouchInput::Gesture>& candidates,
                                     int64_t source_elapsed_us) {
  scoped_refptr<ClientGestureBridge> keep_alive(this);
  // Timeout shuts down gesture arbitration. An exact owner can still send its
  // first raw cancellation and obtain canonical ACK proof without candidates.
  const bool retirement = stopped_ && first_id_ && !terminal_routed_ &&
                          event.GetType() == blink::WebInputEvent::Type::kTouchCancel;
  if ((stopped_ && !retirement) || !router_ || !root_ || !target_ ||
      !router_->IsViewInMap(root_.get()))
    return {ErrorCode::stale_identity, "Client touch owner lost"};
  if (pending_.size() >= 128)
    return {ErrorCode::busy, "Client touch ACK queue full"};
  event.unique_touch_event_id = ui::GetNextTouchEventId();
  if (!first_id_ && !event.IsTouchSequenceStart())
    return {ErrorCode::invalid_request, "Missing first client touch"};
  const auto first_id = first_id_ ? first_id_ : event.unique_touch_event_id;
  auto candidate_state = candidate_state_;
  if (!candidate_state.Accept(candidates, !first_id_, event.IsTouchSequenceEnd(),
                              event.touches_length))
    return {ErrorCode::invalid_request, "Invalid client gesture candidate order"};
  auto source_time = source_time_;
  if (!source_time.Raw(source_elapsed_us, event.IsTouchSequenceEnd()))
    return {ErrorCode::invalid_request, "Invalid client raw source time"};
  event.moved_beyond_slop_region = candidate_state.moved();
  content::MotionEventWeb motion(event);
  auto packet = MakeClientGesturePacket(motion, candidates, first_id);
  if (!router_->RegisterClientTouch(
          root_.get(), event.unique_touch_event_id,
          base::BindOnce(&ClientGestureBridge::Ack, weak_factory_.GetWeakPtr())))
    return {ErrorCode::busy, "Client touch router registrations full"};
  pending_.insert(event.unique_touch_event_id);
  auto weak = weak_factory_.GetWeakPtr();
  if (!retirement &&
      filter_.OnGesturePacket(packet) != ui::TouchDispositionGestureFilter::SUCCESS) {
    router_->WithdrawUnroutedClientTouch(root_.get(), event.unique_touch_event_id);
    pending_.erase(event.unique_touch_event_id);
    return {ErrorCode::invalid_request, "Invalid client gesture packet order"};
  }
  if (!weak || (stopped_ && !retirement) || !router_ || !root_ || !target_ ||
      !router_->IsViewInMap(root_.get())) {
    if (router_)
      router_->WithdrawUnroutedClientTouch(root_.get(), event.unique_touch_event_id);
    pending_.erase(event.unique_touch_event_id);
    return {ErrorCode::stale_identity, "Client touch owner destroyed"};
  }
  first_id_ = first_id;
  candidate_state_ = candidate_state;
  source_time_ = source_time;
  for (const auto& candidate : candidates)
    if (candidate.type == TouchInput::Gesture::Type::fling_start)
      fling_pending_ = true;
  timeout_.Start(FROM_HERE, base::Seconds(2), base::BindOnce(&ClientGestureBridge::Timeout, weak));
  // OnGesturePacket can synchronously release a preceding packet's repair.
  // Recheck at the actual raw routing boundary as well.
  event.SetTimeStamp(NativeTimestamp(event.TimeStamp()));
  terminal_routed_ = terminal_routed_ || event.IsTouchSequenceEnd();
  router_->RouteTouchEvent(root_.get(), &event, ui::LatencyInfo());
  return {};
}

void ClientGestureBridge::Ack(const blink::WebTouchEvent& event,
                              blink::mojom::InputEventResultState result,
                              input::RenderWidgetHostViewInput* target) {
  scoped_refptr<ClientGestureBridge> keep_alive(this);
  if (!pending_.erase(event.unique_touch_event_id))
    return;
  const bool alive = router_ && root_ && target_ && target == target_.get();
  auto weak = weak_factory_.GetWeakPtr();
  if (alive && !stopped_) {
    const bool consumed = result == blink::mojom::InputEventResultState::kConsumed ||
                          result == blink::mojom::InputEventResultState::kUnknown;
    if (consumed && event.unique_touch_event_id == first_id_)
      router_->OnHandledTouchStartOrFirstTouchMove(first_id_);
    filter_.OnTouchEventAck(event.unique_touch_event_id, consumed,
                            input::InputEventResultStateIsSetBlocking(result));
  } else if (!alive) {
    Cancel(false);
  }
  if (!weak)
    return;
  if (pending_.empty() && !momentum_)
    timeout_.Stop();
  CompleteClientTouchAck(
      event.IsTouchSequenceEnd(), fling_pending_, momentum_,
      base::BindOnce(&ClientGestureBridge::EndMomentum, weak),
      base::BindOnce(processed_,
                     alive ? ClientTouchAckState::canonical : ClientTouchAckState::target_mismatch,
                     event.IsTouchSequenceEnd(), pending_.empty()));
}

base::TimeTicks ClientGestureBridge::NativeTimestamp(base::TimeTicks sampled) {
  return native_clock_.Dispatch(sampled, base::TimeTicks::Now());
}
bool ClientGestureBridge::Route(blink::WebGestureEvent event) {
  if (stopped_ || !router_ || !root_ || !target_)
    return false;
  // ACKs can release an old candidate after a newer raw event was dispatched.
  event.SetTimeStamp(NativeTimestamp(event.TimeStamp()));
  return router_->RouteClientGestureEvent(root_.get(), event, first_id_, target_.get());
}
void ClientGestureBridge::ForwardGestureEvent(const ui::GestureEventData& data) {
  auto event = ui::CreateWebGestureEventFromGestureEventData(data);
  using T = blink::WebInputEvent::Type;
  if (event.GetType() == T::kGestureFlingStart) {
    // Keep the router's scroll target and touch-action state. Never invoke the
    // native FlingController (which would add boosting and a second curve).
    auto* input_router = target_ ? target_->GetViewRenderInputRouter()->input_router() : nullptr;
    momentum_ = bound_ && scroll_ && target_ && root_ && input_router &&
                input_router->ActiveTouchAction().has_value();
    if (momentum_)
      input_router->SetClientMomentumActive(true);
    momentum_deadline_ = base::TimeTicks::Now() + base::Seconds(5);
    fling_pending_ = false;
    if (!momentum_) {
      EndMomentum();
      return;
    }
    if (momentum_ && buffered_) {
      const auto value = *buffered_;
      buffered_.reset();
      Momentum(value);
    }
    return;
  }
  if (event.GetType() == T::kGestureFlingCancel) {
    EndMomentum();
    return;
  }
  if (event.GetType() == T::kGestureTapDown) {
    event.unique_touch_event_id = first_id_;
    bound_ = Route(event);
    return;
  }
  if (!bound_)
    return;
  if (event.GetType() == T::kGestureScrollBegin)
    scroll_ = true;
  if (event.GetType() == T::kGestureScrollEnd)
    scroll_ = false;
  last_gesture_ = event;
  Route(event);
}

Status ClientGestureBridge::Momentum(const GestureInput& value) {
  scoped_refptr<ClientGestureBridge> keep_alive(this);
  if (stopped_ || value.sequence_id != sequence_ || !root_ || !target_)
    return {ErrorCode::stale_identity, "Momentum owner lost"};
  if (value.action == GestureInput::Action::cancel) {
    EndMomentum();
    return {};
  }
  if (!momentum_) {
    if (fling_pending_) {
      buffered_ = value;
      return {};
    }
    return {ErrorCode::stale_identity, "Momentum was not allowed"};
  }
  if (base::TimeTicks::Now() > momentum_deadline_ || !source_time_.Momentum(value.elapsed_us)) {
    EndMomentum();
    return {ErrorCode::invalid_request, "Invalid momentum source time"};
  }
  auto event = *last_gesture_;
  event.SetType(blink::WebInputEvent::Type::kGestureScrollUpdate);
  event.SetTimeStamp(origin_ + base::Microseconds(value.elapsed_us));
  event.data.scroll_update.delta_x = value.cumulative_x - cumulative_x_;
  event.data.scroll_update.delta_y = value.cumulative_y - cumulative_y_;
  event.data.scroll_update.delta_x_unconstrained = event.data.scroll_update.delta_x;
  event.data.scroll_update.delta_y_unconstrained = event.data.scroll_update.delta_y;
  event.data.scroll_update.inertial_phase = blink::WebGestureEvent::InertialPhaseState::kMomentum;
  event.data.scroll_update.delta_units = ui::ScrollGranularity::kScrollByPrecisePixel;
  cumulative_x_ = value.cumulative_x;
  cumulative_y_ = value.cumulative_y;
  auto weak = weak_factory_.GetWeakPtr();
  if (event.data.scroll_update.delta_x || event.data.scroll_update.delta_y)
    Route(event);
  if (!weak)
    return {};
  if (value.action == GestureInput::Action::momentum_end)
    EndMomentum();
  else
    timeout_.Start(FROM_HERE, base::Seconds(2),
                   base::BindOnce(&ClientGestureBridge::Timeout, weak));
  return {};
}
void ClientGestureBridge::EndMomentum() {
  momentum_ = false;
  fling_pending_ = false;
  buffered_.reset();
  if (scroll_ && last_gesture_) {
    scroll_ = false;
    auto end = *last_gesture_;
    end.SetType(blink::WebInputEvent::Type::kGestureScrollEnd);
    end.SetTimeStamp(origin_ + base::Microseconds(source_time_.last()));
    end.data.scroll_end = {};
    end.data.scroll_end.inertial_phase = blink::WebGestureEvent::InertialPhaseState::kMomentum;
    Route(end);
  }
  if (target_)
    target_->GetViewRenderInputRouter()->input_router()->SetClientMomentumActive(false);
  if (pending_.empty())
    timeout_.Stop();
}
void ClientGestureBridge::Cancel(bool deliver) {
  scoped_refptr<ClientGestureBridge> keep_alive(this);
  if (stopped_)
    return;
  if (deliver)
    EndMomentum();
  else if (target_)
    target_->GetViewRenderInputRouter()->input_router()->SetClientMomentumActive(false);
  stopped_ = true;
  filter_.Shutdown();
  if (pending_.empty())
    timeout_.Stop();
  else
    timeout_.Start(FROM_HERE, base::Seconds(2),
                   base::BindOnce(&ClientGestureBridge::Timeout, weak_factory_.GetWeakPtr()));
  if (router_ && first_id_)
    router_->OnHandledTouchStartOrFirstTouchMove(first_id_);
  buffered_.reset();
}
void ClientGestureBridge::Timeout() {
  const bool raw_pending = !pending_.empty();
  Cancel(true);
  if (raw_pending)
    processed_.Run(ClientTouchAckState::timeout, false, false);
}
}  // namespace remotekit::browser
