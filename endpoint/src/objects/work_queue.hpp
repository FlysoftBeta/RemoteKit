#pragma once
#include "protocol/limits.hpp"
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
          std::function<void()> work;
          {
            std::unique_lock lock(mutex_);
            wake_.wait(lock, [&] { return stopping_ || !queue_.empty(); });
            if (queue_.empty())
              return;
            work = std::move(queue_.front());
            queue_.pop_front();
          }
          work();
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
  bool Submit(std::function<void()> work) {
    std::lock_guard lock(mutex_);
    if (stopping_ || queue_.size() >= limits::managementWorkerQueue)
      return false;
    queue_.push_back(std::move(work));
    wake_.notify_one();
    return true;
  }

 private:
  std::mutex mutex_;
  std::condition_variable wake_;
  std::deque<std::function<void()>> queue_;
  std::vector<std::thread> workers_;
  bool stopping_ = false;
};
}  // namespace remotekit::objects
