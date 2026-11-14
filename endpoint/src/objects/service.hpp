#pragma once
#include "objects/peer.hpp"
#include "management/link.hpp"
#include "objects/work_queue.hpp"
#include "util/retry_unit.hpp"
#include <set>
#include <semaphore>
namespace remotekit::documents {
class ObjectDocuments;
}
namespace remotekit {
class NativeRetryOwnerProbe;
}
namespace remotekit::objects {
class ObjectService {
 public:
  ObjectService(std::filesystem::path data,
                ManagementLink& control,
                const Key& key,
                std::string node,
                std::string build);
  ~ObjectService();
  Result<void> SetPeers(const Json& peers);
  Result<void> Start(const std::string& listen);
  ObjectStore& Store() { return store_; }
  documents::ObjectDocuments& Documents() { return *documents_; }
  std::string ConnectionEpoch() const {
    const auto ready = control_.ReadyConfiguration();
    return ready ? ready->connection_epoch : std::string();
  }
  Result<Json> Derivation(const std::string& id, const std::string& tenant);
  Result<void> Configure(const Json& keys);
  const Keys& ObjectKeys() const { return keys_; }
  Result<Json> Locate(const std::string& id, const Json& reference);
  Result<Json> LocateBatch(const std::vector<std::string>& ids, const Json& reference);
  Result<ObjectInfo> Ensure(const std::string& id, const Json& sources);
  Result<ObjectInfo> EnsureUncommitted(const std::string& id, const Json& sources);
  Result<void> Committed(const ObjectInfo& info, const Json& claim = Json::object());
  Result<void> CommittedBatch(const std::vector<ObjectInfo>& objects,
                              const std::string& tenant = {},
                              size_t* requests = nullptr);
  bool PreStage(std::function<void()> work);
  bool StageBytes(size_t bytes, const std::atomic<bool>& cancel);
  Result<void> RefreshClaims(const std::string& tenant, const std::vector<std::string>& ids);
  Result<ObjectInfo> Write(const std::filesystem::path& path,
                           const ObjectStore::Check& check,
                           const Json& claim);
  Result<Json> Dispatch(const Json& request);
  Result<void> PutChunk(const Json& header, std::span<const uint8_t> bytes);
  void CancelPuts();
  void CommitDeadline(std::chrono::steady_clock::time_point deadline) {
    commit_deadline_ = deadline.time_since_epoch().count();
  }

 private:
  friend class ::remotekit::NativeRetryOwnerProbe;
  Result<Json> DispatchPut(const Json& request);
  Result<ObjectInfo> Fetch(const std::string& id, const Json& sources);
  Result<ObjectInfo> EnsureLocal(const std::string& id, const Json& sources);
  std::atomic<std::chrono::steady_clock::duration::rep> commit_deadline_{
      std::chrono::steady_clock::time_point::max().time_since_epoch().count()};
  Keys keys_;
  bool configured_ = false;
  std::filesystem::path put_root_;
  struct Put {
    std::string tenant;
    explicit Put(std::string value) : tenant(std::move(value)) {}
    std::atomic<bool> cancelled{false};
    bool ending = false;
    uint64_t offset = 0;
    std::optional<Error> error;
  };
  std::mutex puts_mutex_;
  std::map<std::string, std::shared_ptr<Put>> puts_;
  ObjectStore store_;
  ManagementLink& control_;
  PeerSet peers_;
  PeerServer server_;
  PeerClient client_;
  std::array<std::mutex, 16> transfers_;
  std::mutex sources_mutex_;
  std::map<std::string, std::shared_ptr<std::counting_semaphore<4>>> source_limits_;
  std::map<std::string, RetryUnit> source_retries_;
  struct CommitRetry {
    mutable std::mutex mutex;
    RetryUnit retry{"object.commit"};
  };
  mutable std::mutex commits_mutex_;
  std::map<std::string, std::shared_ptr<CommitRetry>> commit_retries_;
  WorkQueue work_;
  WorkQueue staging_{1};
  std::atomic<bool> staging_busy_{false};
  std::mutex staging_rate_mutex_;
  std::chrono::steady_clock::time_point staging_next_{};
  std::unique_ptr<documents::ObjectDocuments> documents_;
};
class SessionObjects {
 public:
  SessionObjects(ObjectService& service, std::string tenant)
      : service_(service), tenant_(std::move(tenant)) {}
  Result<ObjectInfo> Ensure(const std::string& id);
  Result<Json> Prepare(const std::vector<std::string>& ids);
  void Grant(const std::string& id);
  Result<ObjectInfo> Write(const std::filesystem::path& path,
                           const ObjectStore::Check& check,
                           const std::string& derived_from = {});

 private:
  ObjectService& service_;
  std::string tenant_;
  std::mutex mutex_;
  std::set<std::string> grants_;
  Json sources_ = Json::object();
};
}  // namespace remotekit::objects
