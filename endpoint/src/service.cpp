#include "service.hpp"
#include "cluster/node_files.hpp"
#include "diagnostics/log_files.hpp"
#include "management/coordination.hpp"
#include "management/methods.hpp"
#include "persistence/checkpoint.hpp"
#include "persistence/versions.hpp"
#include <stop_token>
#include "util/log.hpp"
#include "util/result_macros.hpp"
#include "util/wire_error.hpp"
#include <future>

namespace remotekit {
Service::Service(media::Sdk& sdk,
                 const RuntimeOptions& options,
                 ManagementLink& link,
                 const cluster::Key& cluster_key,
                 std::string incarnation)
    : sdk_(sdk),
      options_(options),
      link_(link),
      incarnation_(std::move(incarnation)),
      objects_(options.data, link, cluster_key, options.node_id, options.build_id),
      metrics_(options.data) {
  link_.OnPeers([this](const Json& peers) { return objects_.SetPeers(peers); });
  link_.OnBinary([this](const Json& header, std::span<const uint8_t> bytes) {
    auto written = objects_.PutChunk(header, bytes);
  });
  link_.OnDisconnect([this](uint64_t generation) {
    objects_.CancelPuts();
    std::lock_guard lock(mutex_);
    for (auto& [tenant, entry] : service_peers_)
      entry.second->ManagementLost(generation);
    for (auto& [tenant, managed] : sessions_)
      managed.coordinator->ManagementLost(generation);
  });
}
Service::~Service() {
  metrics_.Stop();
  object_workers_.Stop();
  link_.OnDisconnect({});
  link_.OnBinary({});
  link_.OnPeers({});
  auto closed = Clear();
  if (!closed)
    LogError(LogLevel::kWarn, "service.shutdown_failed", closed.error());
}
Result<void> Service::Clear() {
  const auto deadline = PhaseClock::now() + std::chrono::seconds(60);
  objects_.CommitDeadline(deadline);
  decltype(sessions_) closing;
  {
    std::lock_guard lock(mutex_);
    service_peers_.clear();
    closing.swap(sessions_);
    session_count_ = 0;
  }
  std::vector<std::future<void>> stopping;
  for (auto& [tenant, managed] : closing) {
    managed.coordinator->ManagementLost(0);
    stopping.push_back(std::async(std::launch::async, [this, managed, deadline] {
      auto stopped = managed.coordinator->Execute([&]() -> Result<Json> {
        const auto commit = "node-" + incarnation_ + "-" + managed.execution->Id();
        RK_ASSIGN_OR_RETURN(
            copy, Checkpoints::Copy(options_.data / "sessions" / managed.execution->Id()));
        const bool clean = !copy.is_null() && copy.at("state") == "clean";
        return managed.execution->Stop(failed_ || clean ? Json() : Json(commit), false, deadline,
                                       !link_.Current(fenced_generation_));
      });
      if (!stopped)
        LogError(LogLevel::kWarn, "session.shutdown_commit_failed", stopped.error());
    }));
  }
  for (auto& task : stopping)
    task.get();
  return {};
}
Result<Json> Service::Dispatch(const Json& request, uint64_t generation) {
  if (!request.is_object() || !request.value("method", Json()).is_string())
    return Error{ErrorCode::kInvalidRequest, "invalid request envelope"};
  const auto method = request["method"].get<std::string>();
  if (method == "node.desired") {
    RK_RETURN_IF_ERROR(Fence(request, generation));
    return Json{{"accepted", true}, {"revision", request["revision"]}};
  }
  if (generation != fenced_generation_ || !link_.Current(generation))
    return Error{ErrorCode::kUnavailable, "node fencing is not established"};
  const auto tenant = request.value("tenantId", std::string());
  const bool node_rpc = method == "node.logs.search" || method == "shutdown" ||
                        method.starts_with("service.") || method.starts_with("object.") ||
                        method == "session.cold.delete" || method == "session.delete";
  if (node_rpc) {
    if (!coordination::Keys(request,
                            {"method", "tenantId", "sessionId", "placementEpoch",
                             "endpointIncarnation", "opId", "replay", "params"},
                            {"id"}) ||
        !request["sessionId"].is_null() || !request["placementEpoch"].is_null())
      return Error{ErrorCode::kInvalidRequest, "invalid node RPC envelope"};
    if (request.value("endpointIncarnation", Json()) != incarnation_ ||
        !request.value("params", Json()).is_object())
      return Error{ErrorCode::kConflict, "RPC Endpoint target is retired"};
    std::shared_ptr<RpcResults> results;
    {
      std::lock_guard lock(mutex_);
      auto& cache = node_results_[tenant];
      if (!cache)
        cache = std::make_shared<RpcResults>();
      results = cache;
    }
    return results->Execute(request, [&]() -> Result<Json> {
      auto params = request["params"];
      params["tenantId"] = tenant;
      params["method"] = method;
      if (method == "node.logs.search")
        return SearchErrorLogs(options_.node_root, Required(params, "errorId"));
      if (method == "shutdown") {
        RK_RETURN_IF_ERROR(Clear());
        return Json{{"closed", true}};
      }
      if (method.starts_with("service.")) {
        std::shared_ptr<ServicePeer> peer;
        {
          std::lock_guard lock(mutex_);
          auto& entry = service_peers_[tenant];
          const auto lease = Required(params, "leaseId");
          if (method == "service.offer" && (!entry.second || entry.first != lease)) {
            entry = {lease,
                     std::make_shared<ServicePeer>(sdk_, options_, link_, objects_, tenant, lease)};
          }
          if (!entry.second || entry.first != lease)
            return Error{ErrorCode::kConflict, "Viewer service lease is retired"};
          peer = entry.second;
        }
        auto result = peer->Command(method, params, generation);
        if (method == "service.close" && result) {
          std::lock_guard lock(mutex_);
          const auto found = service_peers_.find(tenant);
          if (found != service_peers_.end() && found->second.second == peer)
            service_peers_.erase(found);
        }
        return result;
      }
      if (method.starts_with("object."))
        return objects_.Dispatch(params);
      if (!tenant.empty())
        return Error{ErrorCode::kInvalidRequest, "node deletion requires empty tenantId"};
      if (method == "session.cold.delete")
        return DeleteCold(false);
      return DeleteSession(Required(params, "sessionId"));
    });
  }
  std::shared_ptr<SessionCoordinator> coordinator;
  {
    std::lock_guard lock(mutex_);
    const auto found = sessions_.find(tenant);
    if (found == sessions_.end())
      return Error{ErrorCode::kConflict, "Session placement is fenced"};
    coordinator = found->second.coordinator;
  }
  if (method == "session.desired")
    return coordinator->Publish(request, generation);
  if (method == "session.events.ack")
    return coordinator->Acknowledge(request, generation);
  if (method != "session.logs.read" && !ManagementMethods::Find(method))
    return Error{ErrorCode::kInvalidRequest, "unknown Session RPC: " + method};
  return coordinator->Request(request, generation);
}
Result<void> Service::Fence(const Json& desired, uint64_t generation) {
  RK_RETURN_IF_ERROR(coordination::ValidateNodeDesired(desired));
  if (!link_.Current(generation) || desired["connectionEpoch"] != connection_epoch_)
    return Error{ErrorCode::kConflict, "node.desired connection is stale"};
  auto document = desired;
  document.erase("id");
  if (node_desired_.is_object()) {
    const auto revision = std::stoull(document["revision"].get<std::string>());
    const auto previous = std::stoull(node_desired_["revision"].get<std::string>());
    if (revision < previous || (revision == previous && document != node_desired_))
      return Error{ErrorCode::kConflict, "node.desired revision conflicts"};
  }
  const auto& placements = desired["sessions"];
  std::vector<ManagedSession> retiring;
  {
    std::lock_guard lock(mutex_);
    for (auto it = sessions_.begin(); it != sessions_.end();) {
      const auto& target = it->second.coordinator->Target();
      const bool current =
          std::any_of(placements.begin(), placements.end(), [&](const Json& value) {
            return value["tenantId"] == target["tenantId"] &&
                   value["sessionId"] == target["sessionId"] &&
                   value["placementEpoch"] == target["placementEpoch"];
          });
      if (current) {
        ++it;
      } else {
        it->second.coordinator->ManagementLost(0);
        retiring.push_back(it->second);
        it = sessions_.erase(it);
      }
    }
  }
  for (auto& managed : retiring) {
    RK_ASSIGN_OR_RETURN(stopped, managed.coordinator->Execute([&]() -> Result<Json> {
      RK_RETURN_IF_ERROR(managed.execution->Fence());
      return Json::object();
    }));
    const auto directory = options_.data / "sessions" / managed.execution->Id();
    if (fs::exists(directory))
      fs::last_write_time(directory, fs::file_time_type::clock::now());
  }
  retiring.clear();
  const auto root = options_.data / "sessions";
  fs::create_directories(root);
  for (const auto& entry : fs::directory_iterator(root)) {
    const auto name = entry.path().filename().string();
    if (name.size() != 42 || !name.ends_with(".copy.json"))
      continue;
    const auto id = name.substr(0, 32);
    if (std::none_of(placements.begin(), placements.end(),
                     [&](const Json& value) { return value["sessionId"] == id; }))
      fs::remove(entry.path());
  }
  for (const auto& placement : placements) {
    const auto directory = root / placement["sessionId"].get<std::string>();
    RK_ASSIGN_OR_RETURN(copy, Checkpoints::Copy(directory));
    if (!copy.is_null() &&
        copy["placementEpoch"].get<uint64_t>() < placement["placementEpoch"].get<uint64_t>() &&
        placement["dataState"] == "clean") {
      fs::remove_all(LongPath(directory));
      fs::remove(LongPath(directory).wstring() + L".copy.json");
      fs::remove(LongPath(directory).wstring() + L".checkpoint-index.json");
      RK_RETURN_IF_ERROR(Checkpoints::TruncateChanges(directory));
      copy = nullptr;
    }
    if (!copy.is_null() && copy["placementEpoch"] == placement["placementEpoch"] &&
        copy["state"] == "clean" && !copy["lastCommit"].is_null() &&
        placement["dataState"] == "dirty") {
      RK_ASSIGN_OR_RETURN(details, Checkpoints(objects_).Describe(copy["base"]));
      std::vector<objects::ObjectInfo> pending;
      for (const auto& id : details["objects"]) {
        auto local = objects_.Store().Inspect(id.get<std::string>());
        if (local)
          pending.push_back(std::move(local).value());
      }
      RK_RETURN_IF_ERROR(
          objects_.CommittedBatch(pending, placement["tenantId"].get<std::string>()));
    }
    const auto tenant = placement["tenantId"].get<std::string>();
    ManagedSession managed;
    {
      std::lock_guard lock(mutex_);
      auto& entry = sessions_[tenant];
      if (!entry.coordinator) {
        auto target = placement;
        target.erase("dataState");
        entry.execution =
            std::make_shared<SessionExecution>(sdk_, options_, link_, objects_, target);
        entry.coordinator = std::make_shared<SessionCoordinator>(
            target, incarnation_, observation_sequence_, entry.execution->Hooks());
      }
      managed = entry;
    }
    managed.execution->Activate(connection_epoch_, generation);
    managed.coordinator->Activate(connection_epoch_, desired["revision"], generation);
    RK_ASSIGN_OR_RETURN(observation, managed.coordinator->Report());
  }
  node_desired_ = std::move(document);
  placements_ = placements;
  fenced_generation_ = generation;
  return {};
}
Result<Json> Service::DeleteSession(const std::string& id) {
  if (!coordination::Hex(Json(id), 32))
    return Error{ErrorCode::kInvalidRequest, "invalid sessionId"};
  ManagedSession retiring;
  {
    std::lock_guard lock(mutex_);
    for (auto it = sessions_.begin(); it != sessions_.end(); ++it) {
      if (it->second.execution->Id() == id) {
        retiring = it->second;
        sessions_.erase(it);
        break;
      }
    }
  }
  if (retiring.coordinator) {
    retiring.coordinator->ManagementLost(0);
    RK_ASSIGN_OR_RETURN(stopped, retiring.coordinator->Execute([&]() -> Result<Json> {
      RK_RETURN_IF_ERROR(retiring.execution->Fence());
      return Json::object();
    }));
  }
  placements_.erase(std::remove_if(placements_.begin(), placements_.end(),
                                   [&](const Json& p) { return p["sessionId"] == id; }),
                    placements_.end());
  for (const auto* suffix :
       {"", ".copy.json", ".copy.json.new", ".changes", ".checkpoint-index.json",
        ".checkpoint-index.json.new", ".restore", ".discard"})
    fs::remove_all(options_.data / "sessions" / (id + suffix));
  RK_RETURN_IF_ERROR(DeleteSessionLogs(options_.node_root, id));
  return Json{{"stopped", bool(retiring.coordinator)}};
}
Result<Json> Service::DeleteCold(bool expired_only) {
  const auto root = options_.data / "sessions";
  fs::create_directories(root);
  size_t deleted = 0;
  std::set<std::string> ids;
  for (const auto& entry : fs::directory_iterator(root)) {
    const auto name = entry.path().filename().string();
    if (name.size() >= 32 && coordination::Hex(Json(name.substr(0, 32)), 32))
      ids.insert(name.substr(0, 32));
  }
  for (const auto& id : ids) {
    if (std::any_of(placements_.begin(), placements_.end(),
                    [&](const Json& p) { return p["sessionId"] == id; }))
      continue;
    const auto directory = root / id;
    RK_ASSIGN_OR_RETURN(copy, Checkpoints::Copy(directory));
    if (expired_only && !copy.is_null() && copy["state"] == "dirty")
      continue;
    const fs::path timestamp =
        fs::exists(directory) ? directory : fs::path(directory.wstring() + L".copy.json");
    if (expired_only && fs::exists(timestamp) &&
        fs::file_time_type::clock::now() - fs::last_write_time(timestamp) <
            std::chrono::hours(24 * 7))
      continue;
    RK_ASSIGN_OR_RETURN(result, DeleteSession(id));
    ++deleted;
  }
  return Json{{"deleted", deleted}};
}
bool Service::HandleRequest(Json request, uint64_t generation) {
  if (!link_.Current(generation))
    return false;
  Json response = {{"id", request.is_object() ? request.value("id", Json()) : Json()}};
  if (request.is_object() && request.contains("opId"))
    response["opId"] = request["opId"];
  Result<Json> result = Error{ErrorCode::kInvalidRequest, "invalid request"};
  try {
    result = Dispatch(request, generation);
  } catch (const InvalidRequest& error) {
    result = Error{ErrorCode::kInvalidRequest, error.what()};
  } catch (const Json::exception& error) {
    result = Error{ErrorCode::kInvalidRequest, error.what()};
  } catch (const std::filesystem::filesystem_error& error) {
    result = WithOsError(ErrorCode::kUnavailable, error.what(), OsError::Kind::kWin32,
                         error.code().value());
  } catch (const std::exception& error) {
    LogError(LogLevel::kWarn, "mgmt.exception", Error{ErrorCode::kInternal, error.what()});
    result = Error{ErrorCode::kInternal, "internal Endpoint error"};
  }
  if (request.is_object() && request.value("profileKey", Json()).is_string()) {
    auto& key = request["profileKey"].get_ref<std::string&>();
    SecureZeroMemory(key.data(), key.size());
    request.erase("profileKey");
  }
  response["ok"] = bool(result);
  if (result)
    response["result"] = std::move(result).value();
  else
    response["error"] = WireError(result.error(), "mgmt.request_failed", RequestLogFields(request));
  link_.SendReply(generation, response);
  return result && request.value("method", std::string()) == "shutdown";
}
void Service::Versions() {
  SnapshotClient client(options_.node_id);

  auto unavailable = [&](const Error& error) {
    snapshot_available_ = false;
    if (!snapshot_unavailable_streak_)
      LogError(LogLevel::kWarn, "snapshot.unavailable", error);
    snapshot_unavailable_streak_ = true;
  };
  if (!client.Available()) {
    unavailable(Error{ErrorCode::kUnavailable, "snapshot service is unavailable"});
    return;
  }
  if (!snapshot_unavailable_streak_)
    snapshot_available_ = true;
  int64_t interval = 300000;
#ifndef NDEBUG
  if (const char* value = std::getenv("REMOTEKIT_TEST_VERSION_INTERVAL_MS"))
    interval = std::max<int64_t>(100, std::stoll(value));
#endif
  std::vector<ManagedSession> candidates, due;
  {
    std::lock_guard lock(mutex_);
    for (const auto& [tenant, managed] : sessions_)
      candidates.push_back(managed);
  }
  std::vector<std::string> paths;
  for (const auto& managed : candidates) {
    auto ready = managed.coordinator->Execute([&]() -> Result<Json> {
      return Json(managed.execution->VersionDue(VersionNow(), interval));
    });
    if (!ready)
      LogError(LogLevel::kWarn, "snapshot.schedule_failed", ready.error());
    if (ready && ready.value() == true) {
      due.push_back(managed);
      paths.push_back("sessions/" + managed.execution->Id());
    }
  }
  if (paths.empty())
    return;
  auto taken = client.Take(options_.data, paths);
  if (!taken) {
    unavailable(taken.error());
    return;
  }
  snapshot_available_ = true;
  snapshot_unavailable_streak_ = false;
  for (const auto& managed : due) {
    auto saved = managed.coordinator->Execute(
        [&] { return managed.execution->SaveVersion(client, taken.value()); });
    if (!saved) {
      if (!client.Available())
        unavailable(saved.error());
      LogError(LogLevel::kWarn, "snapshot.version_failed", saved.error());
    } else {
      auto reported = managed.coordinator->Report();
      if (!reported)
        LogError(LogLevel::kWarn, "snapshot.report_failed", reported.error());
    }
  }
  auto released = client.Release(taken.value().at("snapshotId"));
  if (!released)
    unavailable(released.error());
}
int Service::Run() {
  auto listening = objects_.Start(options_.peer_listen);
  if (!listening) {
    LogError(LogLevel::kError, "peer.start_failed", listening.error());
    return 1;
  }
  std::jthread versions([this](std::stop_token stop) {
    std::mutex wait_mutex;
    std::condition_variable_any wake;
    int64_t interval = 60000;
#ifndef NDEBUG
    if (const char* value = std::getenv("REMOTEKIT_TEST_VERSION_CHECK_MS"))
      interval = std::max<int64_t>(100, std::stoll(value));
#endif
    while (!stop.stop_requested()) {
      try {
        Versions();
      } catch (const std::exception& error) {
        LogError(LogLevel::kWarn, "snapshot.version_failed",
                 Error{ErrorCode::kUnavailable, error.what()});
      }
      std::unique_lock lock(wait_mutex);
      wake.wait_for(lock, stop, std::chrono::milliseconds(interval), [] { return false; });
    }
  });
  std::string line;
  auto next_sweep = PhaseClock::now();
  uint64_t configured_generation = 0;
  metrics_.Start([this] { return session_count_.load(); },
                 [this](Json sample) {
                   sample["event"] = "node.metrics";
                   sample["snapshot"] = snapshot_available_.load() ? "available" : "unavailable";
                   link_.SendEvent(sample, metrics_generation_.load());
                 });
  while (!failed_) {
    bool eof = false;
    uint64_t generation = 0;
    const bool received = link_.Next(line, generation, eof);
    if (eof)
      break;
    if (auto ready = link_.ReadyConfiguration();
        ready && ready->generation != configured_generation) {
      auto configured = objects_.Configure(ready->object_keys);
      if (!configured) {
        failed_ = true;
        break;
      }
      configured_generation = ready->generation;
      connection_epoch_ = ready->connection_epoch;
      node_desired_ = nullptr;
      fenced_generation_ = 0;
      metrics_generation_ = ready->generation;
    }
    if (received && link_.Current(generation)) {
      auto envelope = line.size() <= coordination::kMaxDocumentBytes
                          ? Json::parse(line, nullptr, false)
                          : Json();
      SecureZeroMemory(line.data(), line.size());
      line.clear();
      const auto method = envelope.is_object() && envelope.value("method", Json()).is_string()
                              ? envelope["method"].get<std::string>()
                              : std::string();
      if (method == "node.desired" || method == "session.desired" || method == "session.delete" ||
          method == "session.cold.delete" || method == "shutdown") {
        if (HandleRequest(std::move(envelope), generation))
          break;
      } else {
        const auto request_id = envelope.is_object() ? envelope.value("id", Json()) : Json();
        if (!object_workers_.Submit([this, request = std::move(envelope), generation]() mutable {
              HandleRequest(std::move(request), generation);
            }))
          link_.SendReply(generation,
                          {{"id", request_id},
                           {"ok", false},
                           {"error", {{"code", "busy"}, {"message", "management workers busy"}}}});
      }
    }
    if (PhaseClock::now() >= next_sweep) {
      auto swept = DeleteCold(true);
      if (!swept)
        LogError(LogLevel::kWarn, "session.cold_sweep_failed", swept.error());
      next_sweep = PhaseClock::now() + std::chrono::hours(1);
    }
    size_t running = 0;
    {
      std::lock_guard lock(mutex_);
      for (const auto& [tenant, managed] : sessions_)
        running += managed.execution->Running() ? 1 : 0;
    }
    session_count_ = running;
  }
  versions.request_stop();
  versions.join();
  object_workers_.Stop();
  metrics_.Stop();
  auto closed = Clear();
  if (!closed) {
    LogError(LogLevel::kWarn, "service.shutdown_failed", closed.error());
    return 1;
  }
  return failed_ ? 1 : 0;
}
}  // namespace remotekit
