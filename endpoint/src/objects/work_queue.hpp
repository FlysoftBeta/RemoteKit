#pragma once
#include "protocol/limits.hpp"
#include "util/log.hpp"
#include <condition_variable>
#include <deque>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>
namespace remotekit::objects {
class WorkQueue {
 public:
  explicit WorkQueue(size_t count = 4) {
    for (size_t i = 0; i < count; ++i)
      workers_.emplace_back([this] {
        for (;;) {
          Task work;
          {
            std::unique_lock lock(mutex_);
            wake_.wait(lock, [&] { return stopping_ || !queue_.empty(); });
            if (queue_.empty())
              return;
            work = std::move(queue_.front());
            queue_.pop_front();
          }
          try {
            work.run();
          } catch (const std::exception& error) {
            LogError(LogLevel::kError, "worker.task_failed", {ErrorCode::kInternal, error.what()});
          } catch (...) {
            LogError(LogLevel::kError, "worker.task_failed",
                     {ErrorCode::kInternal, "unknown worker exception"});
          }
        }
      });
  }
  ~WorkQueue() { Stop(); }
  void Stop() {
    {
      std::lock_guard lock(mutex_);
      stopping_ = true;
    }
    wake_.notify_all();
    for (auto& worker : workers_)
      if (worker.joinable())
        worker.join();
  }
  bool Submit(std::function<void()> work,
              const void* owner = nullptr,
              std::function<void()> cancel = {}) {
    std::lock_guard lock(mutex_);
    if (stopping_ || queue_.size() >= limits::managementWorkerQueue)
      return false;
    queue_.push_back({std::move(work), owner, std::move(cancel)});
    wake_.notify_one();
    return true;
  }
  void Cancel(const void* owner) {
    std::vector<std::function<void()>> cancelled;
    {
      std::lock_guard lock(mutex_);
      std::erase_if(queue_, [&](auto& task) {
        if (task.owner != owner)
          return false;
        if (task.cancel)
          cancelled.push_back(std::move(task.cancel));
        return true;
      });
    }
    for (auto& cancel : cancelled)
      cancel();
  }

 private:
  std::mutex mutex_;
  std::condition_variable wake_;
  struct Task {
    std::function<void()> run;
    const void* owner;
    std::function<void()> cancel;
  };
  std::deque<Task> queue_;
  std::vector<std::thread> workers_;
  bool stopping_ = false;
};
}  // namespace remotekit::objects
