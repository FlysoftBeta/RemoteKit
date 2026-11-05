#ifndef REMOTEKIT_BROWSER_CLIENT_TOUCH_RETIREMENT_H_
#define REMOTEKIT_BROWSER_CLIENT_TOUCH_RETIREMENT_H_
#include <deque>
#include <algorithm>
#include <string>
#include "remotekit/core.hpp"
namespace remotekit::browser {
// Exact, bounded evidence of an owner explicitly retired by WebView. Unknown
// sequences and identities never acquire terminal semantics from absence.
class ClientTouchRetirement {
 public:
  enum class State { unknown, pending, processed, invalidated, unconfirmed };
  static constexpr size_t kCapacity = 64;

  State Find(const InputToken& token, const std::string& sequence) const {
    for (const auto& entry : entries_)
      if (entry.token == token && entry.sequence == sequence)
        return entry.state;
    return State::unknown;
  }
  void Begin(const InputToken& token, const std::string& sequence) {
    if (Find(token, sequence) == State::unknown)
      Add(token, sequence, State::pending);
  }
  void Resolve(const InputToken& token, const std::string& sequence, State state) {
    for (auto entry = entries_.begin(); entry != entries_.end(); ++entry) {
      if (entry->token != token || entry->sequence != sequence)
        continue;
      if (entry->state != state &&
          (entry->state == State::pending || entry->state == State::unconfirmed)) {
        // A long-running pending receipt may be older than the history it
        // outlived. Keep the settled receipt by its completion time.
        Entry updated = std::move(*entry);
        updated.state = state;
        entries_.erase(entry);
        entries_.push_back(std::move(updated));
      }
      return;
    }
  }
  void Retire(const InputToken& token, const std::string& sequence, bool owner_invalidated) {
    if (!owner_invalidated || sequence.empty())
      return;
    if (Find(token, sequence) == State::unknown)
      Add(token, sequence, State::invalidated);
    else
      Resolve(token, sequence, State::invalidated);
  }
  bool Contains(const InputToken& token, const std::string& sequence) const {
    return Find(token, sequence) == State::invalidated;
  }

 private:
  struct Entry {
    InputToken token;
    std::string sequence;
    State state;
  };
  void Add(const InputToken& token, const std::string& sequence, State state) {
    if (entries_.size() == kCapacity) {
      // A WebView admits at most one physical terminal awaiting raw ACKs.
      // Evict settled history before an outstanding record.
      auto settled = std::find_if(entries_.begin(), entries_.end(),
                                  [](const Entry& entry) { return entry.state != State::pending; });
      if (settled == entries_.end())
        return;
      entries_.erase(settled);
    }
    entries_.push_back({token, sequence, state});
  }
  std::deque<Entry> entries_;
};
}  // namespace remotekit::browser
#endif
