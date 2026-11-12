#pragma once
#include "objects/service.hpp"
#include <functional>
#include "persistence/durable_json.hpp"
#include "persistence/phase_timing.hpp"
#include "persistence/checkpoint_cache.hpp"

namespace remotekit {
struct SnapshotSource {
  Json entries;
  std::function<Result<std::string>(const std::string&, uint64_t, uint32_t)> read;
};
struct CheckpointPlan {
  Json previous;
  DirectoryChanges changes;
};
struct BuiltCheckpoint {
  Json checkpoint;
  Json index;
};
class Checkpoints {
 public:
  explicit Checkpoints(objects::ObjectService& objects,
                       std::shared_ptr<objects::SessionObjects> access = {},
                       Json* phases = nullptr,
                       CheckpointCache* cache = nullptr)
      : objects_(objects), access_(std::move(access)), phases_(phases), cache_(cache) {}
  Result<Json> Create(const fs::path& directory,
                      const std::string& tenant,
                      const std::string& build,
                      PhaseClock::time_point deadline = PhaseClock::time_point::max(),
                      bool defer_commits = false,
                      const SnapshotSource* source = nullptr);
  static Result<CheckpointPlan> Capture(const fs::path& directory, DirectoryChanges changes);
  Result<BuiltCheckpoint> Build(const fs::path& directory,
                                const std::string& tenant,
                                const std::string& build,
                                const CheckpointPlan& plan,
                                PhaseClock::time_point deadline = PhaseClock::time_point::max(),
                                bool defer_commits = false,
                                const SnapshotSource* source = nullptr);
  static Result<void> InstallIndex(const fs::path& directory, const BuiltCheckpoint& built);
  Result<void> Restore(const fs::path& directory,
                       const std::string& tenant,
                       const Json& checkpoint);
  static bool Excluded(const fs::path& relative, bool directory);
  static Result<Json> Scan(const fs::path& directory,
                           const Json& previous,
                           const DirectoryChanges& changes,
                           Json* phases = nullptr);
  static Result<Json> Copy(const fs::path& directory);
  static Result<void> WriteCopy(const fs::path& directory, const Json& copy);
  static bool ReuseCopy(const Json& copy, uint64_t epoch, const Json& checkpoint);
  static Result<DirectoryChanges> RecoverChanges(const fs::path& directory,
                                                 int64_t changes_at,
                                                 bool metadata_walk = true);
  static Result<void> FlushChanges(const fs::path& directory, const DirectoryChanges& changes);
  static Result<void> TruncateChanges(const fs::path& directory);
  Result<Json> Describe(const std::string& manifest);

 private:
  Result<std::string> Get(const std::string& tenant, const std::string& id);
  objects::ObjectService& objects_;
  std::shared_ptr<objects::SessionObjects> access_;
  Json* phases_;
  CheckpointCache* cache_;
};
}  // namespace remotekit
