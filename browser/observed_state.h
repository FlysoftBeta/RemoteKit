#ifndef REMOTEKIT_BROWSER_OBSERVED_STATE_H_
#define REMOTEKIT_BROWSER_OBSERVED_STATE_H_

#include <cstdint>

#include "base/functional/callback.h"

namespace remotekit::browser {

// UI-sequence only. The Browser keeps one monotonically increasing revision of the state a
// Control snapshot observes. Every change bumps it and, unless a wake is already queued, queues
// one wake for the consumer: latest-value, leading, at most one pending. The consumer still
// takes snapshots, so a lost wake only delays the change to its next sample.
class ObservedState final {
 public:
  using Notifier = base::RepeatingCallback<void(std::uint64_t revision)>;
  // A null notifier stops wakes; revisions still advance.
  static void SetNotifier(Notifier notifier);
  static void Changed();
  static std::uint64_t revision();
};

}  // namespace remotekit::browser

#endif
