#pragma once

namespace remotekit::browser {
enum class CloseState { kOpen, kClosing, kClosed };
constexpr bool IsOpen(CloseState state) {
  return state == CloseState::kOpen;
}
constexpr CloseState AfterBeforeUnload(CloseState state, bool proceed) {
  return state == CloseState::kClosing && !proceed ? CloseState::kOpen : state;
}
}  // namespace remotekit::browser
