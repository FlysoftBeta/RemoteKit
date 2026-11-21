#include "media/gpu_device.hpp"
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
  const auto received = media::QpcNow();
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
    auto next = desired;
    next.erase("id");
    if (desired_ != next)
      ++desired_version_;
    desired_ = std::move(next);
  }
  if (hooks_.received)
    hooks_.received(desired, received);
  if (!desired["authorization"]["unlocked"].get<bool>() || desired["lock"]["state"] != "unlocked") {
    auto revoked = hooks_.authorization(desired, generation);
    if (!revoked && revoked.error().code != ErrorCode::kNotFound)
      return revoked.error();
  }
  wake_.notify_one();
  return Json{{"accepted", true}, {"revision", desired["revision"]}};
}
Result<Json> SessionCoordinator::DeliverClipboard(const Json& document, uint64_t generation) {
  RK_RETURN_IF_ERROR(coordination::ValidateClipboard(document));
  std::lock_guard lock(mutex_);
  if (!scope_.active || scope_.generation != generation ||
      document["connectionEpoch"] != scope_.connection)
    return Error{ErrorCode::kConflict, "stale management connection"};
  for (const auto* name : {"tenantId", "sessionId", "placementEpoch"})
    if (document[name] != target_[name])
      return Error{ErrorCode::kConflict, "Session placement is fenced"};
  RK_RETURN_IF_ERROR(hooks_.clipboard(document));
  wake_.notify_one();
  return Json{{"accepted", true}, {"revision", document["revision"]}};
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
Result<Json> SessionCoordinator::SetFenceError(std::optional<Error> error) {
  return Execute([this, error = std::move(error)]() -> Result<Json> {
    fence_error_ = error;
    error_ = error;
    if (error)
      converged_ = false;
    return Json::object();
  });
}
namespace {
Json GeometryIdentity(Json document) {
  document.erase("revision");
  document.erase("quality");
  for (auto& view : document.at("views"))
    for (const auto* field : {"width", "height", "visible", "occludedBottom", "occlusionRevision"})
      view.erase(field);
  return document;
}
}  // namespace
bool SessionCoordinator::GeometryOnly(const Json& desired) const {
  return hooks_.geometry && converged_identity_.is_object() && desired["run"] == "running" &&
         desired["lock"]["state"] == "unlocked" && desired["authorization"]["unlocked"] == true &&
         !prepared_revision_.empty() && !started_revision_.empty() && !views_revision_.empty() &&
         GeometryIdentity(desired) == converged_identity_;
}
void SessionCoordinator::ResetConvergence() {
  prepared_revision_.clear();
  started_revision_.clear();
  views_revision_.clear();
  converged_identity_ = Json();
}
Result<void> SessionCoordinator::Converge(const Json& desired, const Scope& scope) {
  if (!Current(scope.generation) || !LatestRevision(desired) ||
      desired["connectionEpoch"] != scope.connection)
    return {};
  if (hooks_.converging)
    hooks_.converging(desired, media::QpcNow());
  RK_RETURN_IF_ERROR(hooks_.authorization(desired, scope.generation));
  const auto revision = desired["revision"].get<std::string>();
  if (desired["run"] == "stopped") {
    if (stopped_revision_ != revision) {
      auto stopped = hooks_.stop(desired["commit"], desired["forceStop"].get<bool>());
      if (!stopped)
        return stopped.error();
      stopped_revision_ = revision;
      ResetConvergence();
    }
    converged_ = true;
    return {};
  }
  stopped_revision_.clear();
  if (views_revision_ != revision && GeometryOnly(desired)) {
    // The document differs from the converged one only in geometry. Applying it needs no
    // Session preparation, start or topology reconciliation, which dominate the full pass.
    RK_ASSIGN_OR_RETURN(applied, hooks_.geometry(desired));
    if (applied) {
      prepared_revision_ = started_revision_ = views_revision_ = revision;
      converged_ = true;
      return {};
    }
  }
  // The full pass may change what the identity describes before it completes.
  converged_identity_ = Json();
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
  if (desired["run"] == "running")
    converged_identity_ = GeometryIdentity(desired);
  converged_ = true;
  return {};
}
void SessionCoordinator::Observe(const Scope& scope, bool force, bool immediate) {
  if (!Current(scope.generation))
    return;
  auto sampled = fence_error_                 ? Result<Json>(*fence_error_)
                 : observation_retry_.Ready() ? hooks_.observe()
                                              : Result<Json>(*observation_retry_.Failure());
  Json observation;
  if (sampled) {
    observation_retry_.Success();
    observation = std::move(sampled).value();
  } else {
    observation_retry_.Fail(sampled.error());
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
        {"documentErrors", Json::object()},
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
      ResetConvergence();
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
    ResetConvergence();
    converged_ = false;
  }
  observation["observedRevision"] = desired.is_object() ? desired["revision"] : Json("0");
  const auto revision =
      desired.is_object() ? desired["revision"].get<std::string>() : std::string();
  const bool applied =
      desired.is_object() &&
      (desired["run"] == "running" ? views_revision_ == revision : stopped_revision_ == revision);
  auto failure = error_;
  for (const auto* retry :
       {&convergence_retry_, &maintenance_retry_, &observation_retry_, &signals_retry_})
    if (retry->Failure()) {
      failure = retry->Failure();
      break;
    }
  observation["converged"] = converged_ && !failure && applied;
  observation["lastError"] = failure ? WireError(*failure) : Json();
  observation["applied"] = {
      {"sitePreferencesRevision", started_revision_.empty() ? "0" : started_revision_},
      {"mediaPolicyRevision", prepared_revision_.empty() ? "0" : prepared_revision_},
      {"viewsRevision", views_revision_.empty() ? "0" : views_revision_},
      {"clipboardRevision", started_revision_.empty() ? "0" : applied_clipboard_revision_}};
  const auto encoded = observation.dump();
  const auto now = std::chrono::steady_clock::now();
  const bool changed = encoded != last_encoded_;
  if (!scope.active)
    return;
  constexpr auto kMinimumInterval = std::chrono::milliseconds(100);
  if (!force) {
    if (!changed) {
      observe_due_.reset();
      return;
    }
    if (!immediate && now - last_sent_ < kMinimumInterval) {
      // Leading + latest value: the change goes out when the interval ends, not at the next
      // sample, and carries whatever is newest then.
      observe_due_ = last_sent_ + kMinimumInterval;
      return;
    }
  }
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
    observe_due_.reset();
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
void SessionCoordinator::ObservedChanged() {
  {
    std::lock_guard lock(mutex_);
    if (!observed_changed_)
      observed_changed_at_ = std::chrono::system_clock::now();
    observed_changed_ = true;
  }
  wake_.notify_one();
}
void SessionCoordinator::FlushSignals(const std::string& input) {
  signals_retry_.Input(input);
  if (!signals_retry_.Ready())
    return;
  try {
    auto result = hooks_.signals();
    if (result)
      signals_retry_.Success();
    else {
      error_ = result.error();
      signals_retry_.Fail(*error_);
    }
  } catch (...) {
    error_ = Error{ErrorCode::kInternal, "Session signal flush failed"};
    signals_retry_.Fail(*error_);
  }
}
void SessionCoordinator::Run() {
  constexpr auto kMaintenanceInterval = std::chrono::milliseconds(100);
  auto next_maintenance = std::chrono::steady_clock::now();
  uint64_t handled_desired_version = 0;
  // A newer desired document is applied before maintenance and the observation publish, so
  // neither delays it. Deferring is bounded so a stream of documents cannot starve them.
  std::optional<std::chrono::steady_clock::time_point> deferred_since;
  bool carried_force = false, carried_urgent = false, carried_applied = false;
  for (;;) {
    Scope scope;
    Json desired;
    std::deque<std::function<void()>> jobs;
    bool force = false, urgent = false;
    std::chrono::system_clock::time_point wake_received_at{};
    {
      std::unique_lock lock(mutex_);
      const auto wake_at =
          observe_due_ ? std::min(next_maintenance, *observe_due_) : next_maintenance;
      wake_.wait_until(lock, wake_at, [&] {
        return stopping_ || !jobs_.empty() || force_observation_ || signaled_ || observed_changed_ ||
               desired_version_ != handled_desired_version;
      });
      if (stopping_ && jobs_.empty())
        return;
      if (!signaled_ && jobs_.empty() && !force_observation_ && !observed_changed_ &&
          desired_version_ == handled_desired_version && observe_due_ &&
          std::chrono::steady_clock::now() >= *observe_due_ &&
          std::chrono::steady_clock::now() < next_maintenance) {
        // Only the minimum interval of a deferred change elapsed: publish it without a
        // maintenance pass.
        const auto due_scope = scope_;
        lock.unlock();
        try {
          if (observation_retry_.Ready())
            Observe(due_scope, false, true);
        } catch (...) {
          error_ = Error{ErrorCode::kInternal, "Session observation failed"};
          observation_retry_.Fail(*error_);
        }
        continue;
      }
      const bool signals_only = std::exchange(signaled_, false) && jobs_.empty() &&
                                !force_observation_ && !observed_changed_ &&
                                desired_version_ == handled_desired_version &&
                                std::chrono::steady_clock::now() < next_maintenance;
      if (signals_only) {
        const auto input = desired_.dump() + ":" + std::to_string(scope_.generation);
        lock.unlock();
        FlushSignals(input);
        continue;
      }
      scope = scope_;
      desired = desired_;
      handled_desired_version = desired_version_;
      jobs.swap(jobs_);
      force = std::exchange(force_observation_, false) || std::exchange(carried_force, false);
      if (observed_changed_)
        wake_received_at = observed_changed_at_;
      urgent = std::exchange(observed_changed_, false) || std::exchange(carried_urgent, false);
    }
    bool applied = std::exchange(carried_applied, false);
    const auto defer = [&] {
      // A page state change is observed now; only a document or maintenance may wait.
      if (urgent)
        return false;
      {
        std::lock_guard lock(mutex_);
        if (stopping_ || desired_version_ == handled_desired_version)
          return false;
      }
      const auto now = std::chrono::steady_clock::now();
      if (!deferred_since)
        deferred_since = now;
      if (now - *deferred_since >= kMaintenanceInterval)
        return false;
      carried_force |= force;
      carried_urgent |= urgent;
      carried_applied |= applied;
      return true;
    };
    next_maintenance = std::chrono::steady_clock::now() + kMaintenanceInterval;
    const auto input = desired.dump() + ":" + std::to_string(scope.generation);
    convergence_retry_.Input(input);
    maintenance_retry_.Input(input);
    observation_retry_.Input(input);
    const auto progress = [&] {
      return std::tie(converged_, prepared_revision_, started_revision_, views_revision_,
                      stopped_revision_);
    };
    const auto before = std::make_tuple(converged_, prepared_revision_, started_revision_,
                                        views_revision_, stopped_revision_);
    try {
      if (desired.is_object() && scope.active && !fence_error_ && convergence_retry_.Ready()) {
        auto converged = Converge(desired, scope);
        if (converged) {
          convergence_retry_.Success();
          error_.reset();
        } else {
          convergence_retry_.Fail(converged.error());
          error_ = converged.error();
          converged_ = false;
        }
      }
    } catch (...) {
      error_ = Error{ErrorCode::kInternal, "Session convergence failed"};
      convergence_retry_.Fail(*error_);
    }
    // What a document changed is published at once, not at the next sample.
    applied |= progress() != before || !jobs.empty();
    for (auto& job : jobs)
      job();
    if (defer())
      continue;
    try {
      if (!fence_error_ && maintenance_retry_.Ready()) {
        auto result = hooks_.maintain();
        if (result)
          maintenance_retry_.Success();
        else {
          error_ = result.error();
          maintenance_retry_.Fail(*error_);
        }
      }
    } catch (...) {
      error_ = Error{ErrorCode::kInternal, "Session maintenance failed"};
      maintenance_retry_.Fail(*error_);
    }
    if (defer())
      continue;
    deferred_since.reset();
    try {
      if (observation_retry_.Ready()) {
        const auto sent_before = last_sent_;
        Observe(scope, force, urgent || applied);
        if (urgent && last_sent_ != sent_before) {
          // Wall times let the Browser, Endpoint and Control logs of one change be lined up.
          const auto ms = [](std::chrono::system_clock::time_point at) {
            return std::chrono::duration_cast<std::chrono::milliseconds>(at.time_since_epoch())
                .count();
          };
          LogEvent(LogLevel::kDebug, "session.observed_changed_published",
                   {{"wakeReceivedMs", ms(wake_received_at)},
                    {"publishedMs", ms(std::chrono::system_clock::now())}});
        }
      }
    } catch (...) {
      error_ = Error{ErrorCode::kInternal, "Session observation failed"};
      observation_retry_.Fail(*error_);
    }
  }
}
}  // namespace remotekit
