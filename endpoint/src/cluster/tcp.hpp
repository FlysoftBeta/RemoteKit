#pragma once
#include "cluster/channel.hpp"
namespace remotekit::cluster {
Result<std::unique_ptr<Carrier>> ConnectTcp(const std::string& address);
class TcpListener {
 public:
  static Result<std::unique_ptr<TcpListener>> Listen(const std::string& address);
  ~TcpListener();
  Result<std::unique_ptr<Carrier>> Accept(std::chrono::milliseconds timeout);
  const std::string& Address() const;
  void Close();

 private:
  struct Impl;
  explicit TcpListener(std::unique_ptr<Impl> impl);
  std::unique_ptr<Impl> impl_;
};
}  // namespace remotekit::cluster
