#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <variant>

namespace remotekit {
enum class ErrorCode {
  kInvalidRequest,
  kUnauthenticated,
  kForbidden,
  kLocked,
  kNotFound,
  kConflict,
  kLimitExceeded,
  kRateLimited,
  kUnavailable,
  kRejected,
  kOutcomeUnknown,
  kBusy,
  kInternal
};

inline std::string_view ErrorCodeName(ErrorCode code) {
  switch (code) {
    case ErrorCode::kInvalidRequest:
      return "invalid_request";
    case ErrorCode::kUnauthenticated:
      return "unauthenticated";
    case ErrorCode::kForbidden:
      return "forbidden";
    case ErrorCode::kLocked:
      return "locked";
    case ErrorCode::kNotFound:
      return "not_found";
    case ErrorCode::kConflict:
      return "conflict";
    case ErrorCode::kLimitExceeded:
      return "limit_exceeded";
    case ErrorCode::kRateLimited:
      return "rate_limited";
    case ErrorCode::kUnavailable:
      return "unavailable";
    case ErrorCode::kRejected:
      return "rejected";
    case ErrorCode::kOutcomeUnknown:
      return "outcome_unknown";
    case ErrorCode::kBusy:
      return "busy";
    case ErrorCode::kInternal:
      return "internal";
  }
  return "internal";
}

enum class ErrorReason { kNone, kBrowserCrashed, kBrowserRestarting, kOutputFailed };

inline std::string_view ErrorReasonName(ErrorReason reason) {
  switch (reason) {
    case ErrorReason::kBrowserCrashed:
      return "browser_crashed";
    case ErrorReason::kBrowserRestarting:
      return "browser_restarting";
    case ErrorReason::kOutputFailed:
      return "output_failed";
    case ErrorReason::kNone:
      return "";
  }
  return "";
}

struct Error {
  ErrorCode code;
  std::string message;
  ErrorReason reason = ErrorReason::kNone;
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
