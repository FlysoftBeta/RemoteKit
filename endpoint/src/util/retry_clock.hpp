#pragma once
#include <atomic>
#include <chrono>
#include <thread>

namespace remotekit {
class NativeRetryClock;
class RetryClock : public std::chrono::steady_clock {
 public:
  static time_point now() noexcept { return read_.load()(); }
  static void Sleep(std::chrono::milliseconds delay) { sleep_.load()(delay); }
  static void WaitUntil(time_point until) { wait_.load()(until); }

 private:
  friend class NativeRetryClock;
  using Read = time_point (*)();
  inline static std::atomic<Read> read_{std::chrono::steady_clock::now};
  using Sleeper = void (*)(std::chrono::milliseconds);
  using Waiter = void (*)(time_point);
  inline static std::atomic<Waiter> wait_{
      [](time_point until) { std::this_thread::sleep_until(until); }};
  inline static std::atomic<Sleeper> sleep_{
      [](std::chrono::milliseconds delay) { std::this_thread::sleep_for(delay); }};
};
}  // namespace remotekit
