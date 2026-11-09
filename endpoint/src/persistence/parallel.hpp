#pragma once
#include "util/error.hpp"
#include <algorithm>
#include <atomic>
#include <mutex>
#include <optional>
#include <thread>
#include <vector>

namespace remotekit {
template <class Task>
Result<void> CheckpointParallel(size_t count, size_t workers, Task task) {
  std::atomic<size_t> next{0};
  std::atomic<bool> failed{false};
  std::optional<Error> failure;
  std::mutex mutex;
  std::vector<std::thread> pool;
  for (size_t i = 0; i < std::min(count, workers); ++i)
    pool.emplace_back([&] {
      while (!failed) {
        const auto index = next.fetch_add(1);
        if (index >= count)
          break;
        try {
          const auto result = task(index);
          if (result)
            continue;
          std::lock_guard lock(mutex);
          if (!failure)
            failure = result.error();
        } catch (const std::exception& error) {
          std::lock_guard lock(mutex);
          if (!failure)
            failure = Error{ErrorCode::kUnavailable, error.what()};
        }
        failed = true;
      }
    });
  for (auto& worker : pool)
    worker.join();
  if (failure)
    return *failure;
  return {};
}
inline size_t CheckpointWorkers() {
  return std::max<size_t>(1, std::min<size_t>(4, std::thread::hardware_concurrency() / 2));
}
}  // namespace remotekit
