#pragma once
#include <optional>
#include "protocol/render_slots.h"

namespace remotekit::browser::osr {
// Demand predicts future work; it cannot invalidate pixels already retained
// for this layout. Only missing pixels/configuration justify NotReady.
constexpr std::optional<RenderRejectReason> CachedWorkReject(
    bool missing, bool updated, bool forced, bool same_revision) {
  if (missing && !updated)
    return RenderRejectReason::kNotReady;
  if (!updated && !forced && same_revision)
    return RenderRejectReason::kIdle;
  return std::nullopt;
}
}  // namespace remotekit::browser::osr
