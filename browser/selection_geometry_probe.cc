#include "browser/selection_geometry.h"

#include <cstdio>
#include "base/at_exit.h"
#include "base/check.h"
#include "ui/events/velocity_tracker/motion_event_generic.h"

namespace {
class Drawable final : public ui::TouchHandleDrawable {
 public:
  void SetEnabled(bool) override {}
  void SetOrientation(ui::TouchHandleOrientation, bool, bool) override {}
  void SetOrigin(const gfx::PointF& point) override { origin = point; }
  void SetAlpha(float) override {}
  gfx::RectF GetVisibleBounds() const override { return gfx::RectF(origin, gfx::SizeF(24, 24)); }
  float GetDrawableHorizontalPaddingRatio() const override { return 0; }
  gfx::PointF origin;
};
class Client final : public ui::TouchSelectionControllerClient {
 public:
  bool SupportsAnimation() const override { return false; }
  void SetNeedsAnimate() override {}
  void MoveCaret(const gfx::PointF& point) override { caret = point; }
  void MoveRangeSelectionExtent(const gfx::PointF& point) override { extent = point; }
  void SelectBetweenCoordinates(const gfx::PointF& a, const gfx::PointF& b) override {
    base = a;
    extent = b;
  }
  void OnSelectionEvent(ui::SelectionEventType) override {}
  void OnDragUpdate(ui::TouchSelectionDraggable::Type, const gfx::PointF&) override {}
  std::unique_ptr<ui::TouchHandleDrawable> CreateDrawable() override {
    return std::make_unique<Drawable>();
  }
  void DidScroll() override {}
  gfx::PointF base, extent, caret;
};
gfx::SelectionBound Bound(gfx::SelectionBound::Type type, float x) {
  gfx::SelectionBound bound;
  bound.SetEdge(gfx::PointF(x, 20), gfx::PointF(x, 40));
  bound.SetVisibleEdge(gfx::PointF(x, 20), gfx::PointF(x, 40));
  bound.set_type(type);
  bound.set_visible(true);
  return bound;
}
}  // namespace
int main() {
  base::AtExitManager exit;
  using namespace remotekit::browser;
  using remotekit::SelectionExtent;
  Client client;
  ui::TouchSelectionController controller(&client, {});
  controller.OnViewportChanged(gfx::RectF(0, 0, 400, 400));
  controller.WillHandleTouchEvent(ui::MotionEventGeneric(
      ui::MotionEvent::Action::DOWN, base::TimeTicks::Now(), ui::PointerProperties(0, 0, 1)));
  controller.HandleLongPressEvent(base::TimeTicks::Now(), gfx::PointF(50, 30));
  controller.OnSelectionBoundsChanged(Bound(gfx::SelectionBound::LEFT, 40),
                                      Bound(gfx::SelectionBound::RIGHT, 100));
  remotekit::SharedAtlasSelectionMenu state{};
  ReadSelectionHandles(controller, state);
  CHECK(state.start.visible && state.end.visible && !state.insertion.visible);
  CHECK(state.start.x == 40 && state.end.x == 100 && state.start.y == 40 &&
        state.start.line_height == 20);
  CHECK(MoveSelectionExtent(controller, client, {SelectionExtent::Which::start, 25, 30}));
  CHECK(client.base == gfx::PointF(100, 30) && client.extent == gfx::PointF(25, 30));
  CHECK(MoveSelectionExtent(controller, client, {SelectionExtent::Which::end, 150, 30}));
  CHECK(client.base == gfx::PointF(40, 30) && client.extent == gfx::PointF(150, 30));
  controller.OnSelectionBoundsChanged(Bound(gfx::SelectionBound::CENTER, 80),
                                      Bound(gfx::SelectionBound::CENTER, 80));
  state = {};
  ReadSelectionHandles(controller, state);
  CHECK(state.insertion.visible && !state.start.visible && !state.end.visible);
  CHECK(MoveSelectionExtent(controller, client, {SelectionExtent::Which::insertion, 90, 30}));
  CHECK(client.caret == gfx::PointF(90, 30));
  controller.HideAndDisallowShowingAutomatically();
  state = {};
  ReadSelectionHandles(controller, state);
  CHECK(!state.insertion.visible && !state.start.visible && !state.end.visible);
  CHECK(!MoveSelectionExtent(controller, client, {SelectionExtent::Which::end, 90, 30}));
  puts("Selection geometry and extent probe passed");
}
