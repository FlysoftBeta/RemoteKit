#include "objects/service.hpp"
#include "util/result_macros.hpp"
#include <future>
namespace remotekit::objects {
ObjectService::ObjectService(std::filesystem::path data,
                             ManagementLink& control,
                             const Key& key,
                             std::string node,
                             std::string build)
    : store_(std::move(data)),
      control_(control),
      server_(store_, key, node, build),
      client_(store_, key, std::move(node), std::move(build)) {}
Result<void> ObjectService::Start(const std::string& listen) {
  return server_.Start(listen);
}
Result<void> ObjectService::Committed(const ObjectInfo& info, const std::string& derived_from) {
  auto fields = info.Committed();
  if (!derived_from.empty() && derived_from != info.id)
    fields["derivedFrom"] = derived_from;
  auto reply = control_.Request("object.committed", std::move(fields));
  if (!reply) {
    if (reply.error().code == ErrorCode::kConflict)
      RK_RETURN_IF_ERROR(store_.Delete(info.tenant, info.id));
    return reply.error();
  }
  return {};
}
Result<ObjectInfo> ObjectService::Fetch(const std::string& tenant,
                                        const std::string& id,
                                        const Json& sources) {
  if (!sources.is_array() || sources.size() > 256)
    return Error{ErrorCode::kInvalidRequest, "invalid object sources"};
  Error last{ErrorCode::kUnavailable, "no object source available"};
  for (const auto& source : sources) {
    if (!source.is_object() || !source.contains("nodeId") || !source["nodeId"].is_string() ||
        !source.contains("address") || !source["address"].is_string())
      return Error{ErrorCode::kInvalidRequest, "invalid object source"};
    auto fetched = client_.Fetch(tenant, id, source["address"].get<std::string>());
    if (!fetched) {
      last = fetched.error();
      continue;
    }
    RK_RETURN_IF_ERROR(Committed(fetched.value()));
    return fetched;
  }
  return last;
}
Result<ObjectInfo> ObjectService::Ensure(const std::string& tenant, const std::string& id) {
  auto task = std::make_shared<std::packaged_task<Result<ObjectInfo>()>>(
      [this, tenant, id] { return EnsureLocal(tenant, id); });
  auto result = task->get_future();
  if (!work_.Submit([task] { (*task)(); }))
    return Error{ErrorCode::kBusy, "object workers busy"};
  return result.get();
}
Result<ObjectInfo> ObjectService::Write(const std::string& tenant,
                                        const Keys& keys,
                                        const std::filesystem::path& path,
                                        const ObjectStore::Check& check,
                                        const std::string& derived_from) {
  auto task =
      std::make_shared<std::packaged_task<Result<ObjectInfo>()>>([&, this]() -> Result<ObjectInfo> {
        RK_ASSIGN_OR_RETURN(info, store_.Write(tenant, keys, path, check));
        RK_RETURN_IF_ERROR(Committed(info, derived_from));
        return info;
      });
  auto result = task->get_future();
  if (!work_.Submit([task] { (*task)(); }))
    return Error{ErrorCode::kBusy, "object workers busy"};
  return result.get();
}
Result<ObjectInfo> ObjectService::EnsureLocal(const std::string& tenant, const std::string& id) {
  if (!ValidTenant(tenant) || !ValidId(id))
    return Error{ErrorCode::kInvalidRequest, "invalid object identity"};
  std::lock_guard lock(transfers_[std::hash<std::string>{}(tenant + id) % transfers_.size()]);
  auto local = store_.Inspect(tenant, id);
  if (local) {
    RK_RETURN_IF_ERROR(Committed(local.value()));
    return local;
  }
  if (local.error().code != ErrorCode::kNotFound)
    return local.error();
  RK_ASSIGN_OR_RETURN(located, control_.Request("object.locate", {{"tenantId", tenant},
                                                                  {"ids", Json::array({id})}}));
  if (!located.is_object() || !located.contains("sources") || !located["sources"].is_object() ||
      !located["sources"].contains(id))
    return Error{ErrorCode::kRejected, "invalid object.locate reply"};
  return Fetch(tenant, id, located["sources"][id]);
}
Result<Json> ObjectService::Dispatch(const Json& request) {
  const auto method = request.value("method", std::string());
  if (method == "object.inventory")
    return store_.Inventory(request.value("cursor", Json(nullptr)));
  if (!request.contains("tenantId") || !request["tenantId"].is_string() ||
      !ValidTenant(request["tenantId"].get<std::string>()))
    return Error{ErrorCode::kInvalidRequest, "invalid tenant identity"};
  const auto tenant = request["tenantId"].get<std::string>();
  if (!request.contains("ids") || !request["ids"].is_array() || request["ids"].size() > 4096)
    return Error{ErrorCode::kInvalidRequest, "invalid object ids"};
  for (const auto& id : request["ids"])
    if (!id.is_string() || !ValidId(id.get<std::string>()))
      return Error{ErrorCode::kInvalidRequest, "invalid object id"};
  if (method == "object.fetch" && (!request.contains("sources") || !request["sources"].is_object()))
    return Error{ErrorCode::kInvalidRequest, "invalid object sources"};
  for (const auto& item : request["ids"]) {
    const auto id = item.get<std::string>();
    std::lock_guard lock(transfers_[std::hash<std::string>{}(tenant + id) % transfers_.size()]);
    if (method == "object.delete") {
      RK_RETURN_IF_ERROR(store_.Delete(tenant, id));
    } else if (method == "object.fetch") {
      auto local = store_.Inspect(tenant, id);
      if (local) {
        RK_RETURN_IF_ERROR(Committed(local.value()));
      } else {
        if (!request["sources"].contains(id))
          return Error{ErrorCode::kInvalidRequest, "missing object sources"};
        RK_RETURN_IF_ERROR(Fetch(tenant, id, request["sources"][id]));
      }
    } else
      return Error{ErrorCode::kInvalidRequest, "unknown object method"};
  }
  return Json{{"accepted", true}};
}
}  // namespace remotekit::objects
