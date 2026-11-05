#include "browser/control_dispatcher.h"
#include "browser/control_requests.h"
#include "browser/control_response.h"
#include "browser/browser_runtime.h"
#include "browser/control_input_codec.h"

namespace remotekit::browser {
Result<InputRequest> DecodeInput(const base::DictValue& wire, RequestEnvelope envelope) {
  InputRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.output_generation = decoder.Optional<uint64_t>("output_generation");
  request.session = decoder.Optional<uint64_t>("session");
  request.view = decoder.Optional<uint64_t>("view");
  auto input = DecodeControlInput(wire, request.session.value_or(0), request.view.value_or(0));
  if (!input)
    return {{}, input.status};
  request.input = std::move(input.value);
  if (!request.session || !request.view)
    return {{}, {ErrorCode::invalid_request, "Session and view required"}};
  return decoder.Finish(std::move(request));
}

ControlResult ControlDispatcher::HandleInput(const InputRequest& request) {
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

  Status status;

  if (Ptr(request.output_generation)) {
    uint64_t generation = 0;
    if (!Assign(request.output_generation, &generation) || !runtime_.output ||
        generation != runtime_.output_generation)
      return error("stale_output_generation");
  }
  const auto& input = request.input;
  bool input_admitted = false;
  if (runtime_.output)
    runtime_.output->TraceInput("input_browser_dispatch", input);
  status = adapter.DispatchInput(input, &input_admitted);
  if (runtime_.output)
    runtime_.output->TraceInput("input_browser_dispatch_return", input,
                                static_cast<int>(status.error));
  reply.Set("inputAdmitted", input_admitted);

  reply.Set("token", TokenValue(runtime_.view_model.Token(session, view).value));
  runtime_.UpdateOutput();
  if (!status)
    return ControlResult::Failure(id, status.error, status.message, std::move(reply));
  return reply;
}
}  // namespace remotekit::browser
