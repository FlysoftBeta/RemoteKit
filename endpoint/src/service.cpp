#include "service.hpp"
#include "management/methods.hpp"
#include "session/session.hpp"
#include <cctype>
namespace remotekit {
Service::Service(media::Sdk& sdk, const RuntimeOptions& options, ManagementLink& link)
    : sdk_(sdk),
      options_(options),
      link_(link),
      store_(options.data),
      registry_(store_.Load("sessions.json", {{"next", 1}, {"tenants", Json::object()}})) {
  link_.OnDisconnect([this](uint64_t generation) {
    std::lock_guard lock(mutex_);
    for (auto& [tenant, session] : sessions_)
      session->ManagementLost(generation);
  });
}
Service::~Service() {
  link_.OnDisconnect({});
  auto closed = Clear();
  if (!closed)
    fprintf(stderr, "service shutdown: %s\n", closed.error().message.c_str());
}
Result<void> Service::Clear() {
  for (auto& [tenant, session] : sessions_) {
    auto stopped = session->Stop();
    if (!stopped)
      return stopped.error();
  }
  decltype(sessions_) closing;
  {
    std::lock_guard lock(mutex_);
    closing.swap(sessions_);
  }
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
  const auto handler = ManagementMethods::Find(method);
  if (!handler)
    return Error{ErrorCode::kInvalidRequest, "unknown endpoint method: " + method};
  if (!request.contains("tenantId") || !request["tenantId"].is_string())
    return Error{ErrorCode::kInvalidRequest, "required string: tenantId"};
  const auto tenant = request["tenantId"].get<std::string>();
  if (tenant.empty() || tenant.size() > 128 ||
      !std::all_of(tenant.begin(), tenant.end(),
                   [](unsigned char c) { return std::isalnum(c) || c == '-' || c == '_'; }))
    return Error{ErrorCode::kInvalidRequest, "invalid tenant identity"};
  if (!sessions_.contains(tenant)) {
    if (!registry_["tenants"].contains(tenant)) {
      auto next = registry_;
      const auto id = next["next"].get<uint64_t>();
      next["next"] = id + 1;
      next["tenants"][tenant] = std::to_string(id);
      auto saved = store_.Save("sessions.json", next);
      if (!saved)
        return saved.error();
      registry_ = std::move(next);
    }
    auto session = std::make_unique<Session>(
        sdk_, options_, tenant, registry_["tenants"][tenant].get<std::string>(), link_);
    auto initialized = session->Initialize();
    if (!initialized)
      return initialized.error();
    {
      std::lock_guard lock(mutex_);
      sessions_.emplace(tenant, std::move(session));
    }
  }
  auto& session = *sessions_.at(tenant);
  session.BeginManagementRequest(generation);
  return handler(session, request);
}
int Service::Run() {
  std::string line, maintenance_cursor;
  while (!failed_) {
    bool eof = false;
    uint64_t generation = 0;
    const bool received = link_.Next(line, generation, eof);
    if (eof)
      break;
    if (received) {
      Json request;
      Json response = {{"id", nullptr}};
      Result<Json> result = Error{ErrorCode::kInvalidRequest, "request exceeds 1 MiB"};
      try {
        if (line.size() <= 1024 * 1024) {
          request = Json::parse(line);
          if (request.is_object())
            response["id"] = request.value("id", Json(nullptr));
          result = Dispatch(request, generation);
        }
      } catch (const Json::exception& error) {
        fprintf(stderr, "endpoint invalid request: %s\n", error.what());
        result = Error{ErrorCode::kInvalidRequest, "invalid request JSON"};
      } catch (const std::exception& error) {
        fprintf(stderr, "endpoint internal: %s\n", error.what());
        result = Error{ErrorCode::kInternal, "internal endpoint error"};
      } catch (...) {
        fprintf(stderr, "endpoint internal: unknown exception\n");
        result = Error{ErrorCode::kInternal, "internal endpoint error"};
      }
      response["ok"] = bool(result);
      if (result)
        response["result"] = std::move(result).value();
      else
        response["error"] = {{"code", ErrorCodeName(result.error().code)},
                             {"message", result.error().message}};
      link_.SendReply(generation, response);
      if (result && request.value("method", std::string()) == "shutdown")
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
  auto closed = Clear();
  if (!closed) {
    fprintf(stderr, "service shutdown: %s\n", closed.error().message.c_str());
    return 1;
  }
  return failed_ ? 1 : 0;
}
}  // namespace remotekit
