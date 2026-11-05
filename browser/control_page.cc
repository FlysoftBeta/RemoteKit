#include "browser/control_dispatcher.h"
#include "browser/control_requests.h"
#include "browser/control_response.h"
#include "browser/browser_runtime.h"
#include <algorithm>

namespace remotekit::browser {
Result<ProfileCommandRequest> DecodeProfileCommand(const base::DictValue& wire,
                                                   RequestEnvelope envelope) {
  ProfileCommandRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.command = decoder.Optional<base::DictValue>("command");
  request.session = decoder.Optional<uint64_t>("session");
  request.view = decoder.Optional<uint64_t>("view");
  if (!request.session || !request.view)
    return {{}, {ErrorCode::invalid_request, "Session and view required"}};
  return decoder.Finish(std::move(request));
}

Result<PageControlRequest> DecodePageRequest(const base::DictValue& wire,
                                             RequestEnvelope envelope) {
  PageControlRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.request = decoder.Optional<std::string>("request");
  request.action = decoder.Optional<std::string>("action");
  request.selection_id = decoder.Optional<std::string>("selection_id");
  request.session = decoder.Optional<uint64_t>("session");
  request.view = decoder.Optional<uint64_t>("view");
  request.instance = decoder.Optional<uint64_t>("instance");
  request.document = decoder.Optional<uint64_t>("document");
  request.payload = wire.Clone();
  auto operation = DecodeNavigationOperation(wire, envelope.method == "navigation.ack");
  if (!operation)
    return {{}, operation.status};
  request.operation = std::move(operation.value);
  if (!request.session || !request.view)
    return {{}, {ErrorCode::invalid_request, "Session and view required"}};
  return decoder.Finish(std::move(request));
}

Result<ExitFullscreenRequest> DecodeExitFullscreen(const base::DictValue& wire,
                                                   RequestEnvelope envelope) {
  ExitFullscreenRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.instance = decoder.Optional<uint64_t>("instance");
  request.document = decoder.Optional<uint64_t>("document");
  request.session = decoder.Optional<uint64_t>("session");
  request.view = decoder.Optional<uint64_t>("view");
  if (!request.session || !request.view)
    return {{}, {ErrorCode::invalid_request, "Session and view required"}};
  return decoder.Finish(std::move(request));
}

ControlResult ControlDispatcher::HandleProfileCommand(const ProfileCommandRequest& request) {
  const int id = request.id;
  const auto* method = &request.method;
  auto reply = ControlResult::Success(id);
  auto error = [&](std::string detail) {
    return ControlResult::Failure(id, detail, std::move(reply));
  };
  const auto session = request.session.value_or(0);
  const auto view = request.view.value_or(0);
  auto* record = runtime_.views.Find(session, view);
  if (!record || !runtime_.view_model.FindWebView(session, view))
    return ControlResult::Failure(request.id, ErrorCode::not_found, "View is not in session");

  const auto* command = Ptr(request.command);
  if (!command)
    return error("profile_command_required");
  auto profile = runtime_.view_model.FindWebView(session, view)->profile;
  auto found = std::find(runtime_.profiles.begin(), runtime_.profiles.end(), profile);
  if (found == runtime_.profiles.end())
    return error("profile_missing");
  auto* context = runtime_.contexts[static_cast<size_t>(found - runtime_.profiles.begin())].get();
  auto result = *method == "profile.permissions" ? context->PermissionsCommand(*command)
                                                 : context->DownloadsCommand(*command);
  result.Set("version", protocol::kControlVersion);
  result.Set("id", id);
  return result;
}

ControlResult ControlDispatcher::HandlePageRequest(const PageControlRequest& request) {
  const int id = request.id;
  const auto* method = &request.method;
  auto reply = ControlResult::Success(id);
  auto error = [&](std::string detail) {
    return ControlResult::Failure(id, detail, std::move(reply));
  };
  const auto session = request.session.value_or(0);
  const auto view = request.view.value_or(0);
  auto* record = runtime_.views.Find(session, view);
  if (!record || !runtime_.view_model.FindWebView(session, view))
    return ControlResult::Failure(request.id, ErrorCode::not_found, "View is not in session");
  auto& adapter = *record->webview;

  const auto token = runtime_.view_model.Token(session, view).value;
  PageRequests::SelectionBinding binding{token.instance, token.document};
  bool terminal_only = false;
  if (*method == "page.reply" || *method == "page.fileStatus") {
    if (request.instance && *request.instance != token.instance)
      return error("stale_page_request_target");
    if (request.document && *request.document != token.document) {
      if (*method != "page.fileStatus" || !request.instance || !request.selection_id)
        return error("stale_page_request_target");
      binding.document = *request.document;
      terminal_only = true;
    }
  }

  if (*method == "page.fileStatus") {
    const auto* key = Ptr(request.request);
    if (!key)
      return error("file_request_required");
    auto result =
        record->requests->FileStatus(*key, Ptr(request.selection_id), binding, terminal_only);
    result.Set("version", 1);
    result.Set("id", id);
    return result;
  }
  if (*method == "page.command") {
    const auto* action = Ptr(request.action);
    if (action &&
        (*action == "back" || *action == "forward" || *action == "reload" || *action == "stop")) {
      auto status = adapter.NavigationCommand(*action, request.operation);
      auto result = reply.Clone();
      result.Set("ok", static_cast<bool>(status));
      result.Set("accepted", static_cast<bool>(status));
      result.Set("state", "submitted");
      if (!status)
        return ControlResult::Failure(id, status.error, status.message, std::move(result));
      return result;
    }
  }
  base::DictValue result;
  if (*method == "page.requests") {
    const auto& spec = record->spec;
    const PageRequests::AnchorLayout layout{
        spec.width,     spec.height,    runtime_.layout_transaction.PageScale(spec),
        token.instance, token.document, runtime_.output_generation};
    result = record->requests->Snapshot(
        runtime_.output && spec.visible && token.instance && token.document ? &layout : nullptr);
  } else {
    result = *method == "page.reply" ? record->requests->Reply(request.payload, binding)
                                     : record->requests->Command(request.payload);
  }
  result.Set("version", protocol::kControlVersion);
  result.Set("id", id);
  if (*method == "page.requests" && !result.contains("ok"))
    result.Set("ok", true);
  return result;
}

ControlResult ControlDispatcher::HandleExitFullscreen(const ExitFullscreenRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);
  auto error = [&](std::string detail) {
    return ControlResult::Failure(id, detail, std::move(reply));
  };
  const auto session = request.session.value_or(0);
  const auto view = request.view.value_or(0);
  auto* record = runtime_.views.Find(session, view);
  if (!record || !runtime_.view_model.FindWebView(session, view))
    return ControlResult::Failure(request.id, ErrorCode::not_found, "View is not in session");
  auto& adapter = *record->webview;
  if (record->requests->close_state() == "closing")
    return ControlResult::Failure(id, "view_closing");

  const auto token = runtime_.view_model.Token(session, view).value;
  uint64_t instance = 0, document = 0;
  if (!Assign(request.instance, &instance) || !Assign(request.document, &document) ||
      instance != token.instance || document != token.document || !adapter.contents())
    return error("stale_page_request_target");
  if (record->requests->fullscreen())
    adapter.contents()->ExitFullscreen(/*will_cause_resize=*/false);
  reply.Set("ok", true);
  return reply;
}
}  // namespace remotekit::browser
