#pragma once

#include "management/coordination.hpp"
#include "management/rpc_results.hpp"
#include <atomic>
#include <condition_variable>
#include <functional>
#include <thread>

namespace remotekit {
class SessionCoordinator {
 public:
  struct Hooks {
    std::function<Result<void>(const Json&, uint64_t)> authorization;
    std::function<Result<void>(const Json&)> prepare;
    std::function<Result<void>()> start;
    std::function<Result<void>(const Json&)> views;
    std::function<Result<Json>(const Json&)> stop;
    std::function<Result<Json>()> observe;
    std::function<void()> maintain;
    // Drains queued Viewer channel traffic. Runs on Signal() without the full
    // convergence and maintenance pass; maintain() covers it on its cadence.
    std::function<void()> signals;
    std::function<Result<void>(const Json&, uint64_t)> admit;
    std::function<Result<Json>(const Json&, uint64_t)> request;
    std::function<Result<void>(const Json&, uint64_t)> replay;
    std::function<Result<void>(const std::string&, uint64_t)> acknowledge;
    std::function<void(uint64_t)> management_lost;
    std::function<bool(const Json&, uint64_t)> send;
  };
  SessionCoordinator(Json target,
                     std::string incarnation,
                     std::atomic<uint64_t>& observation_sequence,
                     Hooks hooks);
  ~SessionCoordinator();
  SessionCoordinator(const SessionCoordinator&) = delete;
  void Activate(std::string connection, std::string node_revision, uint64_t generation);
  Result<Json> Publish(const Json& desired, uint64_t generation);
  Result<Json> Request(const Json& request, uint64_t generation);
  Result<Json> Acknowledge(const Json& request, uint64_t generation);
  void ManagementLost(uint64_t generation);
  // Thread-safe. Viewer input and channel events wait on this, not on the
  // maintenance cadence.
  void Signal();
  Result<Json> Execute(const std::function<Result<Json>()>& action);
  Result<Json> Version(const std::function<Result<void>()>& capture,
                       const std::function<Result<void>()>& build,
                       const std::function<Result<Json>()>& commit);
  Json Latest() const;
  Result<Json> Report();
  const Json& Target() const { return target_; }

 private:
  struct Scope {
    std::string connection, node_revision;
    uint64_t generation = 0;
    bool active = false;
  };
  bool Current(uint64_t generation) const;
  bool LatestRevision(const Json& desired) const;
  Result<void> Converge(const Json& desired, const Scope& scope);
  void Observe(const Scope& scope, bool force);
  void Run();
  const Json target_;
  const std::string incarnation_;
  Hooks hooks_;
  RpcResults results_;
  mutable std::mutex mutex_;
  std::condition_variable wake_;
  Scope scope_;
  Json desired_;
  Json latest_ = Json::object();
  std::deque<std::function<void()>> jobs_;
  bool stopping_ = false, force_observation_ = true, signaled_ = false;
  std::string prepared_revision_, started_revision_, views_revision_, stopped_revision_;
  std::string browser_incarnation_, applied_clipboard_revision_ = "0";
  std::atomic<uint64_t>& observation_sequence_;
  bool converged_ = false, observation_oversize_ = false;
  std::optional<Error> error_;
  std::chrono::steady_clock::time_point last_sent_{};
  std::string last_encoded_;
  std::thread worker_;
};
}  // namespace remotekit
