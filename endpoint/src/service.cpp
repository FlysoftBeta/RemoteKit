#include "util/log.hpp"
#include "service.hpp"
#include "diagnostics/log_files.hpp"
#include "util/wire_error.hpp"
#include "management/methods.hpp"
#include "session/session.hpp"
#include "cluster/node_files.hpp"
#include "persistence/checkpoint.hpp"
#include "util/result_macros.hpp"
#include <fstream>
#include <future>
namespace remotekit {
Service::Service(media::Sdk& sdk,
                 const RuntimeOptions& options,
                 ManagementLink& link,
                 const cluster::Key& cluster_key)
    : sdk_(sdk),
      options_(options),
      link_(link),
      objects_(options.data, link, cluster_key, options.node_id, options.build_id),
      metrics_(options.data) {
  link_.OnPeers([this](const Json& peers) { return objects_.SetPeers(peers); });
  link_.OnBinary([this](const Json& header, std::span<const uint8_t> bytes) {
    auto written = objects_.PutChunk(header, bytes);
  });
  link_.OnDisconnect([this](uint64_t generation) {
    objects_.CancelPuts();
    std::lock_guard lock(mutex_);
    for (auto& [tenant, session] : sessions_)
      session->ManagementLost(generation);
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
  std::vector<std::future<void>> stopping;
  for (auto& [tenant, session] : sessions_) {
    stopping.push_back(std::async(std::launch::async, [&session, this] {
      auto stopped = failed_ ? session->Stop() : session->Shutdown();
      if (!stopped)
        LogError(LogLevel::kWarn, "session.shutdown_failed", stopped.error());
    }));
  }
  for (auto& task : stopping)
    task.get();
  for (auto& [tenant, session] : sessions_) {
    const auto request = "node-" + std::to_string(GetCurrentProcessId()) + "-" +
                         std::to_string(QpcNow()) + "-" + session->Id();
    auto stopped = session->StopAndCommit(failed_ ? Json() : Json(request), false, deadline,
                                          !link_.Current(fenced_generation_));
    if (!stopped)
      LogError(LogLevel::kWarn, "session.shutdown_commit_failed", stopped.error());
  }
  decltype(sessions_) closing;
  {
    std::lock_guard lock(mutex_);
    closing.swap(sessions_);
    session_count_ = 0;
  }
  return {};
}
Result<Json> Service::Dispatch(const Json& request, uint64_t generation) {
  if (!request.is_object() || !request.contains("method") || !request["method"].is_string())
    return Error{ErrorCode::kInvalidRequest, "invalid request envelope"};
  const auto method = request["method"].get<std::string>();
  if (method == "node.logs.search")
    return SearchErrorLogs(options_.node_root, Required(request, "errorId"));
  if (method == "shutdown") {
    auto closed = Clear();
    if (!closed)
      return closed.error();
    return Json{{"closed", true}};
  }
  if (method == "object.render" || method == "object.derivation" || method == "object.fetch" ||
      method == "object.delete" || method == "object.inventory" ||
      method.starts_with("object.put."))
    return objects_.Dispatch(request);
  if (method == "session.cold.delete") {
    if (request.value("tenantId", Json()) != "")
      return Error{ErrorCode::kInvalidRequest, "session.cold.delete requires empty tenantId"};
    return DeleteCold(false);
  }
  if (method == "session.delete") {
    if (request.value("tenantId", Json()) != "" || !request.contains("sessionId") ||
        !request["sessionId"].is_string())
      return Error{ErrorCode::kInvalidRequest, "invalid session.delete"};
    return DeleteSession(request["sessionId"].get<std::string>());
  }
  const auto handler = ManagementMethods::Find(method);
  if (!handler && method != "session.stop")
    return Error{ErrorCode::kInvalidRequest, "unknown endpoint method: " + method};
  if (!request.contains("tenantId") || !request["tenantId"].is_string())
    return Error{ErrorCode::kInvalidRequest, "required string: tenantId"};
  const auto tenant = request["tenantId"].get<std::string>();
  if (!objects::ValidTenant(tenant))
    return Error{ErrorCode::kInvalidRequest, "invalid tenant identity"};
  if (method == "session.open") {
    if (!request.contains("sessionId") || !request["sessionId"].is_string() ||
        !request.contains("placementEpoch") || !request["placementEpoch"].is_number_integer() ||
        request["placementEpoch"].get<int64_t>() <= 0 || !request.contains("profileKey") ||
        !request["profileKey"].is_string() || !request.contains("checkpoint") ||
        (!request["checkpoint"].is_null() &&
         (!request["checkpoint"].is_string() ||
          !objects::ValidId(request["checkpoint"].get<std::string>()))))
      return Error{ErrorCode::kInvalidRequest, "invalid session.open"};
    const auto id = request["sessionId"].get<std::string>();
    if (id.size() != 32 || !std::all_of(id.begin(), id.end(), [](char c) {
          return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
        }))
      return Error{ErrorCode::kInvalidRequest, "invalid sessionId"};
    auto key = cluster::DecodeKey(request["profileKey"].get<std::string>());
    if (!key)
      return key.error();
    struct ClearKey {
      cluster::Key& key;
      ~ClearKey() { SecureZeroMemory(key.data(), key.size()); }
    } clear_key{key.value()};
    const auto epoch = request["placementEpoch"].get<uint64_t>();
    const auto directory = options_.data / "sessions" / id;
    RK_ASSIGN_OR_RETURN(copy, Checkpoints::Copy(directory));
    if (!copy.is_null() && copy["placementEpoch"].get<uint64_t>() > epoch)
      return Error{ErrorCode::kConflict, "session placement is fenced"};
    for (const auto& placement : placements_)
      if (placement["tenantId"] == tenant &&
          (placement["placementEpoch"].get<uint64_t>() > epoch ||
           (placement["placementEpoch"] == epoch && placement["sessionId"] != id)))
        return Error{ErrorCode::kConflict, "session placement is fenced"};
    if (sessions_.contains(tenant) && epoch > sessions_.at(tenant)->PlacementEpoch()) {
      RK_RETURN_IF_ERROR(sessions_.at(tenant)->Stop());
      std::lock_guard lock(mutex_);
      sessions_.erase(tenant);
      session_count_ = sessions_.size();
    }
    if (!sessions_.contains(tenant)) {
      for (const auto& [other_tenant, session] : sessions_)
        if (session->Id() == id)
          return Error{ErrorCode::kConflict, "sessionId is already open"};
      auto access = std::make_shared<objects::SessionObjects>(objects_, tenant);
      auto phases = RestorePhases();
      phases["event"] = "session.open.timing";
      phases["tenantId"] = tenant;
      const auto restore_start = PhaseClock::now();
      phases["startedQpc"] = QpcNow();
      const bool reuse = Checkpoints::ReuseCopy(copy, epoch, request["checkpoint"]);
      if (reuse) {
        phases["mode"] = "reuse";
      } else {
        if (!copy.is_null() && request["checkpoint"].is_null())
          return Error{ErrorCode::kConflict, "Session copy base differs from requested checkpoint"};
        RK_RETURN_IF_ERROR(Checkpoints(objects_, access, &phases)
                               .Restore(directory, tenant, request["checkpoint"]));
        copy = {{"sessionId", id},      {"placementEpoch", epoch}, {"base", request["checkpoint"]},
                {"state", "clean"},     {"stoppedCleanly", true},  {"changesAt", 0},
                {"lastCommit", nullptr}};
        RK_RETURN_IF_ERROR(Checkpoints::WriteCopy(directory, copy));
        RK_RETURN_IF_ERROR(Checkpoints::TruncateChanges(directory));
      }
      auto session = std::make_unique<Session>(sdk_, options_, tenant, id,
                                               request["placementEpoch"].get<uint64_t>(),
                                               key.value(), link_, objects_, access);
      const auto initialize_start = PhaseClock::now();
      auto initialized = session->Initialize();
      if (!initialized)
        return initialized.error();
      phases["initialization"] = PhaseMs(initialize_start);
      phases["restoreTotal"] = PhaseMs(restore_start);
      session->SetOpenTiming(std::move(phases));
      {
        std::lock_guard lock(mutex_);
        sessions_.emplace(tenant, std::move(session));
        session_count_ = sessions_.size();
      }
    }
    if (sessions_.at(tenant)->PlacementEpoch() == epoch) {
      sessions_.at(tenant)->BeginManagementRequest(generation);
      auto identity = sessions_.at(tenant)->Open(request);
      if (!identity)
        return identity.error();
      placements_.erase(
          std::remove_if(placements_.begin(), placements_.end(),
                         [&](const Json& placement) { return placement["tenantId"] == tenant; }),
          placements_.end());
      placements_.push_back({{"tenantId", tenant}, {"sessionId", id}, {"placementEpoch", epoch}});
    }
  }
  if (method == "session.stop") {
    if (!request.contains("placementEpoch") || !request["placementEpoch"].is_number_integer() ||
        request["placementEpoch"].get<int64_t>() <= 0 || !request.contains("commit") ||
        (!request["commit"].is_null() &&
         (!request["commit"].is_string() || request["commit"].get<std::string>().empty() ||
          request["commit"].get<std::string>().size() > 128)))
      return Error{ErrorCode::kInvalidRequest, "invalid session.stop"};
    const auto placement =
        std::find_if(placements_.begin(), placements_.end(),
                     [&](const Json& value) { return value["tenantId"] == tenant; });
    if (placement == placements_.end() ||
        (*placement)["placementEpoch"] != request["placementEpoch"])
      return Error{ErrorCode::kConflict, "stop placement epoch changed"};
    const auto directory =
        options_.data / "sessions" / (*placement)["sessionId"].get<std::string>();
    RK_ASSIGN_OR_RETURN(copy, Checkpoints::Copy(directory));
    if (copy.is_null())
      return Error{ErrorCode::kNotFound, "Session copy is missing"};
    if (copy["placementEpoch"] != request["placementEpoch"])
      return Error{ErrorCode::kConflict, "stop placement epoch changed"};
    const auto commit = request["commit"];
    if (!commit.is_null() && !copy["lastCommit"].is_null() &&
        copy["lastCommit"]["requestId"] == commit) {
      RK_ASSIGN_OR_RETURN(details,
                          Checkpoints(objects_).Describe(copy["lastCommit"]["manifestId"]));
      details.update(
          {{"state", copy["state"]}, {"base", copy["base"]}, {"committed", copy["lastCommit"]}});
      return details;
    }
    if (!sessions_.contains(tenant)) {
      if (copy["state"] == "clean" || commit.is_null()) {
        Json details = Json::object();
        if (!copy["base"].is_null()) {
          RK_ASSIGN_OR_RETURN(checkpoint, Checkpoints(objects_).Describe(copy["base"]));
          details = std::move(checkpoint);
        }
        details.update({{"state", copy["state"]}, {"base", copy["base"]}, {"committed", nullptr}});
        return details;
      }
      if (!copy["stoppedCleanly"].get<bool>())
        return Error{ErrorCode::kConflict, "stop blocked: lifecycleUncertain"};
      CheckpointCache cache;
      RK_RETURN_IF_ERROR(cache.Start(directory));
      cache.Stop();
      RK_ASSIGN_OR_RETURN(
          checkpoint,
          Checkpoints(objects_, {}, nullptr, &cache).Create(directory, tenant, options_.build_id));
      copy["state"] = "clean";
      copy["base"] = checkpoint["manifestId"];
      copy["lastCommit"] = {{"requestId", commit}, {"manifestId", checkpoint["manifestId"]}};
      RK_RETURN_IF_ERROR(Checkpoints::WriteCopy(directory, copy));
      RK_RETURN_IF_ERROR(Checkpoints::TruncateChanges(directory));
      return Json{{"state", "clean"},
                  {"base", copy["base"]},
                  {"committed", copy["lastCommit"]},
                  {"objects", checkpoint["objects"]},
                  {"buildId", options_.build_id}};
    }
    auto& session = *sessions_.at(tenant);
    session.BeginManagementRequest(generation);
    auto result = session.StopAndCommit(commit);
    if (result || result.error().code == ErrorCode::kOutcomeUnknown) {
      std::lock_guard lock(mutex_);
      sessions_.erase(tenant);
      session_count_ = sessions_.size();
    }
    return result;
  }
  if (!sessions_.contains(tenant))
    return Error{ErrorCode::kNotFound, "tenant session is not open"};
  auto& session = *sessions_.at(tenant);
  session.BeginManagementRequest(generation);
  return handler(session, request);
}
Result<void> Service::Fence(const ManagementLink::ReadyState& ready) {
  RK_RETURN_IF_ERROR(objects_.Configure(ready.object_keys));
  for (auto it = sessions_.begin(); it != sessions_.end();) {
    const bool current =
        std::any_of(ready.sessions.begin(), ready.sessions.end(), [&](const Json& p) {
          return p["tenantId"] == it->first && p["sessionId"] == it->second->Id() &&
                 p["placementEpoch"] == it->second->PlacementEpoch();
        });
    if (current) {
      ++it;
      continue;
    }
    RK_RETURN_IF_ERROR(it->second->Stop());
    const auto directory = options_.data / "sessions" / it->second->Id();
    if (fs::exists(directory))
      fs::last_write_time(directory, fs::file_time_type::clock::now());
    std::lock_guard lock(mutex_);
    it = sessions_.erase(it);
    session_count_ = sessions_.size();
  }
  const auto root = options_.data / "sessions";
  fs::create_directories(root);
  for (const auto& entry : fs::directory_iterator(root)) {
    const auto name = entry.path().filename().string();
    if (name.size() != 42 || !name.ends_with(".copy.json"))
      continue;
    const auto id = name.substr(0, 32);
    if (std::none_of(ready.sessions.begin(), ready.sessions.end(),
                     [&](const Json& p) { return p["sessionId"] == id; }))
      fs::remove(entry.path());
  }
  for (const auto& placement : ready.sessions) {
    const auto directory = options_.data / "sessions" / placement["sessionId"].get<std::string>();
    RK_ASSIGN_OR_RETURN(copy, Checkpoints::Copy(directory));
    if (!copy.is_null() &&
        copy["placementEpoch"].get<uint64_t>() < placement["placementEpoch"].get<uint64_t>() &&
        placement.at("dataState") == "clean") {
      fs::remove_all(LongPath(directory));
      fs::remove(LongPath(directory).wstring() + L".copy.json");
      fs::remove(LongPath(directory).wstring() + L".checkpoint-index.json");
      RK_RETURN_IF_ERROR(Checkpoints::TruncateChanges(directory));
    }
  }
  for (const auto& placement : ready.sessions) {
    const auto directory = options_.data / "sessions" / placement["sessionId"].get<std::string>();
    RK_ASSIGN_OR_RETURN(copy, Checkpoints::Copy(directory));
    if (copy.is_null())
      continue;
    if (copy["placementEpoch"] != placement["placementEpoch"])
      continue;
    Json entry = placement;
    entry["copy"] = {
        {"state", copy["state"]}, {"base", copy["base"]}, {"lastCommit", copy["lastCommit"]}};
    if (copy["state"] == "clean" && !copy["lastCommit"].is_null()) {
      RK_ASSIGN_OR_RETURN(details, Checkpoints(objects_).Describe(copy["base"]));
      if (placement.at("dataState") == "dirty") {
        std::vector<objects::ObjectInfo> pending;
        for (const auto& id : details["objects"]) {
          auto local = objects_.Store().Inspect(id.get<std::string>());
          if (local)
            pending.push_back(std::move(local).value());
        }
        RK_RETURN_IF_ERROR(
            objects_.CommittedBatch(pending, placement["tenantId"].get<std::string>()));
      }
      entry["checkpoint"] = details;
    }
    if (!link_.SendEvent(
            {{"event", "node.ready"}, {"sessions", Json::array({entry})}, {"complete", false}},
            ready.generation))
      return Error{ErrorCode::kUnavailable, "Session copy report was not queued"};
  }
  if (!link_.SendEvent({{"event", "node.ready"}, {"sessions", Json::array()}, {"complete", true}},
                       ready.generation))
    return Error{ErrorCode::kUnavailable, "Session copy report was not queued"};
  placements_ = ready.sessions;
  fenced_generation_ = ready.generation;
  metrics_generation_ = ready.generation;
  return {};
}
// A deleted Tenant's Session is stopped without a checkpoint and every local copy is removed.
Result<Json> Service::DeleteSession(const std::string& id) {
  if (id.size() != 32 || !std::all_of(id.begin(), id.end(), [](char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
      }))
    return Error{ErrorCode::kInvalidRequest, "invalid sessionId"};
  bool stopped = false;
  for (auto it = sessions_.begin(); it != sessions_.end(); ++it) {
    if (it->second->Id() != id)
      continue;
    RK_RETURN_IF_ERROR(it->second->Stop());
    std::lock_guard lock(mutex_);
    sessions_.erase(it);
    session_count_ = sessions_.size();
    stopped = true;
    break;
  }
  placements_.erase(std::remove_if(placements_.begin(), placements_.end(),
                                   [&](const Json& p) { return p["sessionId"] == id; }),
                    placements_.end());
  const auto root = options_.data / "sessions";
  for (const auto* suffix :
       {"", ".copy.json", ".copy.json.new", ".changes", ".checkpoint-index.json",
        ".checkpoint-index.json.new", ".restore", ".discard"})
    fs::remove_all(root / (id + suffix));
  RK_RETURN_IF_ERROR(DeleteSessionLogs(options_.node_root, id));
  return Json{{"stopped", stopped}};
}
Result<Json> Service::DeleteCold(bool expired_only) {
  const auto root = options_.data / "sessions";
  fs::create_directories(root);
  size_t deleted = 0;
  std::set<std::string> ids;
  for (const auto& entry : fs::directory_iterator(root)) {
    const auto name = entry.path().filename().string();
    if (name.size() >= 32) {
      const auto id = name.substr(0, 32);
      if (std::all_of(id.begin(), id.end(),
                      [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); }) &&
          (name.size() == 32 || name.substr(32) == ".copy.json" || name.substr(32) == ".changes" ||
           name.substr(32) == ".copy.json.new" || name.substr(32) == ".checkpoint-index.json" ||
           name.substr(32) == ".checkpoint-index.json.new" || name.substr(32) == ".restore" ||
           name.substr(32) == ".discard"))
        ids.insert(id);
    }
  }
  for (const auto& id : ids) {
    if (std::any_of(sessions_.begin(), sessions_.end(),
                    [&](const auto& item) { return item.second->Id() == id; }))
      continue;
    const auto directory = root / id;
    RK_ASSIGN_OR_RETURN(copy, Checkpoints::Copy(directory));
    const bool placed = std::any_of(placements_.begin(), placements_.end(),
                                    [&](const Json& p) { return p["sessionId"] == id; });
    if (placed || (expired_only && !copy.is_null() && copy["state"] == "dirty"))
      continue;
    const fs::path timestamp =
        fs::exists(directory) ? directory : fs::path(directory.wstring() + L".copy.json");
    if (expired_only && fs::exists(timestamp) &&
        fs::file_time_type::clock::now() - fs::last_write_time(timestamp) <
            std::chrono::hours(24 * 7))
      continue;
    // All targets are direct children of the configured sessions root with validated IDs.
    for (const auto* suffix :
         {"", ".copy.json", ".copy.json.new", ".changes", ".checkpoint-index.json",
          ".checkpoint-index.json.new", ".restore", ".discard"})
      fs::remove_all(root / (id + suffix));
    RK_RETURN_IF_ERROR(DeleteSessionLogs(options_.node_root, id));
    ++deleted;
  }
  return Json{{"deleted", deleted}};
}
bool Service::HandleRequest(Json request, uint64_t generation) {
  if (!link_.Current(generation))
    return false;
  Json response = {{"id", nullptr}};
  Result<Json> result = Error{ErrorCode::kInvalidRequest, "invalid request"};
  try {
    if (request.is_object())
      response["id"] = request.value("id", Json(nullptr));
    result = Dispatch(request, generation);
  } catch (const InvalidRequest& error) {
    result = Error{ErrorCode::kInvalidRequest, error.what()};
  } catch (const Json::exception& error) {
    const auto method = request.is_object() && request.value("method", Json()).is_string()
                            ? request["method"].get<std::string>()
                            : "?";
    LogError(LogLevel::kWarn, "mgmt.invalid_json", Error{ErrorCode::kInternal, error.what()},
             {{"method", method}});
    result = Error{ErrorCode::kInternal, "Unexpected JSON failure in " + method};
  } catch (const std::filesystem::filesystem_error& error) {
    result = WithOsError(ErrorCode::kUnavailable, error.what(), OsError::Kind::kWin32,
                         error.code().value());
  } catch (const std::exception& error) {
    LogError(LogLevel::kWarn, "mgmt.exception", Error{ErrorCode::kInternal, error.what()});
    result = Error{ErrorCode::kInternal, "internal endpoint error"};
  } catch (...) {
    LogError(LogLevel::kWarn, "mgmt.exception", Error{ErrorCode::kInternal, "unknown exception"});
    result = Error{ErrorCode::kInternal, "internal endpoint error"};
  }
  for (const auto* name : {"profileKey"}) {
    if (request.is_object() && request.contains(name) && request[name].is_string()) {
      auto& key = request[name].get_ref<std::string&>();
      SecureZeroMemory(key.data(), key.size());
      request.erase(name);
    }
  }
  response["ok"] = bool(result);
  if (result)
    response["result"] = std::move(result).value();
  else {
    auto fields = RequestLogFields(request);
    if (fields.contains("tenantId")) {
      std::lock_guard lock(mutex_);
      const auto session = sessions_.find(fields["tenantId"].get<std::string>());
      if (session != sessions_.end())
        fields["sessionId"] = session->second->Id();
    }
    response["error"] = WireError(result.error(), "mgmt.request_failed", std::move(fields));
  }
  link_.SendReply(generation, response);
  return result && request.value("method", std::string()) == "shutdown";
}
int Service::Run() {
  auto listening = objects_.Start(options_.peer_listen);
  if (!listening) {
    LogError(LogLevel::kError, "peer.start_failed", listening.error());
    return 1;
  }
  std::string line, maintenance_cursor;
  auto next_sweep = std::chrono::steady_clock::now();
  metrics_.Start([this] { return session_count_.load(); },
                 [this](Json sample) {
                   sample["event"] = "node.metrics";
                   link_.SendEvent(sample, metrics_generation_.load());
                 });
  while (!failed_) {
    bool eof = false;
    uint64_t generation = 0;
    const bool received = link_.Next(line, generation, eof);
    if (eof)
      break;
    if (auto ready = link_.ReadySessions(); ready && ready->generation != fenced_generation_) {
      auto fenced = Fence(*ready);
      if (!fenced) {
        failed_ = true;
        break;
      }
    }
    if (std::chrono::steady_clock::now() >= next_sweep) {
      auto swept = DeleteCold(true);
      if (!swept)
        LogError(LogLevel::kWarn, "session.cold_sweep_failed", swept.error());
      next_sweep = std::chrono::steady_clock::now() + std::chrono::hours(1);
    }
    if (received && link_.Current(generation)) {
      auto envelope = line.size() <= 1024 * 1024 ? Json::parse(line, nullptr, false) : Json();
      SecureZeroMemory(line.data(), line.size());
      line.clear();
      const auto method = envelope.is_object() && envelope.value("method", Json()).is_string()
                              ? envelope["method"].get<std::string>()
                              : std::string();
      if (method == "object.render" || method == "object.derivation" || method == "object.fetch" ||
          method == "object.delete" || method == "object.inventory" ||
          method.starts_with("object.put.")) {
        const auto request_id = envelope.value("id", Json());
        if (!object_workers_.Submit([this, request = std::move(envelope), generation]() mutable {
              HandleRequest(std::move(request), generation);
            })) {
          link_.SendReply(generation,
                          {{"id", request_id},
                           {"ok", false},
                           {"error", {{"code", "busy"}, {"message", "object workers busy"}}}});
        }
      } else if (HandleRequest(std::move(envelope), generation))
        break;
    }
    for (auto& [tenant, session] : sessions_)
      session->FlushSignals();
    if (!sessions_.empty()) {
      auto selected = sessions_.upper_bound(maintenance_cursor);
      if (selected == sessions_.end())
        selected = sessions_.begin();
      maintenance_cursor = selected->first;
      selected->second->MaintainRecovery();
    }
  }
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
