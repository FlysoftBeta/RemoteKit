#pragma once
#include "objects/service.hpp"
#include "persistence/directory_watcher.hpp"
#include <future>

namespace remotekit {
Result<Json> CheckpointIdentity(const fs::path& path);
struct StagedFile {
  Json identity;
  std::vector<objects::ObjectInfo> objects;
};
class CheckpointCache {
 public:
  ~CheckpointCache();
  void Start(const fs::path& directory);
  void Stop();
  void PeerPresent(bool present);
  void MaybeStage(objects::ObjectService& objects, const std::string& tenant);
  std::optional<StagedFile> Find(const std::string& path, const Json& identity) const;
  DirectoryChanges Changes() const { return watcher_.Snapshot(); }
  DirectoryWatcher& Watcher() { return watcher_; }

 private:
  friend class CheckpointCacheProbe;
  fs::path directory_;
  DirectoryWatcher watcher_;
  std::atomic<bool> cancel_{false};
  std::atomic<uint64_t> generation_{0};
  std::optional<PhaseClock::time_point> no_peer_;
  std::future<void> staging_;
  mutable std::mutex mutex_;
  std::map<std::string, StagedFile> staged_;
};
}  // namespace remotekit
