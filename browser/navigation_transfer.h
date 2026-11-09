#pragma once
#include <map>
#include <string>
#include "browser/view_model.h"
namespace remotekit::browser {
class NavigationTransfer {
 public:
  struct Transfer {
    uint64_t id = 0, instance = 0, document = 0;
    size_t total = 0;
    bool importing = false, committed = false;
    std::string data;
  };
  static constexpr size_t kMemoryLimit = 64 * 1024 * 1024;
  bool CanReserve(WebViewId, size_t) const;
  uint64_t NextId();
  std::map<WebViewId, Transfer> records;

 private:
  uint64_t next_id_ = 1;
};
}  // namespace remotekit::browser
