#include "browser/control_dispatcher.h"
#include "browser/control_requests.h"
#include "browser/control_response.h"
#include "browser/browser_runtime.h"
#include "browser/control_input_codec.h"
#include "browser/offscreen_host.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"

#include <algorithm>

namespace remotekit::browser {
namespace {
std::optional<InputRequest::KeyboardLayout> DecodeKeyboardLayout(const base::DictValue& event) {
  const auto* entries = event.FindList("entries");
  if (!entries || entries->size() > 256)
    return std::nullopt;
  InputRequest::KeyboardLayout layout;
  for (const auto& entry : *entries) {
    const auto* pair = entry.GetIfList();
    if (!pair || pair->size() != 2)
      return std::nullopt;
    const auto* code = (*pair)[0].GetIfString();
    const auto* key = (*pair)[1].GetIfString();
    if (!code || code->empty() || code->size() > 32 ||
        !std::ranges::all_of(*code, [](char c) { return base::IsAsciiAlphaNumeric(c); }) || !key ||
        key->empty() || key->size() > 16 || base::UTF8ToUTF16(*key).size() > 4 ||
        !layout.try_emplace(*code, *key).second)
      return std::nullopt;
  }
  return layout;
}
}  // namespace

Result<InputRequest> DecodeInput(const base::DictValue& wire, RequestEnvelope envelope) {
  InputRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.output_generation = decoder.Optional<uint64_t>("output_generation");
  request.session = decoder.Optional<uint64_t>("session");
  request.view = decoder.Optional<uint64_t>("view");
  const auto* event = wire.FindDict("event");
  const auto* type = event ? event->FindString("type") : nullptr;
  if (type && *type == "keyboard.layout") {
    auto layout = DecodeKeyboardLayout(*event);
    if (!request.session || !*request.session || request.view || request.output_generation ||
        !layout)
      return {{}, {ErrorCode::kInvalidRequest, "Invalid keyboard layout"}};
    request.input = std::move(*layout);
    return decoder.Finish(std::move(request));
  }
  auto input = DecodeControlInput(wire, request.session.value_or(0), request.view.value_or(0));
  if (!input)
    return {{}, input.status};
  request.input = std::move(input.value);
  if (!request.session || !request.view)
    return {{}, {ErrorCode::kInvalidRequest, "Session and view required"}};
  return decoder.Finish(std::move(request));
}

ControlResult ControlDispatcher::HandleInput(const InputRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);
  auto error = [&](ErrorCode code, std::string detail) {
    return ControlResult::Failure(id, code, detail, std::move(reply));
  };
  const auto session = request.session.value_or(0);
  if (const auto* layout = std::get_if<InputRequest::KeyboardLayout>(&request.input)) {
    if (session != runtime_.session_id)
      return ControlResult::Failure(id, ErrorCode::kNotFound, "Session not found");
    OffscreenHost::SetKeyboardLayoutMap(*layout);
    return reply;
  }
  const auto view = request.view.value_or(0);
  auto* record = runtime_.views.Find(session, view);
  if (!record || !runtime_.view_model.FindWebView(session, view))
    return ControlResult::Failure(request.id, ErrorCode::kNotFound, "View is not in session");
  auto& adapter = *record->webview;
  if (record->requests->close_state() == "closing")
    return ControlResult::Failure(id, ErrorCode::kConflict, "view_closing");

  Status status;

  if (Ptr(request.output_generation)) {
    uint64_t generation = 0;
    if (!Assign(request.output_generation, &generation) || !runtime_.output ||
        generation != runtime_.output_generation)
      return error(ErrorCode::kConflict, "stale_output_generation");
  }
  const auto& input = std::get<InputEvent>(request.input);
  bool input_admitted = false;
  if (runtime_.output)
    runtime_.output->TraceInput("input_browser_dispatch", input);
  status = adapter.DispatchInput(input, &input_admitted);
  if (runtime_.output)
    runtime_.output->TraceInput("input_browser_dispatch_return", input,
                                status.error ? static_cast<int>(*status.error) : 0);
  reply.Set("inputAdmitted", input_admitted);

  reply.Set("token", TokenValue(runtime_.view_model.Token(session, view).value));
  runtime_.UpdateOutput();
  if (!status)
    return ControlResult::Failure(id, input_admitted ? ErrorCode::kOutcomeUnknown : *status.error,
                                  status.message, std::move(reply));
  return reply;
}
}  // namespace remotekit::browser
