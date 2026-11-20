#pragma once
#include "util/error.hpp"
namespace remotekit {
inline bool LayoutConflict(const Error& error) {
  if (error.code != ErrorCode::kConflict)
    return false;
  return error.message == "view_transaction_identity_mismatch" ||
         error.message == "View is closing" || error.message == "view_closing" ||
         error.message == "page_viewport_generation_mismatch" ||
         error.message == "page viewport update was not accepted";
}
inline constexpr unsigned kImmediateLayoutAttempts = 3;
}  // namespace remotekit
