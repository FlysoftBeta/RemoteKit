#pragma once

#include "../../../protocol/errors.h"
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <variant>

namespace remotekit {
using protocol::ErrorCode;
using protocol::ErrorCodeName;
using protocol::ErrorReason;
using protocol::ErrorReasonName;
using protocol::ParseErrorCode;
using protocol::ParseErrorReason;

inline bool SupportsRetryHint(ErrorCode code) {
  return code == ErrorCode::kBusy || code == ErrorCode::kRateLimited ||
         code == ErrorCode::kUnavailable;
}
struct Error {
  ErrorCode code;
  std::string message;
  std::optional<ErrorReason> reason;
  std::optional<uint32_t> retry_after_ms;
  Error(ErrorCode code,
        std::string message,
        std::optional<ErrorReason> reason = {},
        std::optional<uint32_t> retry_after_ms = {})
      : code(code),
        message(std::move(message)),
        reason(reason),
        retry_after_ms(SupportsRetryHint(code) && retry_after_ms && *retry_after_ms <= 86400000
                           ? retry_after_ms
                           : std::nullopt) {}
};

template <class T>
class Result {
 public:
  Result(T value) : result_(std::move(value)) {}
  Result(Error error) : result_(std::move(error)) {}
  explicit operator bool() const { return std::holds_alternative<T>(result_); }
  T& value() & { return std::get<T>(result_); }
  const T& value() const& { return std::get<T>(result_); }
  T&& value() && { return std::get<T>(std::move(result_)); }
  Error& error() & { return std::get<Error>(result_); }
  const Error& error() const& { return std::get<Error>(result_); }

 private:
  std::variant<T, Error> result_;
};

template <>
class Result<void> {
 public:
  Result() = default;
  Result(Error error) : error_(std::move(error)) {}
  explicit operator bool() const { return !error_; }
  const Error& error() const { return error_.value(); }

 private:
  std::optional<Error> error_;
};
}  // namespace remotekit
