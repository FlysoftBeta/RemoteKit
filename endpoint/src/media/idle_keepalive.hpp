#pragma once
#include <cstdint>

namespace remotekit {
class IdleKeepalive {
 public:
  explicit IdleKeepalive(int64_t frequency) : period_(frequency * 5 / 2) {}
  bool Due(int64_t now, int64_t last_encoded, bool tail_pending) const {
    return last_encoded && !tail_pending && now >= next_ && now - last_encoded >= period_;
  }
  void Sent(int64_t now) { next_ = now + period_; }

 private:
  int64_t period_, next_ = 0;
};
}  // namespace remotekit
