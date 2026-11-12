#pragma once
#include <cstdint>
#include <string>

namespace remotekit {
struct VersionIdentity {
  std::string endpoint_incarnation, browser_incarnation;
  uint64_t placement_epoch, runtime_generation;
  bool operator==(const VersionIdentity&) const = default;
  bool Current(const VersionIdentity& current, bool running) const {
    return running && *this == current;
  }
};
}  // namespace remotekit
