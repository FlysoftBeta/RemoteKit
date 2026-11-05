#include "browser/control_dispatcher.h"
#include "browser/control_requests.h"
#include "browser/control_response.h"
#include "browser/browser_runtime.h"
#include "browser/control_input_codec.h"

namespace remotekit::browser {
Result<TouchStatusRequest> DecodeTouchStatus(const base::DictValue& wire,
                                             RequestEnvelope envelope) {
  TouchStatusRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.sequenceId = decoder.Optional<std::string>("sequenceId");
  request.instance = decoder.Optional<uint64_t>("instance");
  request.document = decoder.Optional<uint64_t>("document");
  request.focus = decoder.Optional<uint64_t>("focus");
  request.session = decoder.Optional<uint64_t>("session");
  request.view = decoder.Optional<uint64_t>("view");
  if (!request.session || !request.view)
    return {{}, {ErrorCode::invalid_request, "Session and view required"}};
  return decoder.Finish(std::move(request));
}

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

ControlResult ControlDispatcher::HandleTouchStatus(const TouchStatusRequest& request) {
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
  if (record->requests->close_state() == "closing")
    return ControlResult::Failure(id, "view_closing");

  const auto* sequence = Ptr(request.sequenceId);
  InputToken owner{session, view};
  reply.Set("state", "terminal-unconfirmed");
  reply.Set("pending", false);
  if (!sequence || sequence->empty() || sequence->size() > 128 ||
      !Assign(request.instance, &owner.instance) || !Assign(request.document, &owner.document) ||
      !Assign(request.focus, &owner.focus))
    return error("invalid_touch_status_identity");
  reply.Set("sequenceId", *sequence);
  adapter.RefreshClientTouchOwner();
  using State = ClientTouchRetirement::State;
  const auto completion = *method == "input.touchRetire"
                              ? adapter.RetireClientTouch(owner, *sequence)
                              : adapter.ClientTouchStatus(owner, *sequence);
  if (completion == State::invalidated) {
    reply.Set("state", "terminal-invalidated");
    return error("touch_owner_invalidated");
  }
  if (completion == State::pending) {
    reply.Set("state", "pending");
    reply.Set("pending", true);
    return error("touch_terminal_pending");
  }
  if (completion != State::processed)
    return error("touch_terminal_unconfirmed");
  reply.Set("state", "processed");
  reply.Set("ok", true);
  return reply;
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
  if (const auto* touch = std::get_if<TouchInput>(&input.payload)) {
    reply.Set("touchPending", adapter.TouchProcessingPending());
    reply.Set("touchSequenceId", touch->clock ? touch->clock->sequence_id : std::string());
    reply.Set("inputAdmitted", input_admitted);
    if (touch->clock &&
        (touch->action == TouchInput::Action::end || touch->action == TouchInput::Action::cancel))
      reply.Set("touchTerminal",
                adapter.ClientTouchStatus(input.token, touch->clock->sequence_id) !=
                    ClientTouchRetirement::State::unknown);
    if (!status && touch->clock &&
        (input_admitted || (status.error == ErrorCode::stale_identity &&
                            status.message == "Client touch owner explicitly invalidated")) &&
        adapter.ClientTouchRetired(input.token, touch->clock->sequence_id)) {
      reply.Set("touchState", "terminal-invalidated");
      reply.Set("touchPending", false);
    }
  }

  reply.Set("token", TokenValue(runtime_.view_model.Token(session, view).value));
  runtime_.UpdateOutput();
  if (!status)
    return ControlResult::Failure(id, status.error, status.message, std::move(reply));
  return reply;
}
}  // namespace remotekit::browser
