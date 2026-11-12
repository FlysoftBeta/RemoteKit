#pragma once

#include "protocol/control.h"
#include "protocol/limits.hpp"
#include "util/common.hpp"
#include "util/error.hpp"

namespace remotekit {
inline Result<void> ValidateSignIn(const Json& config) {
  if (!config.contains("signIn"))
    return {};
  const auto& purpose = config.at("signIn");
  if (!purpose.is_string() || (purpose != "xinjiaoyu" && purpose != "changyan"))
    return Error{ErrorCode::kInvalidRequest, "invalid sign-in purpose"};
  if (config.value("method", std::string()) == "view.adopt")
    return Error{ErrorCode::kInvalidRequest, "sign-in views cannot adopt popups"};
  return {};
}

inline bool ValidSignInEvent(const Json& event) {
  if (!event.is_object() || event.value("type", Json()) != std::string(protocol::kViewSignIn) ||
      event.value("version", Json()) != protocol::kControlVersion ||
      !event.value("eventId", Json()).is_string() ||
      !event.value("webviewId", Json()).is_string() || !event.value("result", Json()).is_object())
    return false;
  const auto& result = event.at("result");
  if (result.dump().size() > limits::signInBytes)
    return false;
  const bool changyan = event.value("provider", Json()) == "changyan";
  const bool xinjiaoyu = event.value("provider", Json()) == "xinjiaoyu";
  if (!changyan && !xinjiaoyu)
    return false;
  for (const auto& [key, value] : result.items()) {
    if (!value.is_string())
      return false;
    if (changyan && key != "lot_number" && key != "captcha_output" && key != "pass_token" &&
        key != "gen_time")
      return false;
    if (xinjiaoyu && key != "authorization" && key != "accesstoken" && key != "clientsession" &&
        key != "device" && key != "devicetype" && key != "user-agent" && key != "accept-language" &&
        key != "sec-ch-ua" && key != "sec-ch-ua-mobile" && key != "sec-ch-ua-platform")
      return false;
  }
  if (changyan) {
    for (const auto* key : {"lot_number", "captcha_output", "pass_token", "gen_time"})
      if (result.value(key, std::string()).empty())
        return false;
    return true;
  }
  return result.value("authorization", std::string()).starts_with("JBY ") &&
         !result.value("accesstoken", std::string()).empty() &&
         !result.value("clientsession", std::string()).empty();
}
}  // namespace remotekit
