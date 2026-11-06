#include "files/files.hpp"
#include "rtc/authorization.hpp"
#include "rtc/peer.hpp"
#include "session/views.hpp"
#include "util/result_macros.hpp"
namespace remotekit {
Result<void> FileController::RequireFileJob(const FileJob& job) {
  if (!authorization.Stamp() || !file_services.Current(job))
    return Error{ErrorCode::kForbidden, "file_transfer_interrupted"};
  return {};
}

Result<Json> FileController::DirectFileRpc(const FileJob& job, const char* method, Json additions) {
  RK_RETURN_IF_ERROR(RequireFileJob(job));
  const auto token = authorization.Admit();
  if (token.peer != job.peer || !authorization.Current(token))
    return Error{ErrorCode::kForbidden, "file_transfer_interrupted"};
  Json command = {{"method", method},
                  {"session", id},
                  {"view", job.binding.view},
                  {"instance", job.binding.instance},
                  {"document", job.binding.document},
                  {"request", job.binding.request}};
  command.update(additions);
  return browser.Rpc().Request(std::move(command), job.control, 10000, false, [&] {
    return authorization.Current(token) && file_services.Current(job);
  });
}

Result<Json> FileController::DirectFileCommand(const FileJob& job) {
  RK_RETURN_IF_ERROR(RequireFileJob(job));
  const auto method = Required(job.message, "method");
  const auto& params = job.message.at("params");
  if (remotekit::LibraryFileMethod(method))
    return library.DirectLibraryCommand(job, method, params);
  if (method == "selection.commit")
    return library.DirectSelectionCommit(job, Required(params, "selectionId"));
  if (method == "selection.cancel")
    return library.DirectSelectionCancel(job);
  return Error{ErrorCode::kInvalidRequest, "unknown_file_method"};
}

Result<Json> FileController::AuthorizeFiles(const Json& request) {
  std::map<std::string, FileBinding> bindings;
  const auto& requests = request.at("requests");
  if (!requests.is_array() || requests.size() > 64)
    return Error{ErrorCode::kForbidden, "invalid_file_authorization_count"};
  for (const auto& item : requests) {
    const auto token = Required(item, "id");
    if (token.size() > 128 || token == "library")
      return Error{ErrorCode::kInvalidRequest, "invalid_file_request_id"};
    auto parse_file_binding_result = library.ParseFileBinding(item.at("binding"));
    if (!parse_file_binding_result)
      return parse_file_binding_result.error();
    const auto binding = std::move(parse_file_binding_result).value();
    if (binding.browser_incarnation != browser.Incarnation() || !views.Contains(binding.view))
      return Error{ErrorCode::kConflict, "stale_file_request_target"};
    if (!bindings.emplace(token, binding).second)
      return Error{ErrorCode::kForbidden, "duplicate_file_authorization"};
  }
  auto admission = authorization.LockAdmission();
  if (!authorization.Stamp())
    return Error{ErrorCode::kForbidden, "authorization_changed"};
  {
    const auto epoch = request.find("authEpoch");
    if (epoch == request.end() || !epoch->is_number_unsigned() ||
        epoch->get<uint64_t>() != authorization.Epoch())
      return Error{ErrorCode::kConflict, "stale_authorization_epoch"};
  }
  RK_RETURN_IF_ERROR(file_services.Authorize(Required(request, "connectionId"),
                                             browser.Rpc().Control(), bindings,
                                             request.value("library", false)));
  return Json{{"accepted", true}};
}

void FileController::Start() {
  file_services.Start([this](const auto& job) { return DirectFileCommand(job); },
                      [this] {
                        auto swept = library.SweepDirectFiles();
                        if (!swept)
                          fprintf(stderr, "file sweep: %s\n", swept.error().message.c_str());
                      });
}

void FileController::Stop() {
  file_services.Bind(0);
  file_services.Stop();
}

void FileController::Bind(uint64_t peer, const std::string& connection) {
  file_services.Bind(peer, connection);
}

void FileController::Admit(const RtcEvent& event) {
  auto admission = authorization.LockAdmission();
  if (event.peer == peer_controller.Handle() && authorization.Current(event.authorization) &&
      FileRequestEnvelope(event.message, event.bytes.size()))
    file_services.Admit(event.peer, event.message);
}

void FileController::Flush(uint64_t handle, const std::function<int(const std::string&)>& send) {
  file_services.Flush(handle, send);
}
Result<void> LibraryController::SweepDirectFiles() {
  const auto now = QpcNow();
  photos.Sweep();
  RK_RETURN_IF_ERROR(file_library.Sweep());
  if (selection_watches.empty() || now < next_selection_watch)
    return {};
  next_selection_watch = now + QpcFrequency() / 10;
  auto watch = std::move(selection_watches.front());
  selection_watches.pop_front();
  if (watch.control != browser.Rpc().Control() || now >= watch.expires)
    return {};
  {
    auto rpc_result =
        browser.Rpc().Request(SelectionStatusCommand(watch.selection), watch.control, 10000, true);
    if (!rpc_result) {
      const Error operation_error = rpc_result.error();
      if (watch.control == browser.Rpc().Control())
        selection_watches.push_back(std::move(watch));
      return {};
    }
    const auto status = std::move(rpc_result).value();
    RK_ASSIGN_OR_RETURN(state, ObserveSelection(watch.selection, status));
    if (state != "selected" && state != "cancelled")
      selection_watches.push_back(std::move(watch));
  }

  return {};
}

uint64_t LibraryController::FileUnsigned(const Json& value) {
  if (!value.is_number_unsigned() && (!value.is_number_integer() || value.get<int64_t>() < 0))
    throw Json::type_error::create(302, "invalid_file_integer", &value);
  return value.get<uint64_t>();
}

Json LibraryController::SelectionBrowserCommand(const FileBinding& binding, const char* method) {
  return {{"method", method},
          {"session", id},
          {"view", binding.view},
          {"instance", binding.instance},
          {"document", binding.document},
          {"request", binding.request}};
}

Json LibraryController::SelectionStatusCommand(const LibrarySelection& selection) {
  auto command = SelectionBrowserCommand(selection.binding, "page.fileStatus");
  if (selection.state != LibraryState::pending)
    command["selection_id"] = selection.id;
  return command;
}

Result<std::string> LibraryController::RetireUnsubmittedSelection(const std::string& selection_id) {
  // Claim persists submitted before sending Browser the callback. A retired
  // target proves cancellation only if the manifest never crossed that boundary.
  RK_ASSIGN_OR_RETURN(
      state, file_library.Finish(selection_id, LibraryState::cancelled, LibraryState::pending));
  if (state == LibraryState::selected)
    return std::string("selected");
  return std::string(state == LibraryState::cancelled ? "cancelled" : "unknown");
}

Result<std::string> LibraryController::ObserveSelection(const LibrarySelection& selection,
                                                        const Json& status) {
  const auto current = file_library.FindSelection(selection.id);
  if (!current)
    return std::string("unknown");
  if (current->state == LibraryState::selected)
    return std::string("selected");
  if (current->state == LibraryState::cancelled)
    return std::string("cancelled");
  if (!status.is_object())
    return std::string("unknown");
  const auto state = status.value("state", std::string("unknown"));
  const bool matched = status.value("selection_id", std::string()) == selection.id;
  if (state == "selected" && matched && current->state == LibraryState::submitted) {
    RK_ASSIGN_OR_RETURN(finished, file_library.Finish(selection.id, LibraryState::selected));
    return std::string(finished == LibraryState::selected ? "selected" : "cancelled");
  }
  if (state == "cancelled" && matched && current->state == LibraryState::submitted) {
    RK_ASSIGN_OR_RETURN(finished, file_library.Finish(selection.id, LibraryState::cancelled));
    return std::string(finished == LibraryState::cancelled ? "cancelled" : "selected");
  }
  if (state == "cancelled" || (state == "selected" && !matched))
    return RetireUnsubmittedSelection(selection.id);
  if (state == "pending" || state == "validating")
    return std::string(
        current->state == LibraryState::pending && state == "pending" ? "pending" : "validating");
  return std::string("unknown");
}

Result<Json> LibraryController::DirectSelectionCommit(const FileJob& job,
                                                      const std::string& selection_id) {
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
  auto browser_status = [&]() -> Result<Json> {
    RK_RETURN_IF_ERROR(files.RequireFileJob(job));
    return browser.Rpc().Request(SelectionStatusCommand(*selection), job.control, 10000, 0,
                                 [&] { return authorization.Stamp() && files.Current(job); });
  };
  auto initial_status = browser_status();
  if (!initial_status)
    return initial_status.error();
  RK_ASSIGN_OR_RETURN(initial, ObserveSelection(*selection, initial_status.value()));
  if (initial != "pending" || selection->state != LibraryState::pending)
    return result(initial);
  std::vector<remotekit::FileUploadStore::Source> sources;
  for (const auto& file : selection->files) {
    RK_ASSIGN_OR_RETURN(asset, file_library.Describe(file.asset_id));
    RK_ASSIGN_OR_RETURN(path, file_library.Path(file.asset_id));
    sources.push_back({{file.name, file.type, asset.size}, path});
  }
  Json selected_files = Json::array();
  {
    std::lock_guard lock(file_store_mutex);
    const auto check = [&] { return files.RequireFileJob(job); };
    RK_ASSIGN_OR_RETURN(batch, file_uploads.Stage(job.binding, sources, check));
    const auto upload = batch.id;
    {
      for (const auto& file : batch.files)
        selected_files.push_back({{"path", Utf8(file.path)}, {"displayName", file.name}});
      RK_ASSIGN_OR_RETURN(claimed, file_library.Claim(selection_id, check));
      if (!claimed)
        return Error{ErrorCode::kConflict, "file_selection_already_submitted"};
      RK_RETURN_IF_ERROR(file_uploads.MarkSubmitted(upload));
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
  auto direct_file_rpc_result = files.DirectFileRpc(job, "page.reply",
                                                    {{"file_only", true},
                                                     {"accept", true},
                                                     {"files", selected_files},
                                                     {"selection_id", selection_id}});
  if (!direct_file_rpc_result)
    return direct_file_rpc_result.error();
  auto response = std::move(direct_file_rpc_result).value();
  RK_ASSIGN_OR_RETURN(observed, ObserveSelection(*selection, response));
  return result(observed);
}

Result<Json> LibraryController::DirectLibraryCommand(const FileJob& job,
                                                     const std::string& method,
                                                     const Json& params) {
  const auto check = [&] { return files.RequireFileJob(job); };
  if (method == "asset.begin")
    return file_library.Begin(job.grant, Required(params, "operationId"),
                              {Required(params, "name"), params.value("type", std::string()),
                               FileUnsigned(params.at("size"))},
                              check);
  if (method == "asset.chunk") {
    RK_ASSIGN_OR_RETURN(bytes, DecodeFileChunk(params.at("data")));
    RK_ASSIGN_OR_RETURN(offset,
                        file_library.Chunk(job.grant, Required(params, "uploadId"),
                                           FileUnsigned(params.at("offset")), bytes, check));
    return Json{{"offset", offset}};
  }
  if (method == "asset.seal") {
    RK_ASSIGN_OR_RETURN(asset, file_library.Seal(job.grant, Required(params, "uploadId"), check));
    return asset.Json();
  }
  if (method == "asset.cancel") {
    RK_RETURN_IF_ERROR(file_library.Cancel(job.grant, Required(params, "uploadId"), check));
    return Json{{"cancelled", true}};
  }
  if (method == "asset.describe") {
    RK_ASSIGN_OR_RETURN(asset, file_library.Describe(Required(params, "assetId")));
    RK_RETURN_IF_ERROR(check());
    return asset.Json();
  }
  if (method == "asset.read") {
    const auto offset = FileUnsigned(params.at("offset"));
    RK_ASSIGN_OR_RETURN(read, file_library.Read(Required(params, "assetId"), offset));
    const auto& [asset, bytes] = read;
    RK_RETURN_IF_ERROR(check());
    return Json{{"data", remotekit::EncodeFileChunk(bytes)},
                {"offset", offset + bytes.size()},
                {"total", asset.size}};
  }
  return photos.Execute(job, method, params);
}

Result<Json> LibraryController::DirectSelectionCancel(const FileJob& job) {
  const auto token = authorization.Admit();
  const auto current = [&] {
    return authorization.Current(token) && token.peer == job.peer && job.library_grant &&
           files.Current(job);
  };
  if (!current())
    return Error{ErrorCode::kForbidden, "file_transfer_interrupted"};
  const auto check = [&] { return files.RequireFileJob(job); };
  RK_ASSIGN_OR_RETURN(state, file_library.CancelPendingSelections(job.binding, check));
  if (state == LibraryState::submitted)
    return Json{{"state", "validating"}};
  if (state == LibraryState::selected)
    return Json{{"state", "selected"}};
  auto status = files.DirectFileRpc(job, "page.fileStatus");
  if (!status)
    return status.error();
  const auto existing = status.value().value("state", std::string("unknown"));
  if (existing != "pending")
    return Json{{"state", existing}};
  if (!current())
    return Error{ErrorCode::kForbidden, "file_transfer_interrupted"};
  auto cancelled = files.DirectFileRpc(job, "page.reply", {{"file_only", true}, {"accept", false}});
  if (!cancelled)
    return cancelled.error();
  return Json{{"state", "cancelled"}};
}

Result<FileBinding> LibraryController::ParseFileBinding(const Json& value) {
  return FileBinding{Required(value, "browserIncarnation"), Required(value, "view"),
                     Required(value, "instance"), Required(value, "document"),
                     Required(value, "request")};
}

Result<Json> LibraryController::FileBrowserCommand(const FileBinding& binding, const char* method) {
  if (!browser.Alive() || !browser.Rpc().Control() || browser.Stopping() ||
      binding.browser_incarnation != browser.Incarnation() || !views.Contains(binding.view))
    return Error{ErrorCode::kConflict, "stale_file_request_target"};
  return SelectionBrowserCommand(binding, method);
}

Result<Json> LibraryController::LibraryCommand(const std::string& method, const Json& request) {
  if (method == "session.library.describe") {
    RK_ASSIGN_OR_RETURN(asset, file_library.Describe(Required(request, "assetId")));
    return asset.Json();
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
    RK_RETURN_IF_ERROR(file_library.Prepare(selection));
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
               (!views.Contains(selection->binding.view) ||
                selection->binding.browser_incarnation == last_confirmed_browser_exit ||
                (browser.Exited() &&
                 selection->binding.browser_incarnation == browser.ProcessIncarnation()) ||
                (!browser.Incarnation().empty() &&
                 selection->binding.browser_incarnation != browser.Incarnation()))) {
        RK_ASSIGN_OR_RETURN(retired, RetireUnsubmittedSelection(selection->id));
        state = retired;
      } else if (browser.Alive() && browser.Rpc().Control() && !browser.Stopping() &&
                 selection->binding.browser_incarnation == browser.ProcessIncarnation()) {
        Json status;
        {
          auto rpc_result_2 = browser.Rpc().Request(SelectionStatusCommand(*selection));
          if (!rpc_result_2) {
            const Error operation_error = rpc_result_2.error();
            if (selection->state == LibraryState::pending &&
                (operation_error.code == ErrorCode::kConflict ||
                 operation_error.code == ErrorCode::kNotFound)) {
              RK_ASSIGN_OR_RETURN(retired, RetireUnsubmittedSelection(selection->id));
              return Json{{"state", retired}};
            }
            return Json{{"state", "unknown"}};
          }
          status = std::move(rpc_result_2).value();
        }

        RK_ASSIGN_OR_RETURN(observed, ObserveSelection(*selection, status));
        state = observed;
      }
    }
    return Json{{"state", state}};
  }
  return Error{ErrorCode::kInvalidRequest, "unknown_library_method"};
}

Result<void> LibraryController::BrowserStopped(const std::string& incarnation) {
  last_confirmed_browser_exit = incarnation;
  std::lock_guard lock(file_store_mutex);
  file_uploads.ConfirmBrowserStopped(incarnation);

  return {};
}
Result<Json> PhotoService::Execute(const FileJob& job,
                                   const std::string& method,
                                   const Json& params) {
  const auto check = [&] { return files.RequireFileJob(job); };
#ifdef RK_FILE_PHOTO
  const auto cancelled = [&] { return !authorization.Stamp() || !files.Current(job); };
  if (remotekit::PhotoBurstMethod(method))
    return photo_bursts.Execute(job.grant, method, params, cancelled);
  if (method == "photo.thumbnail") {
    const auto asset_id = Required(params, "assetId");
    RK_ASSIGN_OR_RETURN(source, file_library.Path(asset_id));
    const auto now = QpcNow();
    const auto cached = photo_thumbnails.find(asset_id);
    if (cached != photo_thumbnails.end()) {
      std::optional<remotekit::FileLibrary::Asset> thumbnail;
      if (now < cached->second.refresh_after) {
        {
          auto described = file_library.Describe(cached->second.asset_id);
          if (described)
            thumbnail = described.value();
          else if (described.error().code != ErrorCode::kNotFound)
            return described.error();
        }
      }
      if (thumbnail) {
        RK_RETURN_IF_ERROR(check());
        return thumbnail->Json();
      }
      photo_thumbnails.erase(cached);
    }
    RK_ASSIGN_OR_RETURN(
        thumbnail,
        file_library.CreateDerivative(
            [&](const fs::path& output) -> Result<remotekit::FileLibrary::Derivative> {
              RK_ASSIGN_OR_RETURN(dimensions,
                                  remotekit::CreatePhotoThumbnail(source, output, cancelled));
              return remotekit::FileLibrary::Derivative{dimensions.width, dimensions.height};
            },
            [&] { return files.RequireFileJob(job); }, FileLibrary::DerivativeFormat::jpeg,
            asset_id));
    RK_RETURN_IF_ERROR(check());
    constexpr size_t kThumbnailCacheEntries = 256;
    if (photo_thumbnails.size() >= kThumbnailCacheEntries) {
      const auto oldest =
          std::min_element(photo_thumbnails.begin(), photo_thumbnails.end(),
                           [](const auto& left, const auto& right) {
                             return left.second.refresh_after < right.second.refresh_after;
                           });
      photo_thumbnails.erase(oldest);
    }
    photo_thumbnails.emplace(asset_id,
                             PhotoThumbnail{thumbnail.id, QpcNow() + QpcFrequency() * 3600});
    return thumbnail.Json();
  }
  if (method == "photo.rank") {
    const auto& ids = params.at("assetIds");
    if (!ids.is_array() || ids.empty() || ids.size() > 6)
      return Error{ErrorCode::kInvalidRequest, "invalid_photo_count"};
    std::vector<fs::path> paths;
    for (const auto& asset : ids) {
      RK_ASSIGN_OR_RETURN(path, file_library.Path(asset.get<std::string>()));
      paths.push_back(path);
    }
    RK_ASSIGN_OR_RETURN(ranked, remotekit::RankPhotos(paths, cancelled));
    RK_RETURN_IF_ERROR(check());
    Json candidates = Json::array();
    for (const auto& candidate : ranked.candidates)
      candidates.push_back({{"assetId", ids.at(candidate.index)}, {"score", candidate.score}});
    return Json{{"selectedAssetId", ids.at(ranked.selected_index)},
                {"uncertain", ranked.uncertain},
                {"candidates", std::move(candidates)},
                {"reason", ranked.reason}};
  }
  if (method == "photo.process") {
    RK_ASSIGN_OR_RETURN(source, file_library.Path(Required(params, "assetId")));
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
    RK_ASSIGN_OR_RETURN(
        derivative, file_library.CreateDerivative(
                        [&](const fs::path& output) -> Result<FileLibrary::Derivative> {
                          RK_ASSIGN_OR_RETURN(
                              dimensions,
                              ProcessPhoto(source, output,
                                           mode == "scan" ? PhotoMode::kScan : PhotoMode::kRectify,
                                           corners, cancelled));
                          geometry = dimensions.geometry;
                          return FileLibrary::Derivative{dimensions.width, dimensions.height};
                        },
                        check, FileLibrary::DerivativeFormat::png, Required(params, "assetId")));
    auto asset = derivative.Json();
    asset["geometry"] = std::move(geometry);
    return asset;
  }
#endif
  return Error{ErrorCode::kUnavailable, "photo_processing_unavailable"};
}

void PhotoService::Sweep() {
#ifdef RK_FILE_PHOTO
  photo_bursts.Sweep(
      [&](uint64_t grant) { return authorization.Stamp() && files.CurrentLibraryGrant(grant); });
#endif
}
Result<void> FileController::BrowserStopped(const std::string& incarnation) {
  return library.BrowserStopped(incarnation);
}
}  // namespace remotekit

namespace remotekit {
Result<void> LibraryController::Initialize() {
  RK_RETURN_IF_ERROR(file_uploads.Initialize());
  return file_library.Initialize();
}
}  // namespace remotekit
