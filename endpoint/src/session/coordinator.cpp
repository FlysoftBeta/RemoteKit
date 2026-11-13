#include "session/coordinator.hpp"
#include "management/payload_limits.hpp"
#include "util/log.hpp"
#include "util/wire_error.hpp"

namespace remotekit {
SessionCoordinator::SessionCoordinator(Json target,
                                       std::string incarnation,
                                       std::atomic<uint64_t>& observation_sequence,
                                       Hooks hooks)
    : target_(std::move(target)),
      incarnation_(std::move(incarnation)),
      hooks_(std::move(hooks)),
      observation_sequence_(observation_sequence),
      worker_([this] { Run(); }) {}
SessionCoordinator::~SessionCoordinator() {
  {
    std::lock_guard lock(mutex_);
    stopping_ = true;
  }
  wake_.notify_all();
  worker_.join();
}
void SessionCoordinator::Activate(std::string connection,
                                  std::string node_revision,
                                  uint64_t generation) {
  {
    std::lock_guard lock(mutex_);
    scope_ = {std::move(connection), std::move(node_revision), generation, true};
    force_observation_ = true;
  }
  wake_.notify_one();
}
bool SessionCoordinator::Current(uint64_t generation) const {
  std::lock_guard lock(mutex_);
  return scope_.active && scope_.generation == generation;
}
bool SessionCoordinator::LatestRevision(const Json& desired) const {
  std::lock_guard lock(mutex_);
  return desired_.is_object() && desired_["revision"] == desired["revision"];
}
Result<Json> SessionCoordinator::Publish(const Json& desired, uint64_t generation) {
  RK_RETURN_IF_ERROR(coordination::ValidateDesired(desired));
  {
    std::lock_guard lock(mutex_);
    if (!scope_.active || scope_.generation != generation ||
        desired["connectionEpoch"] != scope_.connection)
      return Error{ErrorCode::kConflict, "stale management connection"};
    for (const auto* name : {"tenantId", "sessionId", "placementEpoch"})
      if (desired[name] != target_[name])
        return Error{ErrorCode::kConflict, "Session placement is fenced"};
    if (desired_.is_object()) {
      const auto previous = std::stoull(desired_["revision"].get<std::string>());
      const auto revision = std::stoull(desired["revision"].get<std::string>());
      auto normalized = desired;
      auto retained = desired_;
      for (const auto* field : {"id", "connectionEpoch"}) {
        normalized.erase(field);
        retained.erase(field);
      }
      if (revision < previous || (revision == previous && normalized != retained))
        return Error{ErrorCode::kConflict, "desired revision conflicts"};
      if (desired["profileKey"] != desired_["profileKey"])
        return Error{ErrorCode::kConflict, "Session profile key conflicts"};
    }
    desired_ = desired;
    desired_.erase("id");
  }
  if (!desired["authorization"]["unlocked"].get<bool>() || desired["lock"]["state"] != "unlocked") {
    auto revoked = hooks_.authorization(desired, generation);
    if (!revoked && revoked.error().code != ErrorCode::kNotFound)
      return revoked.error();
  }
  wake_.notify_one();
  return Json{{"accepted", true}, {"revision", desired["revision"]}};
}
Result<Json> SessionCoordinator::Execute(const std::function<Result<Json>()>& action) {
  auto promise = std::make_shared<std::promise<Result<Json>>>();
  auto future = promise->get_future();
  {
    std::lock_guard lock(mutex_);
    if (stopping_)
      return Error{ErrorCode::kUnavailable, "Session coordinator is stopping"};
    jobs_.push_back([action, promise] {
      try {
        promise->set_value(action());
      } catch (...) {
        promise->set_value(
            Error{ErrorCode::kOutcomeUnknown, "Session execution did not return a result"});
      }
    });
  }
  wake_.notify_one();
  return future.get();
}
Result<Json> SessionCoordinator::Request(const Json& request, uint64_t generation) {
  if (!coordination::Keys(request,
                          {"method", "tenantId", "sessionId", "placementEpoch",
                           "endpointIncarnation", "opId", "replay", "params"},
                          {"id"}) ||
      !request["params"].is_object())
    return Error{ErrorCode::kInvalidRequest, "invalid Session RPC envelope"};
  if (!Current(generation) || request.value("endpointIncarnation", Json()) != incarnation_)
    return Error{ErrorCode::kConflict, "RPC target is retired"};
  for (const auto* name : {"tenantId", "sessionId", "placementEpoch"})
    if (request.value(name, Json()) != target_[name])
      return Error{ErrorCode::kConflict, "RPC placement is fenced"};
  return Execute([this, request, generation]() -> Result<Json> {
    if (!Current(generation))
      return Error{ErrorCode::kUnavailable, "management disconnected before RPC admission"};
    RK_RETURN_IF_ERROR(hooks_.admit(request, generation));
    auto result = results_.Execute(request, [&] { return hooks_.request(request, generation); });
    if (result && hooks_.replay)
      RK_RETURN_IF_ERROR(hooks_.replay(request, generation));
    return result;
  });
}
Result<Json> SessionCoordinator::Acknowledge(const Json& request, uint64_t generation) {
  if (!coordination::Keys(request,
                          {"method", "tenantId", "sessionId", "placementEpoch", "connectionEpoch",
                           "streamId", "upTo"},
                          {"id"}))
    return Error{ErrorCode::kInvalidRequest, "invalid event acknowledgment"};
  {
    std::lock_guard lock(mutex_);
    if (request["connectionEpoch"] != scope_.connection)
      return Error{ErrorCode::kConflict, "event acknowledgment connection is stale"};
  }
  if (!Current(generation) || !request.contains("streamId") || !request["streamId"].is_string() ||
      !coordination::Counter(request.value("upTo", Json())))
    return Error{ErrorCode::kInvalidRequest, "invalid event acknowledgment"};
  for (const auto* name : {"tenantId", "sessionId", "placementEpoch"})
    if (request.value(name, Json()) != target_[name])
      return Error{ErrorCode::kConflict, "event acknowledgment placement is fenced"};
  return Execute([this, request, generation]() -> Result<Json> {
    if (!Current(generation))
      return Error{ErrorCode::kUnavailable, "management disconnected before acknowledgment"};
    RK_RETURN_IF_ERROR(
        hooks_.acknowledge(request["streamId"], std::stoull(request["upTo"].get<std::string>())));
    return Json{{"accepted", true}, {"upTo", request["upTo"]}};
  });
}
void SessionCoordinator::ManagementLost(uint64_t generation) {
  {
    std::lock_guard lock(mutex_);
    if (generation == 0)
      generation = scope_.generation;
    if (scope_.generation == generation)
      scope_.active = false;
  }
  hooks_.management_lost(generation);
}
Result<Json> SessionCoordinator::Version(const std::function<Result<void>()>& capture,
                                         const std::function<Result<void>()>& build,
                                         const std::function<Result<Json>()>& commit) {
  RK_ASSIGN_OR_RETURN(captured, Execute([&]() -> Result<Json> {
                        RK_RETURN_IF_ERROR(capture());
                        return Json::object();
                      }));
  try {
    RK_RETURN_IF_ERROR(build());
  } catch (const std::exception& error) {
    return Error{ErrorCode::kUnavailable, error.what()};
  }
  return Execute(commit);
}
Json SessionCoordinator::Latest() const {
  std::lock_guard lock(mutex_);
  return latest_;
}
Result<Json> SessionCoordinator::Report() {
  return Execute([this]() -> Result<Json> {
    Scope scope;
    {
      std::lock_guard lock(mutex_);
      scope = scope_;
    }
    Observe(scope, true);
    const auto value = Latest();
    if (value.value("connectionEpoch", Json()) != scope.connection ||
        value.value("nodeRevision", Json()) != scope.node_revision)
      return Error{ErrorCode::kUnavailable, "initial Session observation was not queued"};
    return value;
  });
}
Result<void> SessionCoordinator::Converge(const Json& desired, const Scope& scope) {
  if (!Current(scope.generation) || !LatestRevision(desired) ||
      desired["connectionEpoch"] != scope.connection)
    return {};
  RK_RETURN_IF_ERROR(hooks_.authorization(desired, scope.generation));
  const auto revision = desired["revision"].get<std::string>();
  if (desired["run"] == "stopped") {
    if (stopped_revision_ != revision) {
      auto stopped = hooks_.stop(desired["commit"]);
      if (!stopped)
        return stopped.error();
      stopped_revision_ = revision;
      prepared_revision_.clear();
      started_revision_.clear();
      views_revision_.clear();
    }
    converged_ = true;
    return {};
  }
  stopped_revision_.clear();
  if (prepared_revision_ != revision) {
    RK_RETURN_IF_ERROR(hooks_.prepare(desired));
    prepared_revision_ = revision;
  }
  if (!Current(scope.generation) || !LatestRevision(desired))
    return {};
  if (started_revision_ != revision) {
    Observe(scope, true);
    RK_RETURN_IF_ERROR(hooks_.start());
    started_revision_ = revision;
    applied_clipboard_revision_ = desired["clipboard"]["revision"].get<std::string>();
  }
  if (!Current(scope.generation) || !LatestRevision(desired))
    return {};
  if (views_revision_ != revision) {
    RK_RETURN_IF_ERROR(hooks_.views(desired));
    views_revision_ = revision;
  }
  converged_ = true;
  return {};
}
void SessionCoordinator::Observe(const Scope& scope, bool force) {
  if (!Current(scope.generation))
    return;
  auto sampled = hooks_.observe();
  Json observation;
  if (sampled) {
    observation = std::move(sampled).value();
  } else {
    error_ = sampled.error();
    observation = {
        {"browser", "failed"},
        {"browserIncarnation", nullptr},
        {"browserPid", 0},
        {"browserRestart", "exhausted"},
        {"data", nullptr},
        {"checkpoint", nullptr},
        {"authorization",
         {{"connectionId", nullptr},
          {"epoch", 0},
          {"unlocked", false},
          {"revoked", true},
          {"filesApplied", false}}},
        {"lock", {{"leaseId", nullptr}, {"epoch", 0}, {"state", "locked"}}},
        {"views", Json::array()},
        {"pendingPopups", Json::array()},
        {"recovery", {{"pending", false}, {"views", Json::object()}, {"exportPending", false}}},
        {"rtc", {{"active", false}, {"connectionId", nullptr}, {"avSync", nullptr}}},
        {"blockers",
         {{"unacknowledgedEvents", 0},
          {"pendingNativeSelections", 0},
          {"inFlightUploads", 0},
          {"pendingPageRequests", 0},
          {"downloadsInProgress", 0},
          {"pendingDownloadImports", 0},
          {"rtcConnected", false},
          {"lifecycleUncertain", true}}},
        {"events", {{"streamId", nullptr}, {"ackedThrough", "0"}, {"lastSeq", "0"}}},
        {"stats", Json::object()}};
  }
  const auto incarnation = observation.value("browserIncarnation", Json());
  const auto browser = incarnation.is_string() ? incarnation.get<std::string>() : std::string();
  if (browser != browser_incarnation_) {
    if (!browser_incarnation_.empty()) {
      prepared_revision_.clear();
      started_revision_.clear();
      views_revision_.clear();
      converged_ = false;
    }
    browser_incarnation_ = browser;
  }
  observation.update(target_);
  observation["event"] = "session.observed";
  observation["connectionEpoch"] = scope.connection;
  observation["endpointIncarnation"] = incarnation_;
  observation["nodeRevision"] = scope.node_revision;
  Json desired;
  {
    std::lock_guard lock(mutex_);
    desired = desired_;
  }
  if (desired.is_object() && desired["run"] == "running" &&
      observation.value("browser", Json()) != "running" && !started_revision_.empty()) {
    prepared_revision_.clear();
    started_revision_.clear();
    views_revision_.clear();
    converged_ = false;
  }
  observation["observedRevision"] = desired.is_object() ? desired["revision"] : Json("0");
  const auto revision =
      desired.is_object() ? desired["revision"].get<std::string>() : std::string();
  const bool applied =
      desired.is_object() &&
      (desired["run"] == "running" ? views_revision_ == revision : stopped_revision_ == revision);
  observation["converged"] = converged_ && !error_ && applied;
  observation["lastError"] = error_ ? WireError(*error_) : Json();
  observation["applied"] = {
      {"sitePreferencesRevision", started_revision_.empty() ? "0" : started_revision_},
      {"mediaPolicyRevision", prepared_revision_.empty() ? "0" : prepared_revision_},
      {"viewsRevision", views_revision_.empty() ? "0" : views_revision_},
      {"clipboardRevision", started_revision_.empty() ? "0" : applied_clipboard_revision_}};
  const auto encoded = observation.dump();
  const auto now = std::chrono::steady_clock::now();
  const bool changed = encoded != last_encoded_;
  if ((!force && (!changed || now - last_sent_ < std::chrono::milliseconds(100))) || !scope.active)
    return;
  observation["seq"] =
      std::to_string(observation_sequence_.fetch_add(1, std::memory_order_relaxed) + 1);
  if (!coordination::ObservationFits(observation)) {
    if (!observation_oversize_) {
      Error error{ErrorCode::kLimitExceeded, "Session observation exceeds bound"};
      error.error_id = NewErrorId();
      LogError(LogLevel::kError, "session.observation_dropped", error, target_);
    }
    observation_oversize_ = true;
    return;
  }
  observation_oversize_ = false;
  if (hooks_.send(observation, scope.generation)) {
    last_encoded_ = encoded;
    last_sent_ = now;
    std::lock_guard lock(mutex_);
    latest_ = std::move(observation);
  }
}
void SessionCoordinator::Signal() {
  {
    std::lock_guard lock(mutex_);
    signaled_ = true;
  }
  wake_.notify_one();
}
void SessionCoordinator::Run() {
  constexpr auto kMaintenanceInterval = std::chrono::milliseconds(100);
  auto next_maintenance = std::chrono::steady_clock::now();
  for (;;) {
    Scope scope;
    Json desired;
    std::deque<std::function<void()>> jobs;
    bool force = false;
    {
      std::unique_lock lock(mutex_);
      wake_.wait_until(lock, next_maintenance, [&] {
        return stopping_ || !jobs_.empty() || force_observation_ || signaled_;
      });
      if (stopping_ && jobs_.empty())
        return;
      const bool signals_only = std::exchange(signaled_, false) && jobs_.empty() &&
                                !force_observation_ &&
                                std::chrono::steady_clock::now() < next_maintenance;
      if (signals_only) {
        lock.unlock();
        try {
          hooks_.signals();
        } catch (...) {
          error_ = Error{ErrorCode::kInternal, "Session signal flush failed"};
        }
        continue;
      }
      scope = scope_;
      desired = desired_;
      jobs.swap(jobs_);
      force = std::exchange(force_observation_, false);
    }
    next_maintenance = std::chrono::steady_clock::now() + kMaintenanceInterval;
    try {
      if (desired.is_object() && scope.active) {
        auto converged = Converge(desired, scope);
        if (converged)
          error_.reset();
        else {
          error_ = converged.error();
          converged_ = false;
        }
      }
    } catch (...) {
      error_ = Error{ErrorCode::kInternal, "Session convergence failed"};
    }
    for (auto& job : jobs)
      job();
    try {
      hooks_.maintain();
      Observe(scope, force);
    } catch (...) {
      error_ = Error{ErrorCode::kInternal, "Session observation failed"};
    }
  }
}
}  // namespace remotekit
