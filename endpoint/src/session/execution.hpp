#pragma once

#include "session/coordinator.hpp"
#include "session/session.hpp"

namespace remotekit {
class SessionExecution : public std::enable_shared_from_this<SessionExecution> {
 public:
  SessionExecution(media::Sdk&,
                   const RuntimeOptions&,
                   ManagementLink&,
                   objects::ObjectService&,
                   Json target);
  SessionCoordinator::Hooks Hooks();
  void Activate(std::string connection, uint64_t generation);
  Result<Json> Stop(const Json& commit,
                    bool check_blockers = true,
                    PhaseClock::time_point deadline = PhaseClock::time_point::max(),
                    bool deferred = false);
  Result<void> Fence();
  bool VersionDue(int64_t now, int64_t interval) const;
  Result<Json> SaveVersion(SnapshotClient& client, const Json& snapshot);
  bool Running() const { return running_.load(); }
  const std::string& Id() const { return id_; }
  uint64_t PlacementEpoch() const { return epoch_; }

 private:
  Result<void> Authorize(const Json&, uint64_t);
  Result<void> Prepare(const Json&);
  Result<void> Start();
  Result<void> Views(const Json&);
  Result<Json> Observe();
  void Maintain();
  Result<void> Admit(const Json&, uint64_t);
  Result<Json> Request(const Json&, uint64_t);
  Result<void> Acknowledge(const std::string&, uint64_t);
  Result<Json> ReadEvents();
  Result<Json> EventState();
  media::Sdk& sdk_;
  const RuntimeOptions& options_;
  ManagementLink& management_;
  objects::ObjectService& objects_;
  const std::string tenant_, id_;
  const uint64_t epoch_;
  const fs::path directory_;
  std::atomic<std::shared_ptr<Session>> runtime_;
  std::atomic<std::shared_ptr<const Json>> desired_;
  std::atomic<uint64_t> generation_{0};
  std::atomic<bool> running_{false};
  std::mutex scope_mutex_, authorization_mutex_;
  std::string connection_;
  std::unique_ptr<SessionDb> reader_;
  std::map<std::string, uint64_t> acknowledged_;
  std::chrono::steady_clock::time_point last_events_sent_{};
  uint64_t sent_through_ = 0;
  std::string sent_stream_, staged_revision_;
  bool starting_ = false, retired_ = false;
};
}  // namespace remotekit
