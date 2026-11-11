#pragma once
#include "util/log.hpp"

#include <cstdio>
#include <exception>
#include <string_view>
#include <utility>

namespace remotekit {
template <class Function, class OnFailure>
void RunThread(std::string_view name, Function&& function, OnFailure&& on_failure) noexcept {
  try {
    std::forward<Function>(function)();
    return;
  } catch (const std::exception& error) {
    LogError(LogLevel::kError, "thread.failed", Error{ErrorCode::kInternal, error.what()},
             {{"thread", std::string(name)}});
  } catch (...) {
    LogError(LogLevel::kError, "thread.failed", Error{ErrorCode::kInternal, "unknown exception"},
             {{"thread", std::string(name)}});
  }
  try {
    std::forward<OnFailure>(on_failure)();
  } catch (const std::exception& error) {
    LogError(LogLevel::kError, "thread.handler_failed", Error{ErrorCode::kInternal, error.what()},
             {{"thread", std::string(name)}});
  } catch (...) {
    LogError(LogLevel::kError, "thread.handler_failed",
             Error{ErrorCode::kInternal, "unknown exception"}, {{"thread", std::string(name)}});
  }
}
}  // namespace remotekit
