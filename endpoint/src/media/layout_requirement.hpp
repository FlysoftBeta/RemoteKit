#pragma once
#include "protocol/shared_render_slots.h"
#include <map>

namespace remotekit::media {
struct LayoutRequirement {
  uint32_t revision = 0;
  std::map<uint64_t, uint64_t> viewports;
  bool Matches(const SharedAtlasFrame& frame,
               uint64_t generation,
               bool require_viewport = true) const {
    if (frame.generation != generation || frame.layout_revision != revision ||
        frame.view_count != viewports.size())
      return false;
    for (uint32_t i = 0; i < frame.view_count; ++i) {
      const auto& view = frame.views[i];
      const auto found = viewports.find(view.webview_id);
      if (found == viewports.end() ||
          (require_viewport && view.occlusion_revision < found->second) ||
          (view.reserved & kSharedAtlasViewStale))
        return false;
    }
    return true;
  }
};
}  // namespace remotekit::media
