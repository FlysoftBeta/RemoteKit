#pragma once
#include "util/error.hpp"
#include <json.hpp>
namespace remotekit {
inline nlohmann::json WireError(const Error& error) {
  nlohmann::json result = {{"code", ErrorCodeName(error.code)}, {"message", error.message}};
  if (error.reason)
    result["reason"] = ErrorReasonName(*error.reason);
  if (SupportsRetryHint(error.code) && error.retry_after_ms && *error.retry_after_ms <= 86400000)
    result["retryAfterMs"] = *error.retry_after_ms;
  return result;
}
inline Error ParseWireError(const nlohmann::json& value) {
  if (!value.is_object())
    return {ErrorCode::kOutcomeUnknown, "Peer returned an invalid error envelope"};
  const auto code = value.find("code");
  const auto parsed = code != value.end() && code->is_string()
                          ? ParseErrorCode(code->get_ref<const std::string&>())
                          : std::nullopt;
  if (!parsed)
    return {ErrorCode::kOutcomeUnknown, "Peer returned a missing or unknown error code"};
  const auto message = value.find("message");
  Error error{*parsed, message != value.end() && message->is_string() ? message->get<std::string>()
                                                                      : "Peer request failed"};
  const auto reason = value.find("reason");
  if (reason != value.end() && reason->is_string())
    error.reason = ParseErrorReason(reason->get_ref<const std::string&>());
  const auto retry = value.find("retryAfterMs");
  if (SupportsRetryHint(error.code) && retry != value.end() && retry->is_number_integer() &&
      *retry >= 0 && *retry <= 86400000)
    error.retry_after_ms = retry->get<uint32_t>();
  return error;
}
}  // namespace remotekit
