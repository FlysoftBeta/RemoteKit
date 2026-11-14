#pragma once
#include "objects/service.hpp"
#include "persistence/directory_watcher.hpp"
#include <future>
#include "util/retry_unit.hpp"

namespace remotekit {
Result<Json> CheckpointIdentity(const fs::path& path);
struct StagedFile {
  Json identity;
  std::vector<objects::ObjectInfo> objects;
};
class CheckpointCache {
 public:
  ~CheckpointCache();
  Result<void> Start(const fs::path& directory);
  Result<void> Flush();
  Result<void> Version(const Json& version);
  void Stop();
  void MaybeStage(objects::ObjectService& objects, const std::string& tenant);
  std::optional<StagedFile> Find(const std::string& path, const Json& identity) const;
  DirectoryChanges Changes() const { return watcher_.Snapshot(); }
  DirectoryWatcher& Watcher() { return watcher_; }
  RetryUnit::Snapshot JournalRetryStatus() const;
  RetryUnit::Snapshot StagingRetryStatus() const;

 private:
  friend class CheckpointCacheProbe;
  friend class NativeRetryOwnerProbe;
  fs::path directory_;
  DirectoryWatcher watcher_;
  std::atomic<bool> cancel_{false};
  std::atomic<uint64_t> generation_{0};
  PhaseClock::time_point next_refresh_, last_flush_{};
  std::thread journal_thread_;
  std::mutex journal_mutex_;
  std::condition_variable journal_wake_;
  std::future<Result<void>> staging_;
  mutable std::mutex mutex_;
  std::map<std::string, StagedFile> staged_;
  RetryUnit journal_retry_{"checkpoint.journal"};
  mutable std::mutex journal_retry_mutex_, staging_retry_mutex_;
  void JournalTick(const std::function<Result<void>()>& flush);
  bool QueueStaging(const std::string& input, const std::function<Result<void>()>& queue);
  void CompleteStaging(Result<void> result);
  RetryUnit claims_retry_{"checkpoint.claims"};
  RetryUnit staging_retry_{"checkpoint.staging"};
  std::map<std::string, RetryUnit> staging_retries_;
};
}  // namespace remotekit
