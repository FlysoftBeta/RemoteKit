#pragma once
#include "util/error.hpp"
#include <json.hpp>
namespace remotekit {
inline nlohmann::json WireError(const Error& error) {
  return {{"code", ErrorCodeName(error.code)}, {"message", error.message}};
}
}  // namespace remotekit
