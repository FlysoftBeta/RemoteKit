#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <optional>
namespace remotekit::protocol {
struct AtlasDimensions {
  uint32_t width = 0, height = 0;
};
// Alignment 1 preserves the existing even-pixel allocation. Alignment 16 adds
// physical allocation padding without changing viewport DIP or plane geometry.
inline std::optional<AtlasDimensions> AtlasAllocationDimensions(int width,
                                                                int height,
                                                                float scale,
                                                                uint32_t alignment = 1) {
  if (width < 1 || height < 1 || width > 16384 || height > 16384 || !std::isfinite(scale) ||
      scale < .5f || scale > 4 || (alignment != 1 && alignment != 16))
    return std::nullopt;
  const uint32_t physical_alignment = std::max(2u, alignment);
  const auto align = [&](int logical) {
    const auto pixels = static_cast<uint32_t>(std::ceil(logical * scale));
    return (pixels + physical_alignment - 1) / physical_alignment * physical_alignment;
  };
  AtlasDimensions result{align(width), align(height)};
  if (result.width > 8192 || result.height > 8192 ||
      uint64_t(result.width) * result.height > 16777216)
    return std::nullopt;
  return result;
}
}  // namespace remotekit::protocol
