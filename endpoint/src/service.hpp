#pragma once
#include "options.hpp"
#include "management/link.hpp"
#include "objects/service.hpp"
#include "diagnostics/node_metrics.hpp"
#include <map>
#include <mutex>
#include <atomic>
namespace remotekit {
namespace media {
struct Sdk;
}
class Session;
class Service {
 public:
  Service(media::Sdk& sdk,
          const RuntimeOptions& options,
          ManagementLink& link,
          const cluster::Key& cluster_key);
  ~Service();
  int Run();
  void Fail() { failed_ = true; }

 private:
  Result<Json> Dispatch(const Json& request, uint64_t generation);
  Result<void> Clear();
  bool HandleRequest(Json request, uint64_t generation);
  Result<void> Fence(const ManagementLink::ReadyState& ready);
  Result<Json> DeleteCold(bool expired_only);
  media::Sdk& sdk_;
  const RuntimeOptions& options_;
  ManagementLink& link_;
  objects::ObjectService objects_;
  objects::WorkQueue object_workers_;
  NodeMetrics metrics_;
  std::atomic<size_t> session_count_{0};
  std::atomic<uint64_t> metrics_generation_{0};
  uint64_t fenced_generation_ = 0;
  Json placements_ = Json::array();
  std::mutex mutex_;
  std::map<std::string, std::unique_ptr<Session>> sessions_;
  std::atomic<bool> failed_{false};
};
}  // namespace remotekit
