#pragma once

#include <cstdint>
#include <map>
#include <utility>

namespace remotekit::browser {

// Numbers each view's selection presentation (touch handles and quick menu
// together). A presentation gets a new revision when it appears or when its menu
// or handle kind changes, and loses it when it disappears. A dismissal that
// names a revision therefore cannot close a presentation opened after the
// Viewer last saw the state.
class SelectionRevisionTracker {
 public:
  struct Presentation {
    bool active{};
    std::uint64_t menu_id{};
    bool insertion{};
  };
  using ViewKey = std::pair<std::uint64_t, std::uint64_t>;

  // Returns the view's current revision; 0 when there is no presentation.
  std::uint64_t Observe(ViewKey view, const Presentation& now) {
    if (!now.active) {
      views_.erase(view);
      return 0;
    }
    auto& entry = views_[view];
    if (!entry.revision || entry.menu_id != now.menu_id || entry.insertion != now.insertion) {
      entry = {++last_, now.menu_id, now.insertion};
    }
    return entry.revision;
  }

  void Forget(std::uint64_t session, std::uint64_t view_id) {
    for (auto it = views_.begin(); it != views_.end();) {
      if (it->first.first == session && (!view_id || it->first.second == view_id))
        it = views_.erase(it);
      else
        ++it;
    }
  }

 private:
  struct Entry {
    std::uint64_t revision{};
    std::uint64_t menu_id{};
    bool insertion{};
  };
  std::map<ViewKey, Entry> views_;
  std::uint64_t last_{};
};

}  // namespace remotekit::browser
