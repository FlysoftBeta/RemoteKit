#include "session/session.hpp"
namespace remotekit {
void Session::RequireFileJob(const FileJob& job) {
  if (!authorization.Stamp() || !file_services.Current(job))
    throw std::runtime_error("file_transfer_interrupted");
}

Result<Json> Session::DirectFileRpc(const FileJob& job, const char* method, Json additions) {
  RequireFileJob(job);
  Json command = {{"method", method},
                  {"session", id},
                  {"view", job.binding.view},
                  {"instance", job.binding.instance},
                  {"document", job.binding.document},
                  {"request", job.binding.request}};
  command.update(additions);
  return browser.Rpc().Request(std::move(command), job.control, 10000, 0,
                               [&] { return authorization.Stamp() && file_services.Current(job); });
}

void Session::SweepDirectFiles() {
  const auto now = QpcNow();
#ifdef RK_FILE_PHOTO
  photo_bursts.Sweep([&](uint64_t grant) {
    return authorization.Stamp() && file_services.CurrentLibraryGrant(grant);
  });
#endif
  file_library.Sweep();
  if (selection_watches.empty() || now < next_selection_watch)
    return;
  next_selection_watch = now + QpcFrequency() / 10;
  auto watch = std::move(selection_watches.front());
  selection_watches.pop_front();
  if (watch.control != browser.Rpc().Control() || now >= watch.expires)
    return;
  {
    auto rpc_result =
        browser.Rpc().Request(SelectionStatusCommand(watch.selection), watch.control, 10000, true);
    if (!rpc_result) {
      const Error operation_error = rpc_result.error();
      if (watch.control == browser.Rpc().Control())
        selection_watches.push_back(std::move(watch));
      return;
    }
    const auto status = std::move(rpc_result).value();
    const auto state = ObserveSelection(watch.selection, status);
    if (state != "selected" && state != "cancelled")
      selection_watches.push_back(std::move(watch));
  }
}

uint64_t Session::FileUnsigned(const Json& value) {
  if (!value.is_number_unsigned() && (!value.is_number_integer() || value.get<int64_t>() < 0))
    throw Json::type_error::create(302, "invalid_file_integer", &value);
  return value.get<uint64_t>();
}

Json Session::SelectionBrowserCommand(const FileBinding& binding, const char* method) {
  return {{"method", method},
          {"session", id},
          {"view", binding.view},
          {"instance", binding.instance},
          {"document", binding.document},
          {"request", binding.request}};
}

Json Session::SelectionStatusCommand(const LibrarySelection& selection) {
  auto command = SelectionBrowserCommand(selection.binding, "page.fileStatus");
  if (selection.state != LibraryState::pending)
    command["selection_id"] = selection.id;
  return command;
}

std::string Session::RetireUnsubmittedSelection(const std::string& selection_id) {
  // Claim persists submitted before sending Browser the callback. A retired
  // target proves cancellation only if the manifest never crossed that boundary.
  const auto state =
      file_library.Finish(selection_id, LibraryState::cancelled, LibraryState::pending);
  if (state == LibraryState::selected)
    return "selected";
  return state == LibraryState::cancelled ? "cancelled" : "unknown";
}

std::string Session::ObserveSelection(const LibrarySelection& selection, const Json& status) {
  const auto current = file_library.FindSelection(selection.id);
  if (!current)
    return "unknown";
  if (current->state == LibraryState::selected)
    return "selected";
  if (current->state == LibraryState::cancelled)
    return "cancelled";
  if (!status.is_object())
    return "unknown";
  const auto error = status.value("error", std::string());
  if (error == "stale_page_request_target" || error == "view_not_in_session")
    return RetireUnsubmittedSelection(selection.id);
  const auto state = status.value("state", std::string("unknown"));
  const bool matched = status.value("selection_id", std::string()) == selection.id;
  if (state == "selected" && matched && current->state == LibraryState::submitted) {
    return file_library.Finish(selection.id, LibraryState::selected) == LibraryState::selected
               ? "selected"
               : "cancelled";
  }
  if (state == "cancelled" && matched && current->state == LibraryState::submitted) {
    return file_library.Finish(selection.id, LibraryState::cancelled) == LibraryState::cancelled
               ? "cancelled"
               : "selected";
  }
  if (state == "cancelled" || (state == "selected" && !matched))
    return RetireUnsubmittedSelection(selection.id);
  if (state == "pending" || state == "validating")
    return current->state == LibraryState::pending && state == "pending" ? "pending" : "validating";
  return "unknown";
}

Result<Json> Session::DirectSelectionCommit(const FileJob& job, const std::string& selection_id) {
  const auto selection = file_library.FindSelection(selection_id);
  if (!selection || selection->binding != job.binding ||
      selection->request_id != job.message["params"]["requestId"].get_ref<const std::string&>())
    return Error{ErrorCode::kNotFound, "unknown_file_selection"};
  const auto result = [&](const std::string& state) {
    return Json{{"state", state}, {"selectionId", selection_id}};
  };
  if (selection->state == LibraryState::selected)
    return result("selected");
  if (selection->state == LibraryState::cancelled)
    return result("cancelled");
  auto browser_status = [&] {
    RequireFileJob(job);
    return browser.Rpc().Request(SelectionStatusCommand(*selection), job.control, 10000, 0, [&] {
      return authorization.Stamp() && file_services.Current(job);
    });
  };
  auto initial_status = browser_status();
  if (!initial_status)
    return initial_status.error();
  const auto initial = ObserveSelection(*selection, initial_status.value());
  if (initial != "pending" || selection->state != LibraryState::pending)
    return result(initial);
  std::vector<remotekit::FileUploadStore::Source> sources;
  for (const auto& file : selection->files) {
    const auto asset = file_library.Describe(file.asset_id);
    sources.push_back({{file.name, file.type, asset.size}, file_library.Path(file.asset_id)});
  }
  Json files = Json::array();
  {
    std::lock_guard lock(file_store_mutex);
    const auto check = [&] { RequireFileJob(job); };
    const auto& batch = file_uploads.Stage(job.binding, sources, check);
    const auto upload = batch.id;
    {
      for (const auto& file : batch.files)
        files.push_back({{"path", Utf8(file.path)}, {"displayName", file.name}});
      if (!file_library.Claim(selection_id, check))
        return Error{ErrorCode::kConflict, "file_selection_already_submitted"};
      file_uploads.MarkSubmitted(upload);
    }
  }
  // The claim is durable before the callback is sent. A lost reply or a
  // retired chooser grant can be reconciled only with a matching Browser receipt.
  if (selection_watches.size() < 64) {
    auto submitted = *selection;
    submitted.state = LibraryState::submitted;
    selection_watches.push_back(
        {std::move(submitted), job.control, QpcNow() + QpcFrequency() * 120});
  }
  auto direct_file_rpc_result = DirectFileRpc(
      job, "page.reply",
      {{"file_only", true}, {"accept", true}, {"files", files}, {"selection_id", selection_id}});
  if (!direct_file_rpc_result)
    return direct_file_rpc_result.error();
  auto response = std::move(direct_file_rpc_result).value();
  return result(ObserveSelection(*selection, response));
}

Result<Json> Session::DirectLibraryCommand(const FileJob& job,
                                           const std::string& method,
                                           const Json& params) {
  const auto check = [&] { RequireFileJob(job); };
  if (method == "asset.begin")
    return file_library.Begin(job.grant, Required(params, "operationId"),
                              {Required(params, "name"), params.value("type", std::string()),
                               FileUnsigned(params.at("size"))},
                              check);
  if (method == "asset.chunk")
    return Json{
        {"offset", file_library.Chunk(job.grant, Required(params, "uploadId"),
                                      FileUnsigned(params.at("offset")),
                                      remotekit::DecodeFileChunk(params.at("data")), check)}};
  if (method == "asset.seal")
    return file_library.Seal(job.grant, Required(params, "uploadId"), check).Json();
  if (method == "asset.cancel") {
    file_library.Cancel(job.grant, Required(params, "uploadId"), check);
    return Json{{"cancelled", true}};
  }
  if (method == "asset.describe") {
    const auto asset = file_library.Describe(Required(params, "assetId"));
    check();
    return asset.Json();
  }
  if (method == "asset.read") {
    const auto offset = FileUnsigned(params.at("offset"));
    const auto [asset, bytes] = file_library.Read(Required(params, "assetId"), offset);
    check();
    return Json{{"data", remotekit::EncodeFileChunk(bytes)},
                {"offset", offset + bytes.size()},
                {"total", asset.size}};
  }
#ifdef RK_FILE_PHOTO
  const auto cancelled = [&] { return !authorization.Stamp() || !file_services.Current(job); };
  if (remotekit::PhotoBurstMethod(method))
    return photo_bursts.Execute(job.grant, method, params, cancelled);
  if (method == "photo.thumbnail") {
    const auto asset_id = Required(params, "assetId");
    const auto source = file_library.Path(asset_id);
    const auto now = QpcNow();
    const auto cached = photo_thumbnails.find(asset_id);
    if (cached != photo_thumbnails.end()) {
      std::optional<remotekit::FileLibrary::Asset> thumbnail;
      if (now < cached->second.refresh_after) {
        {
          thumbnail = file_library.Describe(cached->second.asset_id);
        }
        // An expired derivative can be regenerated.
      }
      if (thumbnail) {
        check();
        return thumbnail->Json();
      }
      photo_thumbnails.erase(cached);
    }
    const auto thumbnail = file_library.CreateDerivative(
        [&](const fs::path& output) {
          const auto dimensions = remotekit::CreatePhotoThumbnail(source, output, cancelled);
          return remotekit::FileLibrary::Derivative{dimensions.width, dimensions.height};
        },
        check);
    check();
    constexpr size_t kThumbnailCacheEntries = 256;
    if (photo_thumbnails.size() >= kThumbnailCacheEntries) {
      const auto oldest =
          std::min_element(photo_thumbnails.begin(), photo_thumbnails.end(),
                           [](const auto& left, const auto& right) {
                             return left.second.refresh_after < right.second.refresh_after;
                           });
      photo_thumbnails.erase(oldest);
    }
    // Renew before the derivative's two-hour raw asset expiration so a caller
    // can fetch its chunks after receiving this descriptor.
    photo_thumbnails.emplace(asset_id,
                             PhotoThumbnail{thumbnail.id, QpcNow() + QpcFrequency() * 3600});
    return thumbnail.Json();
  }
  if (method == "photo.rank") {
    const auto& ids = params.at("assetIds");
    if (!ids.is_array() || ids.empty() || ids.size() > 6)
      return Error{ErrorCode::kInvalidRequest, "invalid_photo_count"};
    std::vector<fs::path> paths;
    for (const auto& asset : ids)
      paths.push_back(file_library.Path(asset.get<std::string>()));
    const auto ranked = remotekit::RankPhotos(paths, cancelled);
    check();
    Json candidates = Json::array();
    for (const auto& candidate : ranked.candidates)
      candidates.push_back({{"assetId", ids.at(candidate.index)}, {"score", candidate.score}});
    return Json{{"selectedAssetId", ids.at(ranked.selected_index)},
                {"uncertain", ranked.uncertain},
                {"candidates", std::move(candidates)},
                {"reason", ranked.reason}};
  }
  if (method == "photo.process") {
    const auto source = file_library.Path(Required(params, "assetId"));
    const auto mode = Required(params, "mode");
    if (mode != "rectify" && mode != "scan")
      return Error{ErrorCode::kInvalidRequest, "invalid_photo_mode"};
    std::optional<std::array<remotekit::PhotoPoint, 4>> corners;
    if (const auto found = params.find("corners"); found != params.end()) {
      if (!found->is_array() || found->size() != 4)
        return Error{ErrorCode::kInvalidRequest, "invalid_photo_corners"};
      corners.emplace();
      for (size_t i = 0; i < 4; ++i)
        (*corners)[i] = {found->at(i).at("x").get<double>(), found->at(i).at("y").get<double>()};
    }
    std::string geometry;
    auto asset =
        file_library
            .CreateDerivative(
                [&](const fs::path& output) {
                  const auto dimensions = remotekit::ProcessPhoto(
                      source, output,
                      mode == "scan" ? remotekit::PhotoMode::kScan : remotekit::PhotoMode::kRectify,
                      corners, cancelled);
                  geometry = dimensions.geometry;
                  return remotekit::FileLibrary::Derivative{dimensions.width, dimensions.height};
                },
                check, remotekit::FileLibrary::DerivativeFormat::png)
            .Json();
    asset["geometry"] = std::move(geometry);
    return asset;
  }
#endif
  return Error{ErrorCode::kUnavailable, "photo_processing_unavailable"};
}

Result<Json> Session::DirectFileCommand(const FileJob& job) {
  RequireFileJob(job);
  const auto method = Required(job.message, "method");
  const auto& params = job.message.at("params");
  if (remotekit::LibraryFileMethod(method))
    return DirectLibraryCommand(job, method, params);
  if (method == "selection.commit")
    return DirectSelectionCommit(job, Required(params, "selectionId"));
  return Error{ErrorCode::kInvalidRequest, "unknown_file_method"};
}

Result<Session::FileBinding> Session::ParseFileBinding(const Json& value) {
  return FileBinding{Required(value, "browserIncarnation"), Required(value, "view"),
                     Required(value, "instance"), Required(value, "document"),
                     Required(value, "request")};
}

Result<Json> Session::FileBrowserCommand(const FileBinding& binding, const char* method) {
  if (!Alive() || !browser.Rpc().Control() || browser.Stopping() ||
      binding.browser_incarnation != browser.Incarnation() || !desired.contains(binding.view))
    return Error{ErrorCode::kConflict, "stale_file_request_target"};
  return SelectionBrowserCommand(binding, method);
}

Result<Json> Session::LibraryCommand(const std::string& method, const Json& request) {
  if (method == "session.library.describe")
    return file_library.Describe(Required(request, "assetId")).Json();
  if (method == "session.library.retain" || method == "session.library.references") {
    const auto& values = request.at("assetIds");
    if (!values.is_array() || values.size() > (method == "session.library.retain" ? 64 : 8192))
      return Error{ErrorCode::kInvalidRequest, "invalid_library_assets"};
    std::vector<std::string> assets;
    assets.reserve(values.size());
    for (const auto& value : values)
      assets.push_back(value.get<std::string>());
    if (method == "session.library.retain")
      file_library.Retain(assets);
    else
      file_library.References(FileUnsigned(request.at("revision")), assets);
    return Json{{"accepted", true}};
  }
  const auto selection_id = Required(request, "selectionId");
  if (method == "session.library.prepare") {
    auto binding = ParseFileBinding(request.at("binding"));
    if (!binding)
      return binding.error();
    LibrarySelection selection{
        selection_id, Required(request, "requestId"), std::move(binding).value(), {}};
    const auto& values = request.at("files");
    if (!values.is_array() || values.empty() || values.size() > 64)
      return Error{ErrorCode::kInvalidRequest, "invalid_file_count"};
    for (const auto& value : values)
      selection.files.push_back({Required(value, "assetId"), Required(value, "name"),
                                 value.value("type", std::string())});
    if (!file_library.FindSelection(selection_id)) {
      auto command = FileBrowserCommand(selection.binding, "page.fileStatus");
      if (!command)
        return command.error();
      auto status = browser.Rpc().Request(std::move(command).value());
      if (!status)
        return status.error();
      if (status.value().value("state", std::string()) != "pending")
        return Error{ErrorCode::kConflict, "file_request_not_pending"};
    }
    file_library.Prepare(selection);
    return Json{{"accepted", true}};
  }
  if (method == "session.library.selectionStatus") {
    const auto selection = file_library.FindSelection(selection_id);
    std::string state = "unknown";
    if (selection) {
      if (selection->state == LibraryState::selected)
        state = "selected";
      else if (selection->state == LibraryState::cancelled)
        state = "cancelled";
      else if (selection->state == LibraryState::pending &&
               (!desired.contains(selection->binding.view) ||
                selection->binding.browser_incarnation == last_confirmed_browser_exit ||
                (ProducerExited() &&
                 selection->binding.browser_incarnation == browser.ProcessIncarnation()) ||
                (!browser.Incarnation().empty() &&
                 selection->binding.browser_incarnation != browser.Incarnation())))
        state = RetireUnsubmittedSelection(selection->id);
      else if (Alive() && browser.Rpc().Control() && !browser.Stopping() &&
               selection->binding.browser_incarnation == browser.ProcessIncarnation()) {
        Json status;
        {
          auto rpc_result_2 = browser.Rpc().Request(SelectionStatusCommand(*selection));
          if (!rpc_result_2) {
            const Error operation_error = rpc_result_2.error();
            return Json{{"state", "unknown"}};
          }
          status = std::move(rpc_result_2).value();
        }

        state = ObserveSelection(*selection, status);
      }
    }
    return Json{{"state", state}};
  }
  return Error{ErrorCode::kInvalidRequest, "unknown_library_method"};
}

Result<Json> Session::AuthorizeFiles(const Json& request) {
  std::map<std::string, FileBinding> bindings;
  const auto& requests = request.at("requests");
  if (!requests.is_array() || requests.size() > 64)
    return Error{ErrorCode::kForbidden, "invalid_file_authorization_count"};
  for (const auto& item : requests) {
    const auto token = Required(item, "id");
    if (token.size() > 128 || token == "library")
      return Error{ErrorCode::kInvalidRequest, "invalid_file_request_id"};
    auto parse_file_binding_result = ParseFileBinding(item.at("binding"));
    if (!parse_file_binding_result)
      return parse_file_binding_result.error();
    const auto binding = std::move(parse_file_binding_result).value();
    if (binding.browser_incarnation != browser.Incarnation() || !desired.contains(binding.view))
      return Error{ErrorCode::kConflict, "stale_file_request_target"};
    if (!bindings.emplace(token, binding).second)
      return Error{ErrorCode::kForbidden, "duplicate_file_authorization"};
  }
  std::lock_guard admission(admission_mutex);
  if (!authorization.Stamp())
    return Error{ErrorCode::kForbidden, "authorization_changed"};
  {
    const auto epoch = request.find("authEpoch");
    if (epoch == request.end() || !epoch->is_number_unsigned() ||
        epoch->get<uint64_t>() != authorization.Epoch())
      return Error{ErrorCode::kConflict, "stale_authorization_epoch"};
  }
  file_services.Authorize(Required(request, "connectionId"), browser.Rpc().Control(), bindings,
                          request.value("library", false));
  return Json{{"accepted", true}};
}
}  // namespace remotekit
