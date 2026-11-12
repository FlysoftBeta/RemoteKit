#include "util/log.hpp"
#include "files/files.hpp"
#include "rtc/authorization.hpp"
#include "rtc/peer.hpp"
#include "session/views.hpp"
#include "util/result_macros.hpp"
namespace remotekit {
Result<void> FileController::RequireFileJob(const FileJob& job) {
  if (!authorization.Stamp() || !file_services.Current(job))
    return Error{ErrorCode::kConflict, "file_transfer_interrupted"};
  return {};
}

Result<Json> FileController::DirectFileRpc(const FileJob& job, const char* method, Json additions) {
  RK_RETURN_IF_ERROR(RequireFileJob(job));
  const auto token = authorization.Admit();
  if (token.peer != job.peer || !authorization.Current(token))
    return Error{ErrorCode::kConflict, "file_transfer_interrupted"};
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
  if (method == "selection.commit")
    return library.DirectSelectionCommit(job, Required(params, "selectionId"));
  if (method == "selection.cancel")
    return library.DirectSelectionCancel(job);
  return Error{ErrorCode::kInvalidRequest, "unknown_file_method"};
}

Result<Json> FileController::AuthorizeFiles(const Json& request) {
  std::map<std::string, FileBinding> bindings;
  if (!request.contains("requests"))
    return Error{ErrorCode::kInvalidRequest, "invalid_file_authorization_count"};
  const auto& requests = request.at("requests");
  if (!requests.is_array() || requests.size() > 64)
    return Error{ErrorCode::kInvalidRequest, "invalid_file_authorization_count"};
  for (const auto& item : requests) {
    const auto token = Required(item, "id");
    if (token.size() > 128 || token == "library")
      return Error{ErrorCode::kInvalidRequest, "invalid_file_request_id"};
    if (!item.contains("binding"))
      return Error{ErrorCode::kInvalidRequest, "file binding required"};
    auto parse_file_binding_result = library.ParseFileBinding(item.at("binding"));
    if (!parse_file_binding_result)
      return parse_file_binding_result.error();
    const auto binding = std::move(parse_file_binding_result).value();
    if (binding.browser_incarnation != browser.Incarnation() || !views.Contains(binding.view))
      return Error{ErrorCode::kConflict, "stale_file_request_target"};
    if (!bindings.emplace(token, binding).second)
      return Error{ErrorCode::kInvalidRequest, "duplicate_file_authorization"};
  }
  auto admission = authorization.LockAdmission();
  if (!authorization.Stamp())
    return Error{ErrorCode::kConflict, "authorization_changed"};
  {
    const auto epoch = request.find("authEpoch");
    if (epoch == request.end() || !epoch->is_number_unsigned() ||
        epoch->get<uint64_t>() != authorization.Epoch())
      return Error{ErrorCode::kConflict, "stale_authorization_epoch"};
  }
  RK_RETURN_IF_ERROR(file_services.Authorize(Required(request, "connectionId"),
                                             browser.Rpc().Control(), bindings, false));
  return Json{{"accepted", true}};
}

void FileController::Start() {
  file_services.Start([this](const auto& job) { return DirectFileCommand(job); },
                      [this] {
                        auto swept = library.SweepDirectFiles();
                        if (!swept)
                          LogError(LogLevel::kWarn, "files.sweep_failed", swept.error());
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
    throw InvalidRequest("invalid_file_integer");
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
  RK_ASSIGN_OR_RETURN(sources, file_library.SelectionSources(
                                   *selection, [&] { return files.RequireFileJob(job); }));
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

Result<Json> LibraryController::DirectSelectionCancel(const FileJob& job) {
  const auto token = authorization.Admit();
  const auto current = [&] {
    return authorization.Current(token) && token.peer == job.peer && job.grant &&
           files.Current(job);
  };
  if (!current())
    return Error{ErrorCode::kConflict, "file_transfer_interrupted"};
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
    return Error{ErrorCode::kOutcomeUnknown, "Authorization changed after file operation"};
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
  const auto selection_id = Required(request, "selectionId");
  if (method == "session.library.prepare") {
    auto binding = ParseFileBinding(request.value("binding", Json()));
    if (!binding)
      return binding.error();
    LibrarySelection selection{
        selection_id, Required(request, "requestId"), std::move(binding).value(), {}};
    if (!request.contains("limits") || !request["limits"].is_object() ||
        !request["limits"].contains("maxFileBytes") ||
        !request["limits"].contains("maxBatchBytes") || !request["limits"].contains("maxFiles"))
      return Error{ErrorCode::kInvalidRequest, "invalid_file_limits"};
    const auto& limits = request.at("limits");
    selection.limits.file_bytes = FileUnsigned(limits.at("maxFileBytes"));
    selection.limits.batch_bytes = FileUnsigned(limits.at("maxBatchBytes"));
    selection.limits.files = static_cast<std::size_t>(FileUnsigned(limits.at("maxFiles")));
    if (!selection.limits.file_bytes || !selection.limits.batch_bytes || !selection.limits.files ||
        selection.limits.file_bytes > 256ULL * 1024 * 1024 ||
        selection.limits.batch_bytes > 512ULL * 1024 * 1024 || selection.limits.files > 64)
      return Error{ErrorCode::kInvalidRequest, "invalid_file_limits"};
    const auto previous = file_library.FindSelection(selection_id);
    if (previous) {
      selection.accept = previous->accept;
    } else {
      RK_ASSIGN_OR_RETURN(accept, views.FileChooserAccept(selection.binding));
      selection.accept = std::move(accept);
    }
    if (!request.contains("files"))
      return Error{ErrorCode::kInvalidRequest, "invalid_file_count"};
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
