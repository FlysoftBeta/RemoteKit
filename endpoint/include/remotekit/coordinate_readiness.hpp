#pragma once
#include <cstdint>
#include <map>
#include <mutex>
#include <string>
#include <utility>

namespace remotekit {
// The media owner publishes one epoch/readiness snapshot. Input threads never
// read its mutable JSON layout or infer readiness from a different epoch.
class CoordinateReadiness {
 public:
  void Set(uint64_t epoch, std::map<std::string, bool> views) {
    std::lock_guard lock(mutex_);
    epoch_ = epoch;
    views_ = std::move(views);
  }
  void Clear() {
    std::lock_guard lock(mutex_);
    epoch_ = 0;
    views_.clear();
  }
  bool Allows(const std::string& view, uint64_t epoch) const {
    std::lock_guard lock(mutex_);
    auto found = views_.find(view);
    return epoch_ == epoch && found != views_.end() && found->second;
  }

 private:
  mutable std::mutex mutex_;
  uint64_t epoch_ = 0;
  std::map<std::string, bool> views_;
};
}  // namespace remotekit
