#pragma once
#include "atlas_dimensions.hpp"
#include "control.h"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <optional>
#include <set>
#include <tuple>
#include <utility>
#include <vector>
namespace remotekit::protocol {
struct PixelRect {
  int x{}, y{}, width{}, height{};
  bool operator==(const PixelRect&) const = default;
};
struct PackItem {
  std::uint64_t view{};
  int width{}, height{};
  double scale{1.0};
};
struct Placement {
  std::uint64_t view{};
  PixelRect outer, content;
  double scale{1.0};
};
struct Atlas {
  int width{}, height{}, padding{};
  std::vector<Placement> placements;
};
struct AtlasPackResult {
  Atlas value;
  std::optional<ErrorCode> error;
  const char* message = "";
  explicit operator bool() const { return !error; }
};
namespace atlas_detail {
inline bool Intersects(const PixelRect& a, const PixelRect& b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
inline bool Contains(const PixelRect& a, const PixelRect& b) {
  return a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width &&
         a.y + a.height >= b.y + b.height;
}
}  // namespace atlas_detail
inline std::vector<PackItem> OrderAtlasItems(std::vector<PackItem> items) {
  std::stable_sort(items.begin(), items.end(), [](const auto& a, const auto& b) {
    return std::pair(a.width, a.height) > std::pair(b.width, b.height);
  });
  return items;
}
// Input order is preserved; best-short-side MaxRects scoring has deterministic ties.
// Dimensions are content pixels; padding is reserved on all four sides. No rotation.
inline AtlasPackResult PackAtlas(int width,
                                 int height,
                                 int padding,
                                 const std::vector<PackItem>& items) {
  if (width <= 0 || height <= 0 || padding < 0)
    return {{}, ErrorCode::kInvalidRequest, "Invalid atlas bounds"};
  Atlas atlas{width, height, padding, {}};
  std::vector<PixelRect> free{{0, 0, width, height}};
  std::set<std::uint64_t> ids;
  for (const auto& item : items) {
    if (!ids.insert(item.view).second || item.width <= 0 || item.height <= 0 ||
        !std::isfinite(item.scale) || item.scale <= 0)
      return {{}, ErrorCode::kInvalidRequest, "Invalid or duplicate pack item"};
    const auto wide = static_cast<std::int64_t>(item.width) + 2LL * padding,
               high = static_cast<std::int64_t>(item.height) + 2LL * padding;
    if (wide > width || high > height)
      return {{}, ErrorCode::kLimitExceeded, "Item exceeds atlas bounds"};
    int w = static_cast<int>(wide), h = static_cast<int>(high);
    std::optional<PixelRect> chosen;
    auto best = std::tuple{std::numeric_limits<int>::max(), std::numeric_limits<int>::max(),
                           std::numeric_limits<int>::max(), std::numeric_limits<int>::max()};
    for (const auto& f : free)
      if (w <= f.width && h <= f.height) {
        auto score = std::tuple{std::min(f.width - w, f.height - h),
                                std::max(f.width - w, f.height - h), f.y, f.x};
        if (score < best) {
          best = score;
          chosen = PixelRect{f.x, f.y, w, h};
        }
      }
    if (!chosen)
      return {{}, ErrorCode::kLimitExceeded, "Atlas packing failed"};
    const auto used = *chosen;
    std::vector<PixelRect> next;
    for (const auto& f : free) {
      if (!atlas_detail::Intersects(f, used)) {
        next.push_back(f);
        continue;
      }
      if (used.x > f.x)
        next.push_back({f.x, f.y, used.x - f.x, f.height});
      if (used.x + used.width < f.x + f.width)
        next.push_back({used.x + used.width, f.y, f.x + f.width - used.x - used.width, f.height});
      if (used.y > f.y)
        next.push_back({f.x, f.y, f.width, used.y - f.y});
      if (used.y + used.height < f.y + f.height)
        next.push_back({f.x, used.y + used.height, f.width, f.y + f.height - used.y - used.height});
    }
    free.clear();
    for (std::size_t i = 0; i < next.size(); ++i) {
      bool redundant = false;
      for (std::size_t j = 0; j < next.size(); ++j)
        if (i != j && atlas_detail::Contains(next[j], next[i]) && (next[j] != next[i] || j < i)) {
          redundant = true;
          break;
        }
      if (!redundant)
        free.push_back(next[i]);
    }
    atlas.placements.push_back({item.view,
                                used,
                                {used.x + padding, used.y + padding, item.width, item.height},
                                item.scale});
  }
  return {std::move(atlas)};
}
struct AtlasPlan {
  int width = 16, height = 16;
  float scale = 1;
  AtlasDimensions physical;
};
// Search subset-sum widths; MaxRects establishes actual feasibility. Logical
// bounds and physical allocation bounds are intentionally separate.
inline std::optional<AtlasPlan> PlanAtlas(const std::vector<PackItem>& input,
                                          float scale,
                                          uint32_t alignment = 1) {
  if (!std::isfinite(scale) || scale < .5f || scale > 4 || (alignment != 1 && alignment != 16))
    return std::nullopt;
  auto items = OrderAtlasItems(input);
  std::set<int> widths{0};
  int total_height = 0;
  for (const auto& item : items) {
    if (item.width < 1 || item.height < 1 || item.width > 8192 || item.height > 8192)
      return std::nullopt;
    std::vector<int> add;
    for (int width : widths)
      if (width + item.width + 8 <= 16384)
        add.push_back(width + item.width + 8);
    widths.insert(add.begin(), add.end());
    total_height = std::min(16384, total_height + item.height + 8);
  }
  if (items.empty()) {
    auto physical = AtlasAllocationDimensions(16, 16, scale, alignment);
    if (!physical)
      return std::nullopt;
    return AtlasPlan{16, 16, scale, *physical};
  }
  std::optional<AtlasPlan> best;
  const auto rank = [](const AtlasPlan& p) {
    return std::tuple(uint64_t(p.physical.width) * p.physical.height,
                      std::max(p.physical.width, p.physical.height), p.width, p.height);
  };
  for (int width : widths) {
    if (width < 16)
      width = 16;
    auto strip = AtlasAllocationDimensions(width, 16, scale, alignment);
    if (!strip)
      continue;
    const auto a = std::max(2u, alignment);
    const auto physical_height = std::min(8192u, 16777216u / strip->width) / a * a;
    int height = std::min(total_height,
                          std::min(16384, static_cast<int>(std::floor(physical_height / scale))));
    height = std::max(16, height);
    while (height >= 16 && !AtlasAllocationDimensions(width, height, scale, alignment))
      --height;
    if (height < 16)
      continue;
    auto packed = PackAtlas(width, height, 4, items);
    if (!packed)
      continue;
    int crop_width = 16, crop_height = 16;
    for (const auto& placement : packed.value.placements) {
      crop_width = std::max(crop_width, placement.outer.x + placement.outer.width);
      crop_height = std::max(crop_height, placement.outer.y + placement.outer.height);
    }
    if (PackAtlas(crop_width, crop_height, 4, items)) {
      width = crop_width;
      height = crop_height;
    }
    auto physical = AtlasAllocationDimensions(width, height, scale, alignment);
    if (!physical)
      continue;
    AtlasPlan candidate{width, height, scale, *physical};
    if (!best || rank(candidate) < rank(*best))
      best = candidate;
  }
  return best;
}
}  // namespace remotekit::protocol
