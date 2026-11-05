#pragma once
#include "platform/process.hpp"
#include "session/browser_rpc.hpp"

namespace remotekit {
class BrowserRuntime {
 public:
  explicit BrowserRuntime(media::Sdk& sdk) : rpc_(sdk) {}
  Result<void> Start(const fs::path& executable, std::wstring command, const std::string& channel);
  Result<void> NewIncarnation();
  Result<void> Stop();
  void ReleaseExited() { process_.ReleaseExited(); }
  bool Alive() const { return process_.Alive(); }
  bool Exited() const { return process_.Exited(); }
  bool Present() const { return process_.Present(); }
  bool Stopping() const { return process_.state() == BrowserProcess::State::kStopping; }
  DWORD Pid() const { return process_.Pid(); }
  std::string Diagnostic() const { return process_.Diagnostic(); }
  const std::string& Incarnation() const { return incarnation_; }
  const std::string& ProcessIncarnation() const { return process_incarnation_; }
  BrowserRpc& Rpc() { return rpc_; }
  const BrowserRpc& Rpc() const { return rpc_; }
  Result<Json> Snapshot() { return rpc_.Request(Json{{"method", "snapshot"}}); }

 private:
  BrowserProcess process_;
  BrowserRpc rpc_;
  std::string incarnation_, process_incarnation_;
};
}  // namespace remotekit
