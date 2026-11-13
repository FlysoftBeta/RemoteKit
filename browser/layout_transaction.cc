#include "browser/layout_transaction.h"
#include <algorithm>
#include <cmath>
#include "base/check.h"
#include "browser/offscreen_host.h"
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
  if (plan.width > 16384 || plan.height > 16384)
    return {{}, {ErrorCode::kLimitExceeded, "Output geometry exceeds supported bounds"}};
  if (plan.width < 16 || plan.height < 16 || !std::isfinite(plan.scale) || plan.scale < .5 ||
      plan.scale > 4 || (plan.alignment != 1 && plan.alignment != 16))
    return {{}, {ErrorCode::kInvalidRequest, "Invalid output geometry"}};
  std::vector<protocol::PackItem> items;
  for (const auto& [id, spec] : specs) {
    if (spec.width > 8192 || spec.height > 8192)
      return {{}, {ErrorCode::kLimitExceeded, "View geometry exceeds supported bounds"}};
    if (spec.width < 1 || spec.height < 1 ||
        (spec.page_dsf != 0 &&
         (!std::isfinite(spec.page_dsf) || spec.page_dsf < .5 || spec.page_dsf > 4)))
      return {{}, {ErrorCode::kInvalidRequest, "Invalid view geometry"}};
    const auto found = views_.records.find(id);
    if (found != views_.records.end()) {
      const auto& record = found->second;
      if (!record.requests->IsOpen() && spec != record.spec)
        return {{}, {ErrorCode::kConflict, "View is closing"}};
      if (spec.visible && (spec != record.spec || plan.scale != output_scale ||
                           plan.width != logical_width || plan.height != logical_height)) {
        if (!record.webview->contents() || record.webview->lifecycle_uncertain())
          return {{}, {ErrorCode::kConflict, "Restore required before showing view"}};
        const auto visible = record.webview->CanShow();
        if (!visible)
          return {{}, visible};
      }
    }
    if (spec.visible)
      items.push_back({id, spec.width, spec.height, 1.0});
  }
  auto atlas =
      protocol::PackAtlas(plan.width, plan.height, 4, protocol::OrderAtlasItems(std::move(items)));
  if (!atlas)
    return {{}, {atlas.error, atlas.message}};
  const auto dimensions =
      protocol::AtlasAllocationDimensions(plan.width, plan.height, plan.scale, plan.alignment);
  if (!dimensions)
    return {{}, {ErrorCode::kLimitExceeded, "Atlas resource budget exceeded"}};
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
    const auto found = std::ranges::find(plan.atlas.placements, id, &protocol::Placement::view);
    const bool visible = found != plan.atlas.placements.end();
    const auto placement =
        visible ? *found
                : protocol::Placement{id, {}, {0, 0, record.spec.width, record.spec.height}, 1.0};
    if (changed || record.placement.content != placement.content)
      record.webview->InvalidateLayoutInput(visible);
    CHECK(record.webview->SetVisible(visible));
    record.placement = placement;
    if (auto* host = record.webview->offscreen_host()) {
      host->SetPlaneSize(gfx::Size(record.spec.width, record.spec.height));
      host->SetOcclusionRevision(record.viewport.revision);
    }
    record.webview->ConfigureDevice(
        record.spec.width,
        protocol::PageViewportHeight(record.spec.height,
                                     visible ? record.viewport.occluded_bottom : 0),
        PageScale(record.spec));
  }
}
}  // namespace remotekit::browser
