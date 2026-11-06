#pragma once
#include "util/common.hpp"
#include <windows.h>
#include <pdh.h>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <thread>

namespace remotekit {
class NodeMetrics {
 public:
  explicit NodeMetrics(fs::path data);
  ~NodeMetrics();
  Json Sample(size_t sessions);
  void Start(std::function<size_t()> sessions, std::function<void(Json)> publish);
  void Stop();

 private:
  fs::path data_;
  PDH_HQUERY query_ = nullptr;
  PDH_HCOUNTER engines_ = nullptr, memory_ = nullptr;
  uint64_t idle_ = 0, kernel_ = 0, user_ = 0;
  std::mutex mutex_;
  std::condition_variable wake_;
  std::thread worker_;
  bool stop_ = false;
};
}  // namespace remotekit
