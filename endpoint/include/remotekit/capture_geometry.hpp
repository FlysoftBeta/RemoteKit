#pragma once
#include <cstdint>
#include <optional>

namespace remotekit {
// A first-geometry grace period belongs to one capturer binding, not its view.
// All timestamps use the caller's monotonic microsecond clock.
class CaptureGeometryWait {
 public:
  static constexpr int64_t kLimitUs = 2000000;
  void Bind(uint64_t binding) { binding_ = binding; bound_ = true; matched_ = false; first_.reset(); pending_ = false; }
  void Stop() { bound_ = false; first_.reset(); pending_ = false; }
  bool TimedOut(int64_t now) const { return bound_ && !matched_ && first_ && now - *first_ >= kLimitUs; }
  bool Defer(int64_t now) {
    if (!bound_ || matched_) return false;
    if (!first_) first_ = now;
    return !TimedOut(now);
  }
  bool Match(int64_t now) {
    if (!bound_ || TimedOut(now)) return false;
    matched_ = true; first_.reset(); pending_ = false; return true;
  }
  std::optional<uint64_t> QueueRefresh() {
    if (!bound_ || matched_ || !first_ || pending_) return {};
    pending_ = true; return binding_;
  }
  bool TakeRefresh(uint64_t binding, int64_t now) {
    if (!bound_ || binding_ != binding || !pending_ || matched_ || TimedOut(now)) return false;
    pending_ = false; return true;
  }
 private:
  uint64_t binding_ = 0;
  bool bound_ = false, matched_ = false, pending_ = false;
  std::optional<int64_t> first_;
};
}
