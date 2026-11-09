#pragma once
#include "objects/service.hpp"
#include "persistence/session_store.hpp"
#include "persistence/phase_timing.hpp"
#include "persistence/checkpoint_cache.hpp"

namespace remotekit {
class Checkpoints {
 public:
  explicit Checkpoints(objects::ObjectService& objects,
                       std::shared_ptr<objects::SessionObjects> access = {},
                       Json* phases = nullptr,
                       CheckpointCache* cache = nullptr)
      : objects_(objects), access_(std::move(access)), phases_(phases), cache_(cache) {}
  Result<Json> Create(const fs::path& directory,
                      const std::string& tenant,
                      const std::string& build);
  Result<void> Restore(const fs::path& directory,
                       const std::string& tenant,
                       const Json& checkpoint);
  static bool Excluded(const fs::path& relative, bool directory);
  static Result<Json> Scan(const fs::path& directory,
                           const Json& previous,
                           const DirectoryChanges& changes,
                           Json* phases = nullptr);
  static Result<Json> Hibernation(const fs::path& directory);
  static Result<void> Journal(const fs::path& directory,
                              uint64_t epoch,
                              const Json& checkpoint,
                              const std::string& build);

 private:
  Result<std::string> Get(const std::string& tenant, const std::string& id);
  objects::ObjectService& objects_;
  std::shared_ptr<objects::SessionObjects> access_;
  Json* phases_;
  CheckpointCache* cache_;
};
}  // namespace remotekit
