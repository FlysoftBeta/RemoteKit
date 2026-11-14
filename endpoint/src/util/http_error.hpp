#pragma once
#include "util/error.hpp"
#include <algorithm>
#include <charconv>
#include <chrono>
#include <ctime>
#include <iomanip>
#include <sstream>

namespace remotekit {
inline std::optional<uint32_t> HttpRetryAfter(
    std::string text,
    std::chrono::system_clock::time_point now = std::chrono::system_clock::now()) {
  const auto first = text.find_first_not_of(" \t");
  if (first == std::string::npos)
    return {};
  text = text.substr(first, text.find_last_not_of(" \t\r") - first + 1);
  uint64_t seconds = 0;
  const auto parsed = std::from_chars(text.data(), text.data() + text.size(), seconds);
  if (parsed.ec == std::errc{} && parsed.ptr == text.data() + text.size())
    return static_cast<uint32_t>(std::min<uint64_t>(seconds, 86400) * 1000);
  std::tm date{};
  std::istringstream input(text);
  input >> std::get_time(&date, "%a, %d %b %Y %H:%M:%S GMT");
  if (input.fail())
    return {};
  const auto at = _mkgmtime(&date);
  if (at < 0)
    return {};
  const auto delay = std::chrono::duration_cast<std::chrono::milliseconds>(
                         std::chrono::system_clock::from_time_t(at) - now)
                         .count();
  return static_cast<uint32_t>(std::clamp<int64_t>(delay, 0, 86400000));
}
inline Error HttpError(unsigned status, std::optional<uint32_t> retry_after_ms = {}) {
  ErrorCode code = ErrorCode::kInternal;
  switch (status) {
    case 401:
      code = ErrorCode::kUnauthenticated;
      break;
    case 403:
      code = ErrorCode::kForbidden;
      break;
    case 404:
      code = ErrorCode::kNotFound;
      break;
    case 429:
      code = ErrorCode::kRateLimited;
      break;
    case 408:
      code = ErrorCode::kUnavailable;
      break;
    default:
      if (status >= 500 && status <= 599)
        code = ErrorCode::kUnavailable;
  }
  return {code, "HTTP upgrade failed: " + std::to_string(status), {}, retry_after_ms};
}
}  // namespace remotekit
