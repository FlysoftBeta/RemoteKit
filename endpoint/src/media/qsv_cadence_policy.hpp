#pragma once

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <optional>

namespace remotekit::media {

// Filters WebRTC's measured input FPS before it can change the H.264 timebase.
class QsvCadencePolicy {
 public:
  using TimePoint = std::chrono::steady_clock::time_point;

  explicit QsvCadencePolicy(uint32_t ceiling) : ceiling_(ceiling) {}

  std::optional<TimePoint> Deadline() const {
    return low_since_ ? std::optional(*low_since_ + std::chrono::seconds(1)) : std::nullopt;
  }
  void Cancel() { low_since_.reset(); }

  uint32_t Select(uint32_t current, uint32_t observed, TimePoint now) {
    if (!observed)
      return current;
    observed = std::min(observed, ceiling_);
    if (uint64_t{observed} * 5 < uint64_t{current} * 4) {
      if (!low_since_) {
        low_since_ = now;
        max_low_fps_ = observed;
      }
      max_low_fps_ = std::max(max_low_fps_, observed);
      if (now - *low_since_ < std::chrono::seconds(1))
        return current;
      const auto selected = max_low_fps_;
      low_since_.reset();
      // The window can include an earlier, higher cadence. If its final
      // observation is still substantially lower, schedule the next window
      // even when WebRTC will not repeat an identical report.
      if (uint64_t{observed} * 5 < uint64_t{selected} * 4) {
        low_since_ = now;
        max_low_fps_ = observed;
      }
      return selected;
    }

    low_since_.reset();
    if (uint64_t{observed} * 4 > uint64_t{current} * 5)
      return ceiling_;
    return current;
  }

 private:
  uint32_t ceiling_;
  std::optional<TimePoint> low_since_;
  uint32_t max_low_fps_ = 0;
};

}  // namespace remotekit::media
