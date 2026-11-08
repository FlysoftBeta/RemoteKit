#include "service.hpp"
#include "util/wire_error.hpp"
#include "management/methods.hpp"
#include "session/session.hpp"
#include "cluster/node_files.hpp"
#include "persistence/checkpoint.hpp"
#include "util/result_macros.hpp"
#include <fstream>
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
  link_.OnDisconnect([this](uint64_t generation) {
    std::lock_guard lock(mutex_);
    for (auto& [tenant, session] : sessions_)
      session->ManagementLost(generation);
  });
}
Service::~Service() {
  metrics_.Stop();
  object_workers_.Stop();
  link_.OnDisconnect({});
  auto closed = Clear();
  if (!closed)
    fprintf(stderr, "service shutdown: %s\n", closed.error().message.c_str());
}
Result<void> Service::Clear() {
  std::optional<Error> failure;
  for (auto& [tenant, session] : sessions_) {
    auto stopped = failed_ ? session->Stop() : session->Shutdown();
    if (!stopped)
      failure = stopped.error();
  }
  decltype(sessions_) closing;
  {
    std::lock_guard lock(mutex_);
    closing.swap(sessions_);
    session_count_ = 0;
  }
  if (failure)
    return *failure;
  return {};
}
Result<Json> Service::Dispatch(const Json& request, uint64_t generation) {
  if (!request.is_object() || !request.contains("method") || !request["method"].is_string())
    return Error{ErrorCode::kInvalidRequest, "invalid request envelope"};
  const auto method = request["method"].get<std::string>();
  if (method == "shutdown") {
    auto closed = Clear();
    if (!closed)
      return closed.error();
    return Json{{"closed", true}};
  }
  if (method == "object.fetch" || method == "object.delete" || method == "object.inventory")
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
  if (!handler && method != "session.hibernate")
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
        !request["profileKey"].is_string() || !request.contains("objectKey") ||
        !request["objectKey"].is_string() || !request.contains("objectIdKey") ||
        !request["objectIdKey"].is_string() || !request.contains("checkpoint") ||
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
    objects::Keys object_keys;
    for (auto [name, destination] :
         {std::pair{"objectKey", &object_keys.object}, std::pair{"objectIdKey", &object_keys.id}}) {
      auto decoded = cluster::DecodeKey(request[name].get<std::string>());
      if (!decoded)
        return decoded.error();
      *destination = decoded.value();
      SecureZeroMemory(decoded.value().data(), decoded.value().size());
    }
    const auto epoch = request["placementEpoch"].get<uint64_t>();
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
      if (sessions_.size() >= options_.max_sessions)
        return Error{ErrorCode::kLimitExceeded, "node session capacity reached"};
      for (const auto& [other_tenant, session] : sessions_)
        if (session->Id() == id)
          return Error{ErrorCode::kConflict, "sessionId is already open"};
      RK_RETURN_IF_ERROR(Checkpoints(objects_).Restore(options_.data / "sessions" / id, tenant,
                                                       object_keys, id, epoch, options_.build_id,
                                                       request["checkpoint"]));
      auto session = std::make_unique<Session>(sdk_, options_, tenant, id,
                                               request["placementEpoch"].get<uint64_t>(),
                                               key.value(), link_, objects_, object_keys);
      auto initialized = session->Initialize();
      if (!initialized)
        return initialized.error();
      {
        std::lock_guard lock(mutex_);
        sessions_.emplace(tenant, std::move(session));
        session_count_ = sessions_.size();
      }
    }
    if (sessions_.at(tenant)->PlacementEpoch() == epoch) {
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
  if (!sessions_.contains(tenant))
    return Error{ErrorCode::kNotFound, "tenant session is not open"};
  auto& session = *sessions_.at(tenant);
  session.BeginManagementRequest(generation);
  if (method == "session.hibernate") {
    if (!request.contains("placementEpoch") || !request["placementEpoch"].is_number_integer() ||
        request["placementEpoch"] != session.PlacementEpoch())
      return Error{ErrorCode::kConflict, "hibernation placement epoch changed"};
    RK_ASSIGN_OR_RETURN(checkpoint, session.Hibernate(objects_));
    std::lock_guard lock(mutex_);
    sessions_.erase(tenant);
    session_count_ = sessions_.size();
    return checkpoint;
  }
  return handler(session, request);
}
Result<void> Service::Fence(const ManagementLink::ReadyState& ready) {
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
    fs::remove(directory.wstring() + L".checkpoint");
    if (fs::exists(directory))
      fs::last_write_time(directory, fs::file_time_type::clock::now());
    std::lock_guard lock(mutex_);
    it = sessions_.erase(it);
    session_count_ = sessions_.size();
  }
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
  for (const auto* suffix : {"", ".checkpoint", ".checkpoint-index.json", ".restore", ".discard"})
    fs::remove_all(root / (id + suffix));
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
          (name.size() == 32 || name.substr(32) == ".checkpoint" ||
           name.substr(32) == ".checkpoint-index.json" || name.substr(32) == ".restore" ||
           name.substr(32) == ".discard"))
        ids.insert(id);
    }
  }
  for (const auto& id : ids) {
    if (std::any_of(sessions_.begin(), sessions_.end(),
                    [&](const auto& item) { return item.second->Id() == id; }))
      continue;
    const auto directory = root / id;
    const fs::path marker = directory.wstring() + L".checkpoint";
    const bool placed = std::any_of(placements_.begin(), placements_.end(),
                                    [&](const Json& p) { return p["sessionId"] == id; });
    if (placed && fs::exists(marker))
      continue;
    const auto timestamp = fs::exists(directory) ? directory : marker;
    if (expired_only && fs::exists(timestamp) &&
        fs::file_time_type::clock::now() - fs::last_write_time(timestamp) <
            std::chrono::hours(24 * 7))
      continue;
    // All targets are direct children of the configured sessions root with validated IDs.
    for (const auto* suffix : {"", ".checkpoint", ".checkpoint-index.json", ".restore", ".discard"})
      fs::remove_all(root / (id + suffix));
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
  } catch (const Json::exception&) {
    result = Error{ErrorCode::kInvalidRequest, "invalid request JSON"};
  } catch (const std::exception& error) {
    fprintf(stderr, "endpoint internal: %s\n", error.what());
    result = Error{ErrorCode::kInternal, "internal endpoint error"};
  } catch (...) {
    fprintf(stderr, "endpoint internal: unknown exception\n");
    result = Error{ErrorCode::kInternal, "internal endpoint error"};
  }
  for (const auto* name : {"profileKey", "objectKey", "objectIdKey"}) {
    if (request.is_object() && request.contains(name) && request[name].is_string()) {
      auto& key = request[name].get_ref<std::string&>();
      SecureZeroMemory(key.data(), key.size());
      request.erase(name);
    }
  }
  response["ok"] = bool(result);
  if (result)
    response["result"] = std::move(result).value();
  else
    response["error"] = WireError(result.error());
  link_.SendReply(generation, response);
  return result && request.value("method", std::string()) == "shutdown";
}
int Service::Run() {
  auto listening = objects_.Start(options_.peer_listen);
  if (!listening) {
    fprintf(stderr, "peer startup: %s\n", listening.error().message.c_str());
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
        fprintf(stderr, "cold copy sweep: %s\n", swept.error().message.c_str());
      next_sweep = std::chrono::steady_clock::now() + std::chrono::hours(1);
    }
    if (received && link_.Current(generation)) {
      auto envelope = line.size() <= 1024 * 1024 ? Json::parse(line, nullptr, false) : Json();
      SecureZeroMemory(line.data(), line.size());
      line.clear();
      const auto method = envelope.is_object() ? envelope.value("method", Json()) : Json();
      if (method == "object.fetch" || method == "object.delete" || method == "object.inventory") {
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
    fprintf(stderr, "service shutdown: %s\n", closed.error().message.c_str());
    return 1;
  }
  return failed_ ? 1 : 0;
}
}  // namespace remotekit
