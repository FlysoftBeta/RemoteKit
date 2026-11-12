// CPU only: production packet helper and the official disposition/action filters.
#include "browser/client_gesture_packet.h"
#include "browser/client_input_timing.h"
#include <algorithm>
#include <vector>
#include "base/at_exit.h"
#include "base/check.h"
#include "base/command_line.h"
#include "base/functional/bind.h"
#include "components/input/touch_action_filter.h"
#include "third_party/blink/public/common/input/web_gesture_event.h"
#include "third_party/blink/public/common/input/web_touch_event.h"
#include "ui/events/gesture_detection/touch_disposition_gesture_filter.h"
#include "ui/events/blink/blink_event_util.h"
#include "ui/events/velocity_tracker/motion_event_generic.h"

namespace {
using G = remotekit::TouchInput::Gesture;
using T = G::Type;
using E = ui::EventType;
using A = ui::MotionEvent::Action;
void TestClientInputTiming() {
  blink::WebTouchEvent end(blink::WebInputEvent::Type::kTouchEnd, 0, base::TimeTicks());
  end.touches_length = 2;
  end.touches[0].state = blink::WebTouchPoint::State::kStateReleased;
  end.touches[1].state = blink::WebTouchPoint::State::kStateStationary;
  CHECK(!end.IsTouchSequenceEnd());
  end.touches_length = 1;
  CHECK(end.IsTouchSequenceEnd());
  using remotekit::browser::ClientGestureSourceTime;
  using remotekit::browser::ClientNativeInputClock;
  // The first packet incurred 100ms more transport/queue delay than the next.
  // Source elapsed keeps its value; all Native timestamps stay <= dispatch now.
  ClientNativeInputClock<int64_t> native(1000000, 1000000);
  ClientGestureSourceTime source;
  CHECK(source.Raw(0, false));
  CHECK_EQ(native.Dispatch(1000000, 1000000), 1000000);
  CHECK(source.Raw(120000, false));
  CHECK_EQ(native.Dispatch(1120000, 1020000), 1020000);
  // ACK-released old candidate and late history cannot move Native time back.
  CHECK_EQ(native.Dispatch(1000000, 1021000), 1020000);
  CHECK_EQ(native.Dispatch(1010000, 1022000), 1020000);
  CHECK(source.Raw(120000, false));
  CHECK_EQ(native.Dispatch(1120000, 1023000), 1023000);
  CHECK(!source.Raw(119999, false));
  CHECK(source.Raw(140000, true));
  CHECK_EQ(native.Dispatch(1140000, 1040000), 1040000);
  CHECK_EQ(source.last(), 140000);
  // Five-second bound is measured from the original up, not the clamped 40ms.
  CHECK(source.Momentum(140000));
  CHECK(source.Momentum(5140000));
  CHECK_EQ(native.Dispatch(6140000, 1100000), 1100000);
  CHECK(!source.Momentum(5140001));
  CHECK(!source.Momentum(5139999));
  // Both explicit cancellation and generated end use the same Native clock.
  CHECK_EQ(native.Dispatch(1000000 + source.last(), 1101000), 1101000);
  CHECK_EQ(native.Dispatch(1000000 + source.last(), 1102000), 1102000);
  // Normal, delayed history, equal elapsed, cancel/end, and a new clock whose
  // calibrated origin is slightly in the future (permitted source wall skew).
  ClientNativeInputClock<int64_t> normal(1000000, 1000000);
  ClientGestureSourceTime history;
  CHECK(history.Raw(10000, false));
  CHECK_EQ(normal.Dispatch(1010000, 1050000), 1010000);
  CHECK(history.Raw(20000, false));
  CHECK_EQ(normal.Dispatch(1020000, 1050000), 1020000);
  CHECK(history.Raw(20000, false));
  CHECK_EQ(normal.Dispatch(1020000, 1050000), 1020000);
  CHECK(history.Raw(30000, true));
  CHECK_EQ(normal.Dispatch(1030000, 1050000), 1030000);
  CHECK_EQ(history.last(), 30000);
  CHECK_EQ(normal.Dispatch(1010000, 1060000), 1030000);
  CHECK_EQ(normal.Dispatch(1030000, 1060000), 1030000);
  ClientNativeInputClock<int64_t> future_origin(1100000, 1000000);
  CHECK_EQ(future_origin.Dispatch(1100000, 1000000), 1000000);
  CHECK_EQ(future_origin.Dispatch(1110000, 1010000), 1010000);

  ClientGestureSourceTime timed_out;
  CHECK(timed_out.Raw(0, false));
  CHECK(timed_out.Raw(500000, false));  // Long press while the start ACK is pending.
  CHECK(!timed_out.Raw(0, true));
  timed_out.Cancel(0);
  CHECK_EQ(timed_out.last(), 500000);
  ClientNativeInputClock<int64_t> cleanup_native(1000000, 1000000);
  CHECK_EQ(cleanup_native.Dispatch(1000000 + timed_out.last(), 3300000), 1500000);
  CHECK(!timed_out.Raw(499999, false));
  timed_out.Cancel(700000);
  CHECK_EQ(timed_out.last(), 700000);
  ClientGestureSourceTime recovery;
  CHECK(recovery.Raw(0, false));
}
struct Sink : ui::TouchDispositionGestureFilterClient {
  std::vector<ui::GestureEventData> events;
  void ForwardGestureEvent(const ui::GestureEventData& event) override {
    // Exercise the exact terminal conversion used by ClientGestureBridge.
    // Merely checking candidate enums misses fatal unknown gesture devices.
    CHECK(event.details.device_type() == ui::GestureDeviceType::DEVICE_TOUCHSCREEN);
    const auto web = ui::CreateWebGestureEventFromGestureEventData(event);
    CHECK(web.SourceDevice() == blink::WebGestureDevice::kTouchscreen);
    CHECK(web.GetType() != blink::WebInputEvent::Type::kUndefined);
    events.push_back(event);
  }
  bool Has(E type) const {
    return std::ranges::any_of(events, [type](const auto& e) { return e.type() == type; });
  }
};
void Packet(ui::TouchDispositionGestureFilter& filter,
            uint32_t id,
            A action,
            const std::vector<G>& gestures,
            bool consumed,
            bool acknowledge = true) {
  ui::PointerProperties pointer(100, 100, 1);
  pointer.id = 0;
  pointer.tool_type = ui::MotionEvent::ToolType::FINGER;
  ui::MotionEventGeneric event(
      action, base::TimeTicks() + base::Seconds(1) + base::Milliseconds(id), pointer);
  event.set_unique_event_id(id);
  const auto packet = remotekit::browser::MakeClientGesturePacket(event, gestures, 1);
  CHECK_EQ(packet.unique_touch_event_id(), id);
  CHECK_EQ(filter.OnGesturePacket(packet), ui::TouchDispositionGestureFilter::SUCCESS);
  if (acknowledge)
    filter.OnTouchEventAck(id, consumed, true);
}
struct ActionSink : input::TouchActionFilterClient {
  void OnUnconfirmedTapConvertedToTap() override {}
};
blink::WebGestureEvent Gesture(blink::WebInputEvent::Type type) {
  return blink::WebGestureEvent(type, 0, base::TimeTicks() + base::Seconds(1),
                                blink::WebGestureDevice::kTouchscreen);
}
void TestMomentumAction(cc::TouchAction action,
                        bool x_allowed,
                        bool y_allowed,
                        float hint_x,
                        float hint_y,
                        int pointers = 1,
                        bool pinch_allowed = false) {
  ActionSink sink;
  input::TouchActionFilter filter(&sink);
  filter.IncreaseActiveTouches();
  filter.OnSetTouchAction(action);
  auto down = Gesture(blink::WebInputEvent::Type::kGestureTapDown);
  down.data.tap_down.tap_down_count = 1;
  filter.FilterGestureEvent(&down);
  auto begin = Gesture(blink::WebInputEvent::Type::kGestureScrollBegin);
  begin.data.scroll_begin.delta_x_hint = hint_x;
  begin.data.scroll_begin.delta_y_hint = hint_y;
  begin.data.scroll_begin.pointer_count = pointers;
  const auto begin_result = filter.FilterGestureEvent(&begin);
  CHECK(begin_result == (x_allowed || y_allowed ? input::FilterGestureEventResult::kAllowed
                                                : input::FilterGestureEventResult::kFiltered));
  filter.SetClientMomentumActive(true);
  filter.DecreaseActiveTouches();
  filter.ReportAndResetTouchAction();
  CHECK(filter.active_touch_action() == action);
  auto update = Gesture(blink::WebInputEvent::Type::kGestureScrollUpdate);
  update.data.scroll_update.delta_x = update.data.scroll_update.delta_y = 9;
  update.data.scroll_update.inertial_phase = blink::WebGestureEvent::InertialPhaseState::kMomentum;
  const auto result = filter.FilterGestureEvent(&update);
  if (x_allowed || y_allowed) {
    CHECK(result == input::FilterGestureEventResult::kAllowed);
    CHECK_EQ(update.data.scroll_update.delta_x, x_allowed ? 9 : 0);
    CHECK_EQ(update.data.scroll_update.delta_y, y_allowed ? 9 : 0);
  } else
    CHECK(result == input::FilterGestureEventResult::kFiltered);
  auto pinch = Gesture(blink::WebInputEvent::Type::kGesturePinchBegin);
  const auto pinch_result = pinch_allowed ? input::FilterGestureEventResult::kAllowed
                                          : input::FilterGestureEventResult::kFiltered;
  CHECK(filter.FilterGestureEvent(&pinch) == pinch_result);
  auto pinch_end = Gesture(blink::WebInputEvent::Type::kGesturePinchEnd);
  CHECK(filter.FilterGestureEvent(&pinch_end) == pinch_result);
  auto end = Gesture(blink::WebInputEvent::Type::kGestureScrollEnd);
  filter.FilterGestureEvent(&end);
  filter.SetClientMomentumActive(false);
  CHECK(filter.active_touch_action() == cc::TouchAction::kAuto);
  // Rejection and momentum teardown must not poison the next official sequence.
  filter.IncreaseActiveTouches();
  filter.FilterGestureEvent(&down);
  CHECK(filter.FilterGestureEvent(&begin) == input::FilterGestureEventResult::kAllowed);
  update.data.scroll_update.delta_x = update.data.scroll_update.delta_y = 9;
  CHECK(filter.FilterGestureEvent(&update) == input::FilterGestureEventResult::kAllowed);
  CHECK_EQ(update.data.scroll_update.delta_x, 9);
  CHECK_EQ(update.data.scroll_update.delta_y, 9);
  filter.FilterGestureEvent(&end);
  filter.DecreaseActiveTouches();
  filter.ReportAndResetTouchAction();
}
}  // namespace
int main(int argc, char** argv) {
  base::AtExitManager at_exit;
  base::CommandLine::Init(argc, argv);
  TestClientInputTiming();
  {
    remotekit::browser::ClientGestureCandidateState candidates;
    CHECK(!candidates.LongPress());
    CHECK(candidates.Accept({{T::tap_down}}, true, false));
    CHECK(candidates.LongPress());
    CHECK(!candidates.LongPress());
    CHECK(!candidates.Accept({{T::tap}}, false, true));
    CHECK(!candidates.Accept({{T::scroll_begin, 1, 1, 0, 10}}, false, false));
    CHECK(candidates.Accept({{T::long_tap}}, false, true));
  }
  for (bool consumed : {false, true}) {
    Sink sink;
    ui::TouchDispositionGestureFilter filter(&sink);
    Packet(filter, 1, A::DOWN, {{T::tap_down}}, consumed, false);
    ui::GestureEventDetails details(E::kGestureLongPress);
    details.set_device_type(ui::GestureDeviceType::DEVICE_TOUCHSCREEN);
    details.set_primary_unique_touch_event_id(1);
    ui::GestureEventData gesture(details, 0, ui::MotionEvent::ToolType::FINGER,
                                 base::TimeTicks() + base::Milliseconds(1501), 100, 100, 100, 100,
                                 1, gfx::RectF(), 0, 1);
    CHECK_EQ(filter.OnGesturePacket(ui::GestureEventDataPacket::FromTouchTimeout(gesture)),
             ui::TouchDispositionGestureFilter::SUCCESS);
    CHECK(!sink.Has(E::kGestureLongPress));
    filter.OnTouchEventAck(1, consumed, true);
    CHECK_EQ(sink.Has(E::kGestureLongPress), !consumed);
    Packet(filter, 2, A::UP, {{T::long_tap}}, consumed);
    CHECK_EQ(sink.Has(E::kGestureLongTap), !consumed);
    CHECK(!sink.Has(E::kGestureTap));
  }
  {
    Sink sink;
    ui::TouchDispositionGestureFilter filter(&sink);
    filter.DisableScrollUpdateCompensation();
    Packet(filter, 1, A::DOWN, {{T::tap_down}}, false);
    Packet(filter, 2, A::MOVE,
           {{T::scroll_begin, 100, 100, 0, -10}, {T::scroll_update, 100, 90, 0, -10}}, false);
    Packet(filter, 3, A::MOVE, {{T::scroll_update, 100, 80, 0, -10}}, true);
    const auto updates = std::ranges::count_if(
        sink.events, [](const auto& e) { return e.type() == E::kGestureScrollUpdate; });
    CHECK_EQ(updates, 1);
    Packet(filter, 4, A::UP, {{T::fling_start, 100, 80, 0, 0, 1, 0, -1000}}, false);
    CHECK(!sink.Has(E::kScrollFlingStart));
    CHECK(sink.Has(E::kGestureScrollEnd));
    int teardown_count = 0, processed_count = 0;
    remotekit::browser::CompleteClientTouchAck(true, true, sink.Has(E::kScrollFlingStart),
                                               base::BindOnce(
                                                   [](int* teardown, int* processed) {
                                                     CHECK_EQ(*processed, 0);
                                                     ++*teardown;
                                                   },
                                                   &teardown_count, &processed_count),
                                               base::BindOnce(
                                                   [](int* teardown, int* processed) {
                                                     CHECK_EQ(*teardown, 1);
                                                     ++*processed;
                                                   },
                                                   &teardown_count, &processed_count));
    CHECK_EQ(teardown_count, 1);
    CHECK_EQ(processed_count, 1);
  }
  {
    Sink sink;
    ui::TouchDispositionGestureFilter filter(&sink);
    filter.DisableScrollUpdateCompensation();
    Packet(filter, 1, A::DOWN, {{T::tap_down}}, true);
    Packet(filter, 2, A::MOVE, {{T::scroll_begin}, {T::scroll_update, 0, 0, 0, -20}}, false);
    Packet(filter, 3, A::CANCEL, {}, false);
    CHECK(!sink.Has(E::kGestureScrollBegin));
    CHECK(!sink.Has(E::kGestureTapDown));
  }
  {
    Sink sink;
    ui::TouchDispositionGestureFilter filter(&sink);
    filter.DisableScrollUpdateCompensation();
    Packet(filter, 1, A::DOWN, {{T::tap_down}}, false);
    Packet(filter, 2, A::MOVE, {{T::scroll_begin}, {T::scroll_update, 0, 0, 0, -20}}, false);
    Packet(filter, 3, A::UP, {{T::fling_start, 0, 0, 0, 0, 1, 0, -1000}}, false);
    CHECK(sink.Has(E::kScrollFlingStart));
    CHECK(!sink.Has(E::kGestureScrollEnd));
    int teardown_count = 0, processed_count = 0;
    remotekit::browser::CompleteClientTouchAck(
        true, false, sink.Has(E::kScrollFlingStart),
        base::BindOnce([](int* count) { ++*count; }, &teardown_count),
        base::BindOnce([](int* count) { ++*count; }, &processed_count));
    CHECK_EQ(teardown_count, 0);
    CHECK_EQ(processed_count, 1);
  }
  {
    Sink sink;
    ui::TouchDispositionGestureFilter filter(&sink);
    Packet(filter, 1, A::DOWN, {{T::tap_down}}, false);
    Packet(filter, 2, A::UP, {{T::tap}}, false);
    CHECK(sink.Has(E::kGestureTap));
    // TDFilter synthesizes show-press by copying the production tap details.
    CHECK(sink.Has(E::kGestureShowPress));
  }
  {
    Sink sink;
    ui::TouchDispositionGestureFilter filter(&sink);
    filter.DisableScrollUpdateCompensation();
    Packet(filter, 1, A::DOWN, {{T::tap_down}}, false);
    Packet(filter, 2, A::MOVE,
           {{T::tap_cancel},
            {T::scroll_begin, 0, 0, 0, -10},
            {T::scroll_update, 0, 0, 0, -10},
            {T::pinch_begin},
            {T::pinch_update, 0, 0, 0, 0, 1.2f}},
           false);
    Packet(filter, 3, A::UP, {{T::pinch_end}, {T::scroll_end}}, false);
    for (auto type :
         {E::kGestureTapDown, E::kGestureTapCancel, E::kGestureScrollBegin, E::kGestureScrollUpdate,
          E::kGestureScrollEnd, E::kGesturePinchBegin, E::kGesturePinchUpdate, E::kGesturePinchEnd})
      CHECK(sink.Has(type));
  }
  {
    Sink sink;
    ui::TouchDispositionGestureFilter filter(&sink);
    filter.DisableScrollUpdateCompensation();
    Packet(filter, 1, A::DOWN, {{T::tap_down}}, false);
    Packet(filter, 2, A::CANCEL, {}, false);
    CHECK(sink.Has(E::kGestureTapCancel));  // No candidate: official repair.
    Packet(filter, 3, A::DOWN, {{T::tap_down}}, false);
    Packet(filter, 4, A::MOVE, {{T::scroll_begin, 0, 0, 0, -10}, {T::scroll_update, 0, 0, 0, -10}},
           false);
    Packet(filter, 5, A::CANCEL, {}, false);
    CHECK(sink.Has(E::kGestureScrollEnd));  // No candidate: official repair.
  }
  for (bool explicit_cancel : {false, true}) {
    Sink sink;
    ui::TouchDispositionGestureFilter filter(&sink);
    filter.DisableScrollUpdateCompensation();
    Packet(filter, 1, A::DOWN, {{T::tap_down}}, false);
    Packet(filter, 2, A::MOVE, {{T::scroll_begin, 0, 0, 0, -10}, {T::scroll_update, 0, 0, 0, -10}},
           false);
    Packet(filter, 3, A::UP, {{T::fling_start, 0, 0, 0, 0, 1, 0, -1000}}, false);
    CHECK(sink.Has(E::kScrollFlingStart));
    // Both the explicit candidate and new-sequence official repair reach Blink.
    Packet(filter, 4, A::DOWN,
           explicit_cancel ? std::vector<G>{{T::fling_cancel}, {T::tap_down}}
                           : std::vector<G>{{T::tap_down}},
           false);
    CHECK(sink.Has(E::kScrollFlingCancel));
    Packet(filter, 5, A::UP, {{T::tap}}, false);
  }
  {
    Sink sink;
    ui::TouchDispositionGestureFilter previous(&sink), next(&sink);
    Packet(previous, 1, A::DOWN, {{T::tap_down}}, false);
    Packet(previous, 2, A::UP, {{T::tap}}, false, false);
    Packet(next, 3, A::DOWN, {{T::tap_down}}, false, false);
    CHECK(!sink.Has(E::kGestureTap));
    previous.OnTouchEventAck(2, false, true);
    next.OnTouchEventAck(3, false, true);
    Packet(next, 4, A::UP, {{T::tap}}, false);
    CHECK_EQ(std::ranges::count_if(
                 sink.events, [](const auto& event) { return event.type() == E::kGestureTap; }),
             2);
    CHECK(!sink.Has(E::kGestureTapCancel));
  }
  {
    Sink sink;
    ui::TouchDispositionGestureFilter previous(&sink), next(&sink);
    Packet(previous, 1, A::DOWN, {{T::tap_down}}, false);
    Packet(previous, 2, A::CANCEL, {}, false);
    previous.Shutdown();
    Packet(next, 3, A::DOWN, {{T::tap_down}}, false);
    Packet(next, 4, A::UP, {{T::tap}}, false);
    CHECK_EQ(
        std::ranges::count_if(
            sink.events, [](const auto& event) { return event.type() == E::kGestureTapCancel; }),
        1);
    CHECK_EQ(std::ranges::count_if(
                 sink.events, [](const auto& event) { return event.type() == E::kGestureTap; }),
             1);
  }
  remotekit::browser::ClientGestureCandidateState state;
  CHECK(!state.Accept({{T::scroll_update}}, true, false));
  CHECK(state.Accept({{T::tap_down}}, true, false));
  CHECK(!state.Accept({{T::tap_down}}, false, false));
  // A rejected single-finger zero-hint begin does not mutate production state.
  CHECK(!state.Accept({{T::scroll_begin}}, false, false, 1));
  CHECK(!state.moved());
  CHECK(state.Accept({{T::scroll_begin}, {T::pinch_begin}}, false, false, 2));
  CHECK(!state.Accept({{T::fling_start}}, false, true));
  CHECK(state.Accept({{T::pinch_end}, {T::scroll_end}}, false, true));
  remotekit::browser::ClientGestureCandidateState single_scroll;
  CHECK(single_scroll.Accept({{T::tap_down}}, true, false));
  CHECK(single_scroll.Accept({{T::scroll_begin, 0, 0, -10, 0}}, false, false, 1));
  CHECK(single_scroll.Accept({{T::scroll_update, 0, 0, -10, 0}}, false, false, 1));
  CHECK(single_scroll.Accept({{T::scroll_end}}, false, true, 1));
  ui::PointerProperties first(100, 100, 1), second(200, 100, 1);
  first.id = 0;
  second.id = 1;
  first.tool_type = second.tool_type = ui::MotionEvent::ToolType::FINGER;
  ui::MotionEventGeneric two_fingers(A::MOVE, base::TimeTicks() + base::Seconds(1), first);
  two_fingers.PushPointer(second);
  const auto packet =
      remotekit::browser::MakeClientGesturePacket(two_fingers, {{T::scroll_begin}}, 1);
  CHECK_EQ(packet.gesture(0).details.touch_points(), 2);
  TestMomentumAction(cc::TouchAction::kPanX, true, false, 10, 0);
  TestMomentumAction(cc::TouchAction::kPanY, false, true, 0, 10);
  TestMomentumAction(cc::TouchAction::kNone, false, false, 10, 0);
  TestMomentumAction(cc::TouchAction::kNone, false, false, 0, -10);
  TestMomentumAction(cc::TouchAction::kNone, false, false, 10, -10);
  TestMomentumAction(cc::TouchAction::kNone, false, false, 0, 0, 2);
  TestMomentumAction(cc::TouchAction::kPanY | cc::TouchAction::kPinchZoom, false, true, 0, 10, 1,
                     true);
  return 0;
}
