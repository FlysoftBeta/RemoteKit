#pragma once

namespace remotekit {
enum class Error {
  none = 0,
  not_found = 1,
  wrong_session = 2,
  already_exists = 3,
  unsupported = 4,
  invalid = 5,
  busy = 6,
  stale = 7,
  unavailable = 8,
  no_space = 9
};

namespace protocol {
inline constexpr int kControlVersion = 1;
inline constexpr int kBusyError = static_cast<int>(Error::busy);
}  // namespace protocol
}  // namespace remotekit
