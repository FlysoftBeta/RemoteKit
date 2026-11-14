#pragma once
#include "util/common.hpp"
#include "util/retry_unit.hpp"
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
  void Start(std::function<size_t()> sessions,
             std::function<Result<void>(Json)> publish,
             std::function<std::string()> input);
  void Stop();
  RetryUnit::Snapshot RetryStatus() const;

 private:
  friend class NativeRetryOwnerProbe;
  void Publish(const std::string& input,
               const std::function<Json()>& sample,
               const std::function<Result<void>(Json)>& publish);
  mutable std::mutex retry_mutex_;
  RetryUnit retry_{"node.metrics"};
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
