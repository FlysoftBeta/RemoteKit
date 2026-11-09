#pragma once

#include <cmath>

#include "browser/view_model.h"
#include "protocol/shared_render_slots.h"
#include "ui/touch_selection/touch_selection_controller.h"

namespace remotekit::browser {
inline void ReadSelectionHandles(const ui::TouchSelectionController& controller,
                                 SharedAtlasSelectionMenu& state) {
  const auto handle = [](const gfx::SelectionBound& bound, bool visible) {
    return SharedAtlasSelectionMenu::Handle{bound.edge_end().x(), bound.edge_end().y(),
                                            std::abs(bound.edge_end().y() - bound.edge_start().y()),
                                            visible ? 1u : 0u};
  };
  using Active = ui::TouchSelectionController::ActiveStatus;
  if (controller.active_status() == Active::kSelectionActive) {
    state.start = handle(controller.start(), !controller.GetStartHandleRect().IsEmpty());
    state.end = handle(controller.end(), !controller.GetEndHandleRect().IsEmpty());
  } else if (controller.active_status() == Active::kInsertionActive) {
    state.insertion = handle(controller.start(), !controller.GetStartHandleRect().IsEmpty());
  }
}

inline bool MoveSelectionExtent(ui::TouchSelectionController& controller,
                                ui::TouchSelectionControllerClient& client,
                                const SelectionExtent& extent) {
  using Active = ui::TouchSelectionController::ActiveStatus;
  const gfx::PointF point(extent.x, extent.y);
  if (extent.which == SelectionExtent::Which::insertion) {
    if (controller.active_status() != Active::kInsertionActive)
      return false;
    client.MoveCaret(point);
    return true;
  }
  if (controller.active_status() != Active::kSelectionActive)
    return false;
  const auto& fixed =
      extent.which == SelectionExtent::Which::start ? controller.end() : controller.start();
  client.SelectBetweenCoordinates(gfx::PointF((fixed.edge_start().x() + fixed.edge_end().x()) / 2,
                                              (fixed.edge_start().y() + fixed.edge_end().y()) / 2),
                                  point);
  return true;
}
}  // namespace remotekit::browser
