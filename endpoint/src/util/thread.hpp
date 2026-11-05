#pragma once

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
    std::fprintf(stderr, "thread %.*s failed: %s\n", static_cast<int>(name.size()), name.data(),
                 error.what());
  } catch (...) {
    std::fprintf(stderr, "thread %.*s failed: unknown exception\n", static_cast<int>(name.size()),
                 name.data());
  }
  try {
    std::forward<OnFailure>(on_failure)();
  } catch (const std::exception& error) {
    std::fprintf(stderr, "thread %.*s failure handler: %s\n", static_cast<int>(name.size()),
                 name.data(), error.what());
  } catch (...) {
    std::fprintf(stderr, "thread %.*s failure handler: unknown exception\n",
                 static_cast<int>(name.size()), name.data());
  }
}
}  // namespace remotekit
