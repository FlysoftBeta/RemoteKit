#pragma once
#include "objects/store.hpp"
#include "cluster/tcp.hpp"
#include "util/retry_unit.hpp"
#include <atomic>
#include <thread>
#include <map>
#include <optional>
namespace remotekit {
class NativeRetryOwnerProbe;
class NativeErrorStateProbe;
}  // namespace remotekit
namespace remotekit::objects {
struct PeerIdentity {
  std::string node_id, address;
  Key public_key;
  bool operator==(const PeerIdentity&) const = default;
};
class PeerSet {
 public:
  Result<bool> Update(const Json& peers);
  std::optional<PeerIdentity> Find(const std::string& node) const;
  std::optional<PeerIdentity> Find(const Key& key) const;

 private:
  mutable std::mutex mutex_;
  std::map<std::string, PeerIdentity> peers_;
};
class PeerServer {
 public:
  PeerServer(ObjectStore& store,
             const Key& key,
             std::string node,
             std::string build,
             PeerSet& peers);
  ~PeerServer();
  Result<void> Start(const std::string& address);
  std::string Address() const;
  void Revoke();
  RetryUnit::Snapshot AcceptRetryStatus() const;

 private:
  friend class ::remotekit::NativeRetryOwnerProbe;
  friend class ::remotekit::NativeErrorStateProbe;
  void Accepted(const std::string& remote_address);
  Result<std::unique_ptr<cluster::Carrier>> AcceptOne(
      const std::string& input,
      const std::function<Result<std::unique_ptr<cluster::Carrier>>()>& accept);
  mutable std::mutex accept_mutex_;
  RetryUnit accept_retry_{"peer.accept"};
  void Loop();
  void Reject(const std::string& remote_address,
              const std::string& reason,
              const Json& hello,
              const Error& error);
  std::mutex rejection_mutex_;
  std::map<std::string, std::string> rejections_;
  Result<void> Serve(cluster::Channel& channel);
  ObjectStore& store_;
  Key key_;
  PeerSet& peers_;
  std::string node_, build_;
  std::unique_ptr<cluster::TcpListener> listener_;
  std::atomic<bool> stopping_{false};
  std::vector<std::thread> workers_;
  std::mutex mutex_;
  std::map<std::shared_ptr<cluster::Channel>, PeerIdentity> channels_;
};
class PeerClient {
 public:
  PeerClient(ObjectStore& store,
             const Key& key,
             std::string node,
             std::string build,
             PeerSet& peers);
  ~PeerClient();
  Result<ObjectInfo> Fetch(const std::string& id, const std::string& node);

 private:
  ObjectStore& store_;
  Key key_;
  PeerSet& peers_;
  std::string node_, build_;
};
}  // namespace remotekit::objects
