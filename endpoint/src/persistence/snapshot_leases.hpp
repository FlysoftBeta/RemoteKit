#pragma once
#include <chrono>
#include <cstdint>
#include <map>
#include <memory>
#include <set>
#include <string>

namespace remotekit::snapshot {
using LeaseClock = std::chrono::steady_clock;
inline bool CanMerge(LeaseClock::time_point created, LeaseClock::time_point now) {
  return now - created <= std::chrono::seconds(2);
}
template <class Shadow>
struct Lease {
  std::shared_ptr<Shadow> shadow;
  LeaseClock::time_point renewed;
  uint64_t owner;
  std::set<std::string> paths;
};
template <class Shadow>
class Leases : public std::map<std::string, Lease<Shadow>> {
 public:
  void Disconnect(uint64_t owner) {
    std::erase_if(*this, [&](const auto& item) { return item.second.owner == owner; });
  }
  void Expire(LeaseClock::time_point now) {
    std::erase_if(*this, [&](const auto& item) {
      return now - item.second.renewed >= std::chrono::seconds(120);
    });
  }
};
}  // namespace remotekit::snapshot
