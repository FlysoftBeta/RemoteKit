#include "browser/navigation_transfer.h"
namespace remotekit::browser {
bool NavigationTransfer::CanReserve(WebViewId view, size_t size) const {
  if (size > kMemoryLimit)
    return false;
  for (const auto& [id, transfer] : records) {
    if (id == view)
      continue;
    if (transfer.total > kMemoryLimit - size)
      return false;
    size += transfer.total;
  }
  return true;
}
uint64_t NavigationTransfer::NextId() {
  return next_id_++;
}
}  // namespace remotekit::browser
