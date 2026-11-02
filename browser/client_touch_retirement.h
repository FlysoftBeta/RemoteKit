#ifndef REMOTEKIT_BROWSER_CLIENT_TOUCH_RETIREMENT_H_
#define REMOTEKIT_BROWSER_CLIENT_TOUCH_RETIREMENT_H_
#include <deque>
#include <string>
#include "remotekit/core.hpp"
namespace remotekit::browser {
// Exact, bounded evidence of an owner explicitly retired by WebView. Unknown
// sequences and identities never acquire terminal semantics from absence.
class ClientTouchRetirement {
 public:
  void Retire(const InputToken& token, const std::string& sequence, bool owner_invalidated) {
    if (!owner_invalidated || sequence.empty() || Contains(token, sequence)) return;
    entries_.push_back({token, sequence});
    if (entries_.size() > 32) entries_.pop_front();
  }
  bool Contains(const InputToken& token, const std::string& sequence) const {
    for (const auto& entry : entries_)
      if (entry.first == token && entry.second == sequence) return true;
    return false;
  }
 private:
  std::deque<std::pair<InputToken, std::string>> entries_;
};
}
#endif
