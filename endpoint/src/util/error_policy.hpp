#pragma once
#include "util/error.hpp"
#include <algorithm>
#include <chrono>
#include <random>
namespace remotekit {
enum class ErrorHandling {
  kRetrySoon,
  kRetryAfter,
  kBackoff,
  kReconcile,
  kRefresh,
  kDrop,
  kUnlock,
  kSignIn,
  kFinal,
  kCanceled
};
constexpr ErrorHandling Handling(ErrorCode code) {
  switch (code) {
    case ErrorCode::kBusy:
      return ErrorHandling::kRetrySoon;
    case ErrorCode::kRateLimited:
      return ErrorHandling::kRetryAfter;
    case ErrorCode::kUnavailable:
      return ErrorHandling::kBackoff;
    case ErrorCode::kOutcomeUnknown:
      return ErrorHandling::kReconcile;
    case ErrorCode::kConflict:
      return ErrorHandling::kRefresh;
    case ErrorCode::kNotFound:
      return ErrorHandling::kDrop;
    case ErrorCode::kLocked:
      return ErrorHandling::kUnlock;
    case ErrorCode::kUnauthenticated:
      return ErrorHandling::kSignIn;
    case ErrorCode::kCanceled:
      return ErrorHandling::kCanceled;
    default:
      return ErrorHandling::kFinal;
  }
}
inline std::optional<std::chrono::milliseconds> RetryDelay(const Error& error, unsigned attempt) {
  using namespace std::chrono;
  if (error.code == ErrorCode::kRateLimited)
    return milliseconds(error.retry_after_ms.value_or(30000));
  if (error.code != ErrorCode::kBusy && error.code != ErrorCode::kUnavailable)
    return std::nullopt;
  const bool busy = error.code == ErrorCode::kBusy;
  const uint64_t base = busy ? 250 : 1000;
  const uint64_t cap = busy ? 5000 : 300000;
  const uint64_t delay = (std::min)(cap, base << (std::min)(attempt, 20u));
  if (!busy)
    return milliseconds(error.retry_after_ms.value_or(static_cast<uint32_t>(delay)));
  thread_local std::mt19937 random(std::random_device{}());
  return milliseconds(
      (std::min)(cap, static_cast<uint64_t>(
                          delay * std::uniform_real_distribution<double>(0.8, 1.2)(random))));
}
}  // namespace remotekit
