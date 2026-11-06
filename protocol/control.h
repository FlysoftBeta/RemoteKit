#pragma once

#include <string_view>

namespace remotekit::protocol {
inline constexpr int kControlVersion = 1;
inline constexpr std::string_view kBrowserShutdown = "browser.shutdown";
inline constexpr std::string_view kStorageScavenge = "storage.scavenge";
inline constexpr int kBrowserShutdownFailureExitCode = 70;
enum class ErrorCode {
  none = 0,
  not_found = 1,
  unsupported = 4,
  invalid_request = 5,
  busy = 6,
  stale_identity = 7,
  unavailable = 8,
  resource_limit = 9,
  internal = 10
};
inline constexpr int kBusyError = static_cast<int>(ErrorCode::busy);
constexpr std::string_view ErrorName(ErrorCode code) {
  switch (code) {
    case ErrorCode::none:
      return "none";
    case ErrorCode::not_found:
      return "not_found";
    case ErrorCode::unsupported:
      return "unsupported";
    case ErrorCode::invalid_request:
      return "invalid_request";
    case ErrorCode::busy:
      return "busy";
    case ErrorCode::stale_identity:
      return "stale_identity";
    case ErrorCode::unavailable:
      return "unavailable";
    case ErrorCode::resource_limit:
      return "resource_limit";
    case ErrorCode::internal:
      return "internal";
  }
  return "internal";
}
}  // namespace remotekit::protocol
