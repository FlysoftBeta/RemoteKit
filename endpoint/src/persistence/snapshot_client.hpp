#pragma once
#include "persistence/snapshot_protocol.hpp"

namespace remotekit {
class SnapshotClient {
 public:
  explicit SnapshotClient(const std::string& node);
  ~SnapshotClient();
  SnapshotClient(const SnapshotClient&) = delete;
  Result<Json> Take(const fs::path& root, const std::vector<std::string>& paths);
  Result<std::string> Read(const std::string& id,
                           const std::string& path,
                           uint64_t offset,
                           uint32_t length);
  Result<void> Release(const std::string& id);
  bool Available() const { return pipe_ != INVALID_HANDLE_VALUE; }

 private:
  Result<Json> Request(const Json& request);
  HANDLE pipe_ = INVALID_HANDLE_VALUE;
};
}  // namespace remotekit
