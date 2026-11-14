#pragma once
#include "options.hpp"
#include "management/link.hpp"
#include "objects/service.hpp"
#include "diagnostics/node_metrics.hpp"
#include "session/execution.hpp"
#include "rtc/service_peer.hpp"
#include "media/frame_admission.hpp"
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
  Json SnapshotFailures() const;

 private:
  friend class NativeErrorStateProbe;
  friend class NativeRetryOwnerProbe;
  Result<Json> Dispatch(const Json& request, uint64_t generation);
  Result<void> Clear();
  bool HandleRequest(Json request, uint64_t generation);
  Result<void> Fence(const Json& desired, uint64_t generation);
  Result<void> PreparePlacement(const Json& placement,
                                const std::string& revision,
                                uint64_t generation,
                                const std::function<Result<void>()>& prepare);
  Result<Json> ScheduleVersion(const std::string& id,
                               uint64_t epoch,
                               const std::function<Result<Json>()>& ready);
  Result<Json> TakeSnapshot(SnapshotClient& client, const std::vector<std::string>& paths);
  Result<void> SnapshotWork(const std::function<Result<void>()>& work);
  Result<Json> DeleteCold(bool expired_only);
  Result<Json> DeleteCold(bool expired_only,
                          const std::function<Result<bool>(const std::string&)>& remove);
  Result<Json> SweepCold(uint64_t generation, const std::function<Result<Json>()>& sweep);
  Result<Json> DeleteSession(const std::string& id);
  media::Sdk& sdk_;
  const RuntimeOptions& options_;
  ManagementLink& link_;
  const std::string incarnation_;
  std::atomic<uint64_t> observation_sequence_{0};
  media::FrameAdmission frame_admission_;
  objects::ObjectService objects_;
  objects::WorkQueue object_workers_;
  NodeMetrics metrics_;
  std::atomic<bool> snapshot_available_{false};
  void Versions();
  bool snapshot_unavailable_streak_ = false;
  std::atomic<size_t> session_count_{0};
  std::atomic<uint64_t> metrics_generation_{0};
  std::atomic<uint64_t> fenced_generation_{0};
  std::string connection_epoch_;
  Json node_desired_;
  Json placements_ = Json::array();
  std::mutex mutex_;
  struct ManagedSession {
    std::shared_ptr<SessionExecution> execution;
    std::shared_ptr<SessionCoordinator> coordinator;
  };
  std::map<std::string, ManagedSession> sessions_;
  std::map<std::string, std::pair<std::string, std::shared_ptr<ServicePeer>>> service_peers_;
  std::map<std::string, std::shared_ptr<RpcResults>> node_results_;
  std::map<std::string, RetryUnit> placement_retries_, version_retries_, cold_delete_retries_;
  RetryUnit snapshot_retry_{"snapshot.take"};
  RetryUnit snapshot_worker_retry_{"snapshot.worker"};
  mutable std::recursive_mutex snapshot_mutex_;
  RetryUnit cold_retry_{"session.cold_cleanup"};
  std::atomic<bool> failed_{false};
};
}  // namespace remotekit
