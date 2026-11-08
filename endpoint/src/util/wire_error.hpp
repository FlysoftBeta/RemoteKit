#pragma once
#include "util/error.hpp"
#include <json.hpp>
namespace remotekit {
inline nlohmann::json WireError(const Error& error) {
  nlohmann::json result = {{"code", ErrorCodeName(error.code)}, {"message", error.message}};
  if (error.reason != ErrorReason::kNone)
    result["reason"] = ErrorReasonName(error.reason);
  return result;
}
}  // namespace remotekit
