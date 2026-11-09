#pragma once
#include <algorithm>
#include <cstdint>
namespace remotekit::protocol {
inline int PageViewportHeight(int stable_height, int occluded_bottom) {
  return std::clamp(stable_height - occluded_bottom, std::min(120, stable_height), stable_height);
}
struct PageViewport {
  int occluded_bottom = 0;
  uint64_t revision = 0;
  bool operator==(const PageViewport&) const = default;
};
}  // namespace remotekit::protocol
