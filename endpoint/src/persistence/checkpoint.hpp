#pragma once
#include "objects/service.hpp"
#include "persistence/session_store.hpp"

namespace remotekit {
class Checkpoints {
 public:
  explicit Checkpoints(objects::ObjectService& objects) : objects_(objects) {}
  Result<Json> Create(const fs::path& directory,
                      const std::string& tenant,
                      const objects::Keys& keys,
                      const std::string& session,
                      uint64_t epoch,
                      const std::string& build);
  Result<void> Restore(const fs::path& directory,
                       const std::string& tenant,
                       const objects::Keys& keys,
                       const std::string& session,
                       uint64_t epoch,
                       const std::string& build,
                       const Json& checkpoint);
  static bool Excluded(const fs::path& relative, bool directory);

 private:
  Result<std::string> Put(const std::string& tenant,
                          const objects::Keys& keys,
                          const std::string& bytes);
  Result<std::string> Get(const std::string& tenant,
                          const objects::Keys& keys,
                          const std::string& id);
  objects::ObjectService& objects_;
};
}  // namespace remotekit
