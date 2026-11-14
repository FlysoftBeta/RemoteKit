#pragma once
#include "util/retry_clock.hpp"

namespace remotekit {
class NativeRetryClock {
 public:
  NativeRetryClock()
      : previous_(RetryClock::read_.exchange(Read)),
        previous_sleep_(RetryClock::sleep_.exchange(Sleep)),
        previous_wait_(RetryClock::wait_.exchange(Wait)) {
    ticks_ = std::chrono::steady_clock::now().time_since_epoch().count();
  }
  ~NativeRetryClock() {
    RetryClock::read_ = previous_;
    RetryClock::sleep_ = previous_sleep_;
    RetryClock::wait_ = previous_wait_;
  }
  void Set(RetryClock::time_point time) { ticks_ = time.time_since_epoch().count(); }
  void Advance(std::chrono::milliseconds delay) { Set(Read() + delay); }

 private:
  static RetryClock::time_point Read() {
    return RetryClock::time_point(RetryClock::duration(ticks_.load()));
  }
  static void Sleep(std::chrono::milliseconds delay) {
    ticks_.fetch_add(std::chrono::duration_cast<RetryClock::duration>(delay).count());
  }
  static void Wait(RetryClock::time_point until) {
    auto current = ticks_.load();
    const auto target = until.time_since_epoch().count();
    while (current < target && !ticks_.compare_exchange_weak(current, target)) {
    }
  }
  inline static std::atomic<RetryClock::rep> ticks_{0};
  RetryClock::Read previous_;
  RetryClock::Sleeper previous_sleep_;
  RetryClock::Waiter previous_wait_;
};
}  // namespace remotekit
