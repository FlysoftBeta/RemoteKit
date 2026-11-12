#include "objects/service.hpp"
#include "documents/object_documents.hpp"
#include "util/result_macros.hpp"
#include <future>
#include <fstream>
#include <windows.h>
#include "cluster/node_files.hpp"
namespace remotekit::objects {
ObjectService::ObjectService(std::filesystem::path data,
                             ManagementLink& control,
                             const Key& key,
                             std::string node,
                             std::string build)
    : put_root_(data / "object-puts"),
      store_(std::move(data)),
      control_(control),
      server_(store_, key, node, build, peers_),
      client_(store_, key, std::move(node), std::move(build), peers_) {
  std::filesystem::remove_all(put_root_);
  std::filesystem::create_directories(put_root_);
  documents_ = std::make_unique<documents::ObjectDocuments>(*this, put_root_.parent_path());
}
ObjectService::~ObjectService() {
  documents_.reset();
  staging_.Stop();
  work_.Stop();
  CancelPuts();
}
Result<Json> ObjectService::Derivation(const std::string& id, const std::string& tenant) {
  RK_ASSIGN_OR_RETURN(reply, control_.Request("object.derivation",
                                              {{"tenantId", tenant},
                                               {"params", {{"id", id}, {"kind", "document"}}}}));
  if (!reply.is_null() && (!reply.is_object() || !reply.contains("id") ||
                           !reply["id"].is_string() || !ValidId(reply["id"].get<std::string>())))
    return Error{ErrorCode::kOutcomeUnknown, "invalid object.derivation reply"};
  return reply;
}
Result<void> ObjectService::SetPeers(const Json& peers) {
  RK_RETURN_IF_ERROR(peers_.Update(peers));
  server_.Revoke();
  return {};
}
Result<void> ObjectService::Start(const std::string& listen) {
  return server_.Start(listen);
}
bool ObjectService::PreStage(std::function<void()> work) {
  bool idle = false;
  if (!staging_busy_.compare_exchange_strong(idle, true))
    return false;
  if (!staging_.Submit([this, work = std::move(work)] {
        struct Release {
          std::atomic<bool>& busy;
          ~Release() { busy = false; }
        } release{staging_busy_};
        work();
      })) {
    staging_busy_ = false;
    return false;
  }
  return true;
}
Result<void> ObjectService::Committed(const ObjectInfo& info, const Json& claim) {
  auto fields = info.Committed();
  fields["tenantId"] = "";
  fields.update(claim);
  auto reply = control_.Request("object.committed", std::move(fields));
  if (!reply)
    return reply.error();
  return {};
}
Result<void> ObjectService::CommittedBatch(const std::vector<ObjectInfo>& objects,
                                           const std::string& tenant,
                                           size_t* requests) {
  Json fields = {{"tenantId", tenant}};
  fields["objects"] = Json::array();
  auto send = [&]() -> Result<void> {
    if (fields["objects"].empty())
      return {};
    if (requests)
      ++*requests;
    auto result = control_.Request("object.committed.batch", fields);
    if (!result && result.error().code == ErrorCode::kOutcomeUnknown) {
      if (requests)
        ++*requests;
      result = control_.Request("object.committed.batch", fields);
    }
    if (!result)
      return result.error();
    if (!result.value().is_object() || result.value().value("ok", false) != true)
      return Error{ErrorCode::kOutcomeUnknown, "invalid object commit batch reply"};
    fields["objects"] = Json::array();
    return {};
  };
  size_t bytes = fields.dump().size();
  for (const auto& object : objects) {
    auto item = object.Committed();
    const size_t size = item.dump().size() + 1;
    if (fields["objects"].size() == 1024 || bytes + size > 256 * 1024 - 1024) {
      RK_RETURN_IF_ERROR(send());
      bytes = fields.dump().size();
    }
    fields["objects"].push_back(std::move(item));
    bytes += size;
  }
  return send();
}
Result<ObjectInfo> ObjectService::Fetch(const std::string& id, const Json& sources) {
  if (!sources.is_array() || sources.size() > 256)
    return Error{ErrorCode::kInvalidRequest, "invalid object sources"};
  Error last{ErrorCode::kUnavailable, "no object source available"};
  for (size_t i = 0; i < sources.size(); ++i) {
    const auto& source = sources[(std::hash<std::string>{}(id) + i) % sources.size()];
    if (!source.is_object() || !source.contains("nodeId") || !source["nodeId"].is_string() ||
        !source.contains("address") || !source["address"].is_string())
      return Error{ErrorCode::kInvalidRequest, "invalid object source"};
    const auto address = source["address"].get<std::string>();
    std::shared_ptr<std::counting_semaphore<4>> limit;
    {
      std::lock_guard lock(sources_mutex_);
      auto& entry = source_limits_[address];
      if (!entry)
        entry = std::make_shared<std::counting_semaphore<4>>(4);
      limit = entry;
    }
    limit->acquire();
    struct Permit {
      std::shared_ptr<std::counting_semaphore<4>> limit;
      ~Permit() { limit->release(); }
    } permit{limit};
    auto fetched = client_.Fetch(id, source["nodeId"].get<std::string>());
    if (!fetched) {
      last = fetched.error();
      if (last.code != ErrorCode::kUnauthenticated && last.code != ErrorCode::kUnavailable &&
          last.code != ErrorCode::kNotFound && last.code != ErrorCode::kBusy &&
          last.code != ErrorCode::kRateLimited)
        return last;
      continue;
    }
    return fetched;
  }
  return last;
}
Result<ObjectInfo> ObjectService::Ensure(const std::string& id, const Json& sources) {
  auto task = std::make_shared<std::packaged_task<Result<ObjectInfo>()>>(
      [this, id, sources]() -> Result<ObjectInfo> {
        if (auto local = store_.Inspect(id); local)
          return local;
        RK_ASSIGN_OR_RETURN(info, EnsureLocal(id, sources));
        RK_RETURN_IF_ERROR(CommittedBatch({info}));
        return info;
      });
  auto result = task->get_future();
  if (!work_.Submit([task] { (*task)(); }))
    return Error{ErrorCode::kBusy, "object workers busy"};
  return result.get();
}
Result<ObjectInfo> ObjectService::EnsureUncommitted(const std::string& id, const Json& sources) {
  return EnsureLocal(id, sources);
}
Result<ObjectInfo> ObjectService::Write(const std::filesystem::path& path,
                                        const ObjectStore::Check& check,
                                        const Json& claim) {
  if (!configured_)
    return Error{ErrorCode::kUnavailable, "object store is not configured"};
  auto task =
      std::make_shared<std::packaged_task<Result<ObjectInfo>()>>([&, this]() -> Result<ObjectInfo> {
        RK_ASSIGN_OR_RETURN(info, store_.Write(keys_, path, check));
        auto reference = claim;
        if (reference.value("derivedFrom", Json()) == info.id) {
          reference.erase("derivedFrom");
          reference.erase("kind");
        }
        RK_RETURN_IF_ERROR(Committed(info, reference));
        return info;
      });
  auto result = task->get_future();
  if (!work_.Submit([task] { (*task)(); }))
    return Error{ErrorCode::kBusy, "object workers busy"};
  return result.get();
}
Result<Json> ObjectService::Locate(const std::string& id, const Json& reference) {
  RK_ASSIGN_OR_RETURN(sources, LocateBatch({id}, reference));
  return sources[id];
}
Result<Json> ObjectService::LocateBatch(const std::vector<std::string>& ids,
                                        const Json& reference) {
  Json sources = Json::object();
  for (size_t offset = 0; offset < ids.size(); offset += 1024) {
    auto fields = reference;
    fields["ids"] = Json::array();
    const auto end = std::min(ids.size(), offset + 1024);
    for (size_t i = offset; i < end; ++i)
      fields["ids"].push_back(ids[i]);
    RK_ASSIGN_OR_RETURN(located, control_.Request("object.locate", std::move(fields)));
    if (!located.is_object() || !located.contains("sources") || !located["sources"].is_object())
      return Error{ErrorCode::kOutcomeUnknown, "invalid object.locate reply"};
    for (size_t i = offset; i < end; ++i) {
      if (!located["sources"].contains(ids[i]) || !located["sources"][ids[i]].is_array())
        return Error{ErrorCode::kOutcomeUnknown, "invalid object.locate reply"};
      sources[ids[i]] = std::move(located["sources"][ids[i]]);
    }
  }
  return sources;
}
Result<ObjectInfo> ObjectService::EnsureLocal(const std::string& id, const Json& sources) {
  if (!ValidId(id))
    return Error{ErrorCode::kInvalidRequest, "invalid object identity"};
  std::lock_guard lock(transfers_[std::hash<std::string>{}(id) % transfers_.size()]);
  auto local = store_.Inspect(id);
  if (local)
    return local;
  if (local.error().code != ErrorCode::kNotFound)
    return local.error();
  return Fetch(id, sources);
}
Result<Json> SessionObjects::Prepare(const std::vector<std::string>& ids) {
  RK_ASSIGN_OR_RETURN(sources, service_.LocateBatch(ids, {{"tenantId", tenant_}}));
  std::lock_guard lock(mutex_);
  for (const auto& id : ids) {
    grants_.insert(id);
    sources_[id] = sources[id];
  }
  return sources;
}
Result<ObjectInfo> SessionObjects::Ensure(const std::string& id) {
  Json sources;
  bool granted = false;
  {
    std::lock_guard lock(mutex_);
    granted = grants_.contains(id);
    if (sources_.contains(id))
      sources = sources_[id];
  }
  if (granted) {
    auto local = service_.Store().Inspect(id);
    if (local)
      return local;
    if (local.error().code != ErrorCode::kNotFound)
      return local.error();
  }
  if (sources.is_null()) {
    RK_ASSIGN_OR_RETURN(located, Prepare({id}));
    sources = located[id];
  }
  return service_.Ensure(id, sources);
}
void SessionObjects::Grant(const std::string& id) {
  std::lock_guard lock(mutex_);
  grants_.insert(id);
}
Result<ObjectInfo> SessionObjects::Write(const std::filesystem::path& path,
                                         const ObjectStore::Check& check,
                                         const std::string& derived_from) {
  Json claim{{"tenantId", tenant_}};
  if (!derived_from.empty()) {
    RK_RETURN_IF_ERROR(Ensure(derived_from));
    claim["derivedFrom"] = derived_from;
    claim["kind"] = "thumbnail";
  }
  RK_ASSIGN_OR_RETURN(info, service_.Write(path, check, claim));
  Grant(info.id);
  return info;
}
Result<void> ObjectService::Configure(const Json& config) {
  Keys incoming;
  for (auto [name, destination] :
       {std::pair{"objectKey", &incoming.object}, std::pair{"objectIdKey", &incoming.id}}) {
    if (!config.contains(name) || !config[name].is_string())
      return Error{ErrorCode::kInvalidRequest, "missing cluster object key"};
    RK_ASSIGN_OR_RETURN(key, cluster::DecodeKey(config[name].get<std::string>()));
    *destination = key;
    SecureZeroMemory(key.data(), key.size());
  }
  if (configured_) {
    if (keys_.object != incoming.object || keys_.id != incoming.id)
      return Error{ErrorCode::kConflict, "cluster object keys changed"};
    return {};
  }
  keys_ = incoming;
  configured_ = true;
  return {};
}
Result<Json> ObjectService::Dispatch(const Json& request) {
  if (!request.is_object() || !request.contains("method") || !request["method"].is_string())
    return Error{ErrorCode::kInvalidRequest, "required string: method"};
  const auto method = request["method"].get<std::string>();
  if (method == "object.render") {
    const auto params = request.value("params", Json::object());
    if (!params.is_object() || !params.contains("id") || !params["id"].is_string() ||
        !ValidId(params["id"].get<std::string>()))
      return Error{ErrorCode::kInvalidRequest, "invalid object id"};
    RK_ASSIGN_OR_RETURN(id, documents_->Render(params["id"].get<std::string>()));
    return Json{{"documentId", id}};
  }
  if (method == "object.inventory")
    return store_.Inventory(request.value("cursor", Json(nullptr)));
  if (method.starts_with("object.put."))
    return DispatchPut(request);
  if (!request.contains("ids") || !request["ids"].is_array() || request["ids"].size() > 4096)
    return Error{ErrorCode::kInvalidRequest, "invalid object ids"};
  for (const auto& id : request["ids"])
    if (!id.is_string() || !ValidId(id.get<std::string>()))
      return Error{ErrorCode::kInvalidRequest, "invalid object id"};
  if (method == "object.fetch" && (!request.contains("sources") || !request["sources"].is_object()))
    return Error{ErrorCode::kInvalidRequest, "invalid object sources"};
  std::vector<ObjectInfo> committed;
  for (const auto& item : request["ids"]) {
    const auto id = item.get<std::string>();
    std::lock_guard lock(transfers_[std::hash<std::string>{}(id) % transfers_.size()]);
    if (method == "object.delete") {
      RK_RETURN_IF_ERROR(store_.Delete(id));
    } else if (method == "object.fetch") {
      auto local = store_.Inspect(id);
      if (local) {
        committed.push_back(local.value());
      } else {
        if (!request["sources"].contains(id))
          return Error{ErrorCode::kInvalidRequest, "missing object sources"};
        RK_ASSIGN_OR_RETURN(info, Fetch(id, request["sources"][id]));
        committed.push_back(std::move(info));
      }
    } else
      return Error{ErrorCode::kInvalidRequest, "unknown object method"};
  }
  RK_RETURN_IF_ERROR(CommittedBatch(committed));
  return Json{{"accepted", true}};
}
Result<Json> ObjectService::DispatchPut(const Json& request) {
  const auto method = request["method"].get<std::string>();
  if (!request.contains("putId") || !request["putId"].is_string())
    return Error{ErrorCode::kInvalidRequest, "required string: putId"};
  const auto id = request["putId"].get<std::string>();
  if (id.size() != 36 || !std::all_of(id.begin(), id.end(), [](char c) {
        return (c >= 'a' && c <= 'f') || (c >= '0' && c <= '9') || c == '-';
      }))
    return Error{ErrorCode::kInvalidRequest, "invalid put id"};
  std::unique_lock lock(puts_mutex_);
  const auto path = put_root_ / id;
  if (method == "object.put.begin") {
    if (!configured_)
      return Error{ErrorCode::kUnavailable, "object store is not configured"};
    if (!request.contains("tenantId") || !request["tenantId"].is_string())
      return Error{ErrorCode::kInvalidRequest, "required string: tenantId"};
    const auto tenant = request["tenantId"].get<std::string>();
    if (!ValidTenant(tenant))
      return Error{ErrorCode::kInvalidRequest, "invalid tenant identity"};
    if (request.contains("sizeHint") &&
        (!request["sizeHint"].is_number_integer() || request["sizeHint"].get<int64_t>() < 0 ||
         request["sizeHint"].get<uint64_t>() > 256ull * kSegmentSize))
      return Error{ErrorCode::kLimitExceeded, "invalid object size hint"};
    if (puts_.contains(id))
      return Error{ErrorCode::kConflict, "put already exists"};
    if (puts_.size() >= 4)
      return Error{ErrorCode::kBusy, "too many object puts"};
    std::ofstream file(path, std::ios::binary | std::ios::trunc);
    if (!file)
      return Error{ErrorCode::kUnavailable, "cannot open object put"};
    puts_.emplace(id, std::make_shared<Put>(tenant));
    return Json{{"accepted", true}};
  }
  auto found = puts_.find(id);
  if (method == "object.put.cancel") {
    if (found != puts_.end()) {
      found->second->cancelled = true;
      puts_.erase(found);
    }
    std::error_code error;
    std::filesystem::remove(path, error);
    return Json{{"cancelled", true}};
  }
  if (method != "object.put.end")
    return Error{ErrorCode::kInvalidRequest, "unknown object put method"};
  if (found == puts_.end())
    return Error{ErrorCode::kNotFound, "object put not found"};
  auto put = found->second;
  if (put->ending)
    return Error{ErrorCode::kConflict, "put is already ending"};
  put->ending = true;
  lock.unlock();
  struct Cleanup {
    ObjectService& service;
    std::string id;
    std::shared_ptr<Put> put;
    ~Cleanup() {
      std::lock_guard lock(service.puts_mutex_);
      auto found = service.puts_.find(id);
      if (found != service.puts_.end() && found->second == put)
        service.puts_.erase(found);
      std::error_code error;
      std::filesystem::remove(service.put_root_ / id, error);
    }
  } cleanup{*this, id, put};
  if (put->error)
    return *put->error;
  const auto check = [&]() -> Result<void> {
    if (put->cancelled)
      return Error{ErrorCode::kCanceled, "Object put canceled"};
    return {};
  };
  RK_RETURN_IF_ERROR(check());
  RK_ASSIGN_OR_RETURN(info, store_.Write(keys_, path, check));
  RK_RETURN_IF_ERROR(check());
  RK_RETURN_IF_ERROR(Committed(info, {{"tenantId", put->tenant}, {"putId", id}}));
  return info.Committed();
}
Result<void> ObjectService::PutChunk(const Json& header, std::span<const uint8_t> bytes) {
  if (!header.is_object() || !header.contains("putId") || !header["putId"].is_string())
    return Error{ErrorCode::kInvalidRequest, "required string: putId"};
  const auto id = header.value("putId", std::string());
  std::lock_guard lock(puts_mutex_);
  auto found = puts_.find(id);
  if (found == puts_.end())
    return Error{ErrorCode::kNotFound, "object put not found"};
  auto& put = *found->second;
  if (put.ending)
    return Error{ErrorCode::kConflict, "object put is ending"};
  if (put.error)
    return *put.error;
  auto fail = [&](ErrorCode code, const char* message) -> Result<void> {
    put.error = Error{code, message};
    std::filesystem::remove(put_root_ / id);
    return *put.error;
  };
  if (!header.contains("offset") || !header["offset"].is_number_integer() ||
      header["offset"].get<int64_t>() < 0 || header["offset"].get<uint64_t>() != put.offset ||
      bytes.empty() || bytes.size() > kSegmentSize)
    return fail(ErrorCode::kInvalidRequest, "invalid object put chunk");
  if (put.offset + bytes.size() > 256ull * kSegmentSize)
    return fail(ErrorCode::kLimitExceeded, "object too large");
  std::ofstream file(put_root_ / id, std::ios::binary | std::ios::app);
  file.write(reinterpret_cast<const char*>(bytes.data()), bytes.size());
  file.close();
  if (!file)
    return fail(ErrorCode::kUnavailable, "cannot write object put");
  put.offset += bytes.size();
  return {};
}
void ObjectService::CancelPuts() {
  std::lock_guard lock(puts_mutex_);
  for (const auto& [id, put] : puts_) {
    put->cancelled = true;
    std::error_code error;
    std::filesystem::remove(put_root_ / id, error);
  }
  puts_.clear();
}
}  // namespace remotekit::objects
