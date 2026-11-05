#include "browser/layout_transaction.h"
#include <algorithm>
#include <cmath>
#include "base/check.h"
namespace remotekit::browser {
Result<LayoutPlan> LayoutTransaction::Prepare(ViewRegistry::Specifications specs,
                                              int width,
                                              int height,
                                              float scale,
                                              uint32_t alignment) const {
  LayoutPlan plan;
  plan.width = width ? width : logical_width;
  plan.height = height ? height : logical_height;
  plan.scale = scale ? scale : output_scale;
  plan.alignment = alignment ? alignment : allocation_alignment;
  if (plan.width < 16 || plan.width > 16384 || plan.height < 16 || plan.height > 16384 ||
      !std::isfinite(plan.scale) || plan.scale < .5 || plan.scale > 4 ||
      (plan.alignment != 1 && plan.alignment != 16))
    return {{}, {ErrorCode::invalid_request, "Invalid output geometry"}};
  std::vector<PackItem> items;
  for (const auto& [id, spec] : specs) {
    if (spec.width < 1 || spec.height < 1 || spec.width > 8192 || spec.height > 8192 ||
        (spec.page_dsf != 0 &&
         (!std::isfinite(spec.page_dsf) || spec.page_dsf < .5 || spec.page_dsf > 4)))
      return {{}, {ErrorCode::invalid_request, "Invalid view geometry"}};
    const auto found = views_.records.find(id);
    if (found != views_.records.end()) {
      const auto& record = found->second;
      if (record.requests->close_state() == "closing" && spec != record.spec)
        return {{}, {ErrorCode::busy, "View is closing"}};
      if (spec.visible && (spec != record.spec || plan.scale != output_scale ||
                           plan.width != logical_width || plan.height != logical_height)) {
        if (!record.webview->contents() || record.webview->lifecycle_uncertain())
          return {{}, {ErrorCode::unavailable, "Restore required before showing view"}};
        const auto visible = record.webview->CanShow();
        if (!visible)
          return {{}, visible};
      }
    }
    if (spec.visible)
      items.push_back({id, spec.width, spec.height, 1.0});
  }
  auto atlas = PackAtlas(plan.width, plan.height, 4, OrderAtlasItems(std::move(items)));
  if (!atlas)
    return {{}, atlas.status};
  const auto dimensions =
      AtlasAllocationDimensions(plan.width, plan.height, plan.scale, plan.alignment);
  if (!dimensions)
    return {{}, {ErrorCode::resource_limit, "Atlas resource budget exceeded"}};
  plan.specs = std::move(specs);
  plan.atlas = std::move(atlas.value);
  plan.output_width = dimensions->width;
  plan.output_height = dimensions->height;
  return {std::move(plan), {}};
}
void LayoutTransaction::Commit(LayoutPlan plan) {
  const bool changed = logical_width != plan.width || logical_height != plan.height ||
                       output_scale != plan.scale || views_.Specs() != plan.specs;
  views_.SetSpecs(std::move(plan.specs));
  logical_width = plan.width;
  logical_height = plan.height;
  output_scale = plan.scale;
  allocation_alignment = plan.alignment;
  output_width = plan.output_width;
  output_height = plan.output_height;
  for (auto& [id, record] : views_.records) {
    const auto found = std::ranges::find(plan.atlas.placements, id, &Placement::view);
    const bool visible = found != plan.atlas.placements.end();
    const auto placement =
        visible ? *found : Placement{id, {}, {0, 0, record.spec.width, record.spec.height}, 1.0};
    if (changed || record.placement.content != placement.content)
      record.webview->InvalidateLayoutInput(visible);
    CHECK(record.webview->SetVisible(visible));
    record.placement = placement;
    record.webview->ConfigureDevice(record.spec.width, record.spec.height, PageScale(record.spec));
  }
}
}  // namespace remotekit::browser
