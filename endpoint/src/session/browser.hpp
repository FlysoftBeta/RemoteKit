#pragma once
#include "platform/process.hpp"
#include "options.hpp"
#include "media/adapter.hpp"
#include "session/browser_rpc.hpp"

namespace remotekit {
// Three launches per failure burst; a minute of healthy uptime starts a new
// burst. The caller supplies monotonic seconds, so the policy is probeable.
class BrowserStartPolicy {
 public:
  bool Admit(double now) {
    if (attempts_ >= 3 || now < retry_after_)
      return false;
    last_launch_ = now;
    retry_after_ = now + (1u << attempts_++);
    return true;
  }
  void Healthy(double now) {
    if (now - last_launch_ >= 60)
      attempts_ = 0;
  }
  unsigned attempts() const { return attempts_; }
 private:
  unsigned attempts_ = 0;
  double retry_after_ = 0, last_launch_ = 0;
};
class BrowserRuntime {
 public:
  explicit BrowserRuntime(media::Sdk& sdk) : rpc_(sdk) {}
  Result<void> Start(const fs::path& executable, std::wstring command, const std::string& channel);
  Result<void> Launch(const RuntimeOptions&,
                      const std::string&,
                      const fs::path&,
                      const StreamingAdapter&,
                      const std::shared_ptr<media::ServerTrace>&);
  Result<void> NewIncarnation();
  Result<void> Stop();
  Result<void> HealthCheck();
  Result<void> AdmitLaunch();
  bool Initialized() const { return initialized_; }
  void MarkInitialized() { initialized_ = true; }
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
  BrowserStartPolicy start_policy_;
  std::optional<Error> startup_error_;
  int64_t next_health_check_ = 0;
  bool initialized_ = false;
};
}  // namespace remotekit
