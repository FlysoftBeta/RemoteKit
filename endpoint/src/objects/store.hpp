#pragma once
#include "cluster/frames.hpp"
#include <filesystem>
#include <functional>
#include <istream>
#include <mutex>
#include <ostream>

namespace remotekit::objects {
using cluster::Json;
using cluster::Key;
inline constexpr uint32_t kSegmentSize = 1024 * 1024;
bool ValidTenant(std::string_view tenant);
bool ValidId(std::string_view id);
struct Keys {
  Key object{}, id{};
  ~Keys();
};
struct ObjectInfo {
  std::string id;
  uint64_t size{}, stored_size{};
  std::string stored_sha256;
  bool created = false;
  double compress_encrypt_ms = 0;
  Json Committed() const;
  Json Inventory() const;
};
class ObjectStore {
 public:
  using Check = std::function<Result<void>()>;
  explicit ObjectStore(std::filesystem::path data);
  Result<ObjectInfo> Write(const Keys& keys,
                           const std::filesystem::path& plaintext,
                           const Check& check = {});
  Result<ObjectInfo> Write(const Keys& keys, std::istream& plaintext, const Check& check = {});
  Result<ObjectInfo> WriteChunk(const Keys& keys,
                                std::string_view plaintext,
                                const ObjectInfo* known = nullptr);
  Result<void> Read(const Keys& keys, const std::string& id, std::ostream& plaintext) const;
  Result<cluster::Bytes> ReadRange(const Keys& keys,
                                   const std::string& id,
                                   uint64_t offset,
                                   size_t length) const;
  Result<ObjectInfo> Inspect(const std::string& id) const;
  Result<std::filesystem::path> StoredPath(const std::string& id) const;
  Result<ObjectInfo> Import(const std::string& id, uint64_t size, const std::string& sha256);
  Result<void> Delete(const std::string& id);
  Result<Json> Inventory(const Json& cursor) const;

 private:
  friend class PeerClient;
  std::unique_lock<std::recursive_mutex> Lock(const std::string& id) const;
  std::filesystem::path root_;
  mutable std::array<std::recursive_mutex, 64> locks_;
};
}  // namespace remotekit::objects
