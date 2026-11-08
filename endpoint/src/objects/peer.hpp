#pragma once
#include "objects/store.hpp"
#include "cluster/tcp.hpp"
#include <atomic>
#include <thread>
namespace remotekit::objects {
class PeerServer {
 public:
  PeerServer(ObjectStore& store, const Key& key, std::string node, std::string build);
  ~PeerServer();
  Result<void> Start(const std::string& address);
  std::string Address() const;

 private:
  void Loop();
  Result<void> Serve(cluster::Channel& channel);
  ObjectStore& store_;
  Key key_;
  std::string node_, build_;
  std::unique_ptr<cluster::TcpListener> listener_;
  std::atomic<bool> stopping_{false};
  std::vector<std::thread> workers_;
  std::mutex mutex_;
  std::vector<std::shared_ptr<cluster::Channel>> channels_;
};
class PeerClient {
 public:
  PeerClient(ObjectStore& store, const Key& key, std::string node, std::string build);
  ~PeerClient();
  Result<ObjectInfo> Fetch(const std::string& id, const std::string& address);

 private:
  ObjectStore& store_;
  Key key_;
  std::string node_, build_;
};
}  // namespace remotekit::objects
