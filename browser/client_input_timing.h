#ifndef REMOTEKIT_BROWSER_CLIENT_INPUT_TIMING_H_
#define REMOTEKIT_BROWSER_CLIENT_INPUT_TIMING_H_

#include <algorithm>
#include <cstdint>

namespace remotekit::browser {
// Native dispatch time and Client source time have different jobs. A delayed
// first packet can put origin + source elapsed ahead of the Browser clock.
// Share this clock across raw dispatch and ACK-released gesture dispatch.
template <typename Timestamp>
class ClientNativeInputClock {
 public:
  ClientNativeInputClock(Timestamp origin, Timestamp now)
      : last_(std::min(origin, now)) {}

  Timestamp Dispatch(Timestamp sampled, Timestamp now) {
    last_ = std::min(now, std::max(last_, sampled));
    return last_;
  }

 private:
  Timestamp last_;
};

// Never derive these values from clamped Native timestamps. In particular, a
// future-clamped up must not shorten the Client's five-second momentum window.
class ClientGestureSourceTime {
 public:
  bool Raw(std::int64_t elapsed, bool terminal) {
    if (elapsed < last_) return false;
    last_ = elapsed;
    if (terminal) up_ = elapsed;
    return true;
  }
  bool Momentum(std::int64_t elapsed) {
    if (elapsed < last_ || elapsed < up_ || elapsed - up_ > 5000000)
      return false;
    last_ = elapsed;
    return true;
  }
  std::int64_t last() const { return last_; }

 private:
  std::int64_t last_{};
  std::int64_t up_{};
};
}  // namespace remotekit::browser
#endif
