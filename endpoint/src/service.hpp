#pragma once
#include "options.hpp"
#include "management/link.hpp"
#include "objects/service.hpp"
#include "diagnostics/node_metrics.hpp"
#include "session/execution.hpp"
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
          const cluster::Key& cluster_key,
          std::string incarnation);
  ~Service();
  int Run();
  void Fail() { failed_ = true; }

 private:
  Result<Json> Dispatch(const Json& request, uint64_t generation);
  Result<void> Clear();
  bool HandleRequest(Json request, uint64_t generation);
  Result<void> Fence(const Json& desired, uint64_t generation);
  Result<Json> DeleteCold(bool expired_only);
  Result<Json> DeleteSession(const std::string& id);
  media::Sdk& sdk_;
  const RuntimeOptions& options_;
  ManagementLink& link_;
  const std::string incarnation_;
  objects::ObjectService objects_;
  objects::WorkQueue object_workers_;
  NodeMetrics metrics_;
  std::atomic<size_t> session_count_{0};
  std::atomic<uint64_t> metrics_generation_{0};
  uint64_t fenced_generation_ = 0;
  std::string connection_epoch_;
  Json node_desired_;
  Json placements_ = Json::array();
  std::mutex mutex_;
  struct ManagedSession {
    std::shared_ptr<SessionExecution> execution;
    std::shared_ptr<SessionCoordinator> coordinator;
  };
  std::map<std::string, ManagedSession> sessions_;
  std::map<std::string, std::shared_ptr<RpcResults>> node_results_;
  std::atomic<bool> failed_{false};
};
}  // namespace remotekit
