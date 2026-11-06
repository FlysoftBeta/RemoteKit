#pragma once
#include "objects/peer.hpp"
#include "management/link.hpp"
#include "objects/work_queue.hpp"
namespace remotekit::objects {
class ObjectService {
 public:
  ObjectService(std::filesystem::path data,
                ManagementLink& control,
                const Key& key,
                std::string node,
                std::string build);
  Result<void> Start(const std::string& listen);
  ObjectStore& Store() { return store_; }
  Result<ObjectInfo> Ensure(const std::string& tenant, const std::string& id);
  Result<void> Committed(const ObjectInfo& info, const std::string& derived_from = {});
  Result<ObjectInfo> Write(const std::string& tenant,
                           const Keys& keys,
                           const std::filesystem::path& path,
                           const ObjectStore::Check& check,
                           const std::string& derived_from = {});
  Result<Json> Dispatch(const Json& request);

 private:
  Result<ObjectInfo> Fetch(const std::string& tenant, const std::string& id, const Json& sources);
  Result<ObjectInfo> EnsureLocal(const std::string& tenant, const std::string& id);
  ObjectStore store_;
  ManagementLink& control_;
  PeerServer server_;
  PeerClient client_;
  std::array<std::mutex, 16> transfers_;
  WorkQueue work_;
};
}  // namespace remotekit::objects
