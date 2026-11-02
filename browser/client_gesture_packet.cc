#include "browser/client_gesture_packet.h"
#include <array>
#include <utility>
namespace remotekit::browser {
void CompleteClientTouchAck(bool terminal, bool fling_pending, bool momentum,
                            base::OnceClosure end_momentum, base::OnceClosure processed) {
  if (terminal && fling_pending && !momentum) std::move(end_momentum).Run();
  std::move(processed).Run();
}
namespace {
ui::EventType Type(TouchInput::Gesture::Type type) {
  static constexpr std::array types = {
      ui::EventType::kGestureTapDown, ui::EventType::kGestureTapCancel,
      ui::EventType::kGestureTap, ui::EventType::kGestureScrollBegin,
      ui::EventType::kGestureScrollUpdate, ui::EventType::kGestureScrollEnd,
      ui::EventType::kGesturePinchBegin, ui::EventType::kGesturePinchUpdate,
      ui::EventType::kGesturePinchEnd, ui::EventType::kScrollFlingStart,
      ui::EventType::kScrollFlingCancel};
  return types[static_cast<size_t>(type)];
}
}
ui::GestureEventDataPacket MakeClientGesturePacket(const ui::MotionEvent& motion,
    const std::vector<TouchInput::Gesture>& candidates, uint32_t first_id) {
  auto packet = ui::GestureEventDataPacket::FromTouch(motion);
  for (const auto& candidate : candidates) {
    const auto type = Type(candidate.type);
    ui::GestureEventDetails details(type);
    if (type == ui::EventType::kGestureScrollBegin || type == ui::EventType::kGestureScrollUpdate ||
        type == ui::EventType::kGestureScrollEnd)
      details = ui::GestureEventDetails(type, candidate.delta_x, candidate.delta_y);
    if (type == ui::EventType::kScrollFlingStart)
      details = ui::GestureEventDetails(type, candidate.velocity_x, candidate.velocity_y);
    if (type == ui::EventType::kGesturePinchUpdate) details.set_scale(candidate.scale);
    if (type == ui::EventType::kGestureTapDown) details.set_tap_down_count(1);
    if (type == ui::EventType::kGestureTap) details.set_tap_count(1);
    // Tool type identifies the pointer (finger/pen), not the gesture device.
    // Blink requires the latter even for candidates only forwarded after ACK;
    // filter-synthesized copies (for example show-press) inherit it as well.
    details.set_device_type(ui::GestureDeviceType::DEVICE_TOUCHSCREEN);
    details.set_primary_unique_touch_event_id(first_id);
    packet.Push(ui::GestureEventData(details, motion.GetPointerId(0), motion.GetToolType(0),
        motion.GetEventTime(), candidate.x, candidate.y, candidate.x, candidate.y,
        motion.GetPointerCount(), gfx::RectF(), 0, motion.GetUniqueEventId()));
  }
  return packet;
}
bool ClientGestureCandidateState::Accept(const std::vector<TouchInput::Gesture>& candidates,
                                        bool first_raw, bool last_up, size_t raw_pointer_count) {
  auto next = *this;
  using T = TouchInput::Gesture::Type;
  for (const auto& g : candidates) {
    switch (g.type) {
      case T::tap_down:
        if (!first_raw || next.tap_ || next.scroll_) return false;
        next.tap_ = true;
        break;
      case T::tap:
        if (!next.tap_ || !last_up || next.scroll_) return false;
        next.tap_ = false;
        break;
      case T::tap_cancel: next.tap_ = false; break;
      case T::scroll_begin:
        if (next.scroll_) return false;
        // The official action filter assesses one-finger scrolling from the
        // GSB direction. A zero hint is reserved for wrapping a real multi-
        // touch pinch; allowing it for one finger bypasses that assessment.
        if (raw_pointer_count < 2 && g.delta_x == 0 && g.delta_y == 0) return false;
        next.scroll_ = true; next.tap_ = false; next.moved_ = true;
        break;
      case T::scroll_update:
        if (!next.scroll_) return false;
        break;
      case T::scroll_end:
        if (!next.scroll_ || next.pinch_) return false;
        next.scroll_ = false;
        break;
      case T::pinch_begin:
        if (!next.scroll_ || next.pinch_) return false;
        next.pinch_ = true;
        break;
      case T::pinch_update: if (!next.pinch_) return false; break;
      case T::pinch_end:
        if (!next.pinch_) return false;
        next.pinch_ = false;
        break;
      case T::fling_start:
        if (!last_up || !next.scroll_ || next.pinch_) return false;
        next.scroll_ = false;
        break;
      case T::fling_cancel: break;
    }
  }
  *this = next;
  return true;
}
}  // namespace remotekit::browser
