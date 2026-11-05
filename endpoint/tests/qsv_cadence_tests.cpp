#include "media/qsv_cadence_policy.hpp"

#include <cstdlib>
#include <iostream>

#define CHECK(x)                                    \
  do {                                              \
    if (!(x)) {                                     \
      std::cerr << __LINE__ << " failed: " #x "\n"; \
      std::exit(1);                                 \
    }                                               \
  } while (false)

int main() {
  using remotekit::media::QsvCadencePolicy;
  using namespace std::chrono_literals;
  const QsvCadencePolicy::TimePoint start{};
  QsvCadencePolicy policy(60);
  uint32_t nominal = 60;
  const auto observe = [&](uint32_t observed, QsvCadencePolicy::TimePoint time) {
    nominal = policy.Select(nominal, observed, time);
    return nominal;
  };
  auto time = start;
  for (uint32_t observed : {60, 64, 61, 60, 58, 59}) {
    CHECK(observe(observed, time) == 60);
    time += 100ms;
  }
  CHECK(observe(2, start + 1s) == 60);
  CHECK(policy.Deadline() == start + 2s);
  CHECK(observe(1, start + 1999ms) == 60);
  CHECK(observe(2, start + 2s) == 2);
  CHECK(!policy.Deadline());
  CHECK(observe(2, start + 2100ms) == 2);
  CHECK(observe(6, start + 2200ms) == 60);
  CHECK(observe(30, start + 2300ms) == 60);
  CHECK(observe(60, start + 2400ms) == 60);

  CHECK(observe(10, start + 3s) == 60);
  CHECK(observe(48, start + 3900ms) == 60);  // Exact lower boundary clears the window.
  CHECK(observe(15, start + 4s) == 60);
  CHECK(observe(15, start + 4100ms) == 60);
  CHECK(observe(15, start + 4999ms) == 60);
  CHECK(observe(15, start + 5s) == 15);
  CHECK(observe(15, start + 5500ms) == 15);
  CHECK(observe(0, start + 8s) == 15);  // A zero target is not a low FPS sample.
  CHECK(observe(15, start + 9s) == 15);

  QsvCadencePolicy limits(50);
  CHECK(limits.Select(20, 25, start) == 20);  // Exact upper boundary does not restore.
  CHECK(limits.Select(20, 26, start + 1ms) == 50);
  CHECK(limits.Select(20, UINT32_MAX, start + 2ms) == 50);
  CHECK(limits.Select(20, 15, start + 1s) == 20);
  CHECK(limits.Select(20, 4, start + 2s) == 15);  // Use the highest low observation.
  CHECK(limits.Deadline() == start + 3s);
  CHECK(limits.Select(15, 4, *limits.Deadline()) == 4);
  CHECK(!limits.Deadline());
  CHECK(limits.Select(50, 2, start + 3s) == 50);
  limits.Cancel();
  CHECK(!limits.Deadline());
  CHECK(limits.Select(50, 2, start + 5s) == 50);
  CHECK(limits.Deadline() == start + 6s);
  // A single low report is sufficient: the owner can apply it at the deadline
  // even if WebRTC deduplicates all subsequent rate reports.
  CHECK(limits.Select(50, 2, *limits.Deadline()) == 2);
  std::cout << "QSV cadence policy tests passed\n";
}
