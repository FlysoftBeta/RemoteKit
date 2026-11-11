#include "media/gpu_device.hpp"
#include "input/input.hpp"
#include "session/browser_rpc.hpp"
#include "util/wire_error.hpp"
#include "rtc/data_router.hpp"
#include "util/thread.hpp"
namespace remotekit {
using media::QpcFrequency;
using media::QpcNow;
using media::TraceIds;
namespace {
bool IsDismissal(const Json& command) {
  if (command.value("type", Json()) == "editing.dismiss")
    return true;
  const auto event = command.find("event");
  return command.value("type", Json()) == "input" && event != command.end() && event->is_object() &&
         (event->value("type", Json()) == "selection_command" ||
          event->value("type", Json()) == "context_command") &&
         event->value("command", Json()) == "dismiss";
}
}  // namespace
void InputController::ReplyInput(Json reply, const Json& request, uint64_t stamp) {
  if (reply.contains("error")) {
    const auto error = ParseWireError(reply["error"]);
    reply["error"] =
        WireError(error, "dc.request_failed", RequestLogFields(request, hooks_.log_fields));
  }
  const bool focus = request.is_object() && request.value("type", Json()) == "focus";
  const bool layout = request.is_object() && request.value("type", Json()) == "keyboard.layout";
  if (layout && reply.value("ok", false))
    return;
  reply["type"] = focus ? "focus" : "input.result";
  if (layout)
    reply["type"] = "error";
  if (focus) {
    reply["focusRequestId"] = request.value("focusRequestId", Json());
    reply["layoutEpoch"] = request.value("layoutEpoch", Json());
  } else if (request.is_object() && request.contains("sequence")) {
    reply["clientSequence"] = request["sequence"];
  }
  hooks_.send(reply, stamp);
}

void InputController::RejectInput(ErrorCode code,
                                  const char* error,
                                  const Json& request,
                                  const Event& event) {
  ++input_rejected;
  ReplyInput({{"ok", false}, {"error", WireError({code, error})}}, request, event.authorization);
}

void InputController::HandleData(const Event& event) {
  const auto token = hooks_.admission();
  const auto current_token = [&] {
    return event.peer == token.peer && event.authorization == token.stamp &&
           hooks_.revalidate(token);
  };
  const bool dismissal = IsDismissal(event.message);
  const auto admitted = [&] {
    return current_token() && (dismissal || hooks_.input_stamp() == token.stamp);
  };
  if (event.value != 0 || !hooks_.admitted(event))
    return;
  auto command = event.message;
  if (command.is_discarded() || !command.is_object())
    return;
  auto type = command.value("type", std::string());
  if (type != "input" && type != "editing.dismiss" && type != "focus" && type != "keyboard.layout")
    return;
  const auto request = command;
  if (type == "keyboard.layout") {
    if (!current_token())
      return;
    Json input = {{"method", "input"}, {"session", session_id_}, {"event", command}};
    input["event"].erase("authEpoch");
    auto response = hooks_.rpc(std::move(input), hooks_.control(), 10000, false, current_token);
    if (current_token()) {
      if (response)
        ReplyInput(std::move(response).value(), request, event.authorization);
      else
        ReplyInput({{"ok", false}, {"error", WireError(response.error())}}, request,
                   event.authorization);
    }
    return;
  }
  if (!admitted()) {
    RejectInput(ErrorCode::kForbidden, "input_not_authorized", request, event);
    return;
  }
  const auto request_epoch = hooks_.epoch();
  if (!dismissal && command.value("layoutEpoch", std::string()) != std::to_string(request_epoch)) {
    RejectInput(ErrorCode::kConflict, "stale_layout_epoch", request, event);
    return;
  }
  command.erase("layoutEpoch");
  command.erase("focusRequestId");
  if (command.value("session", std::string()) != session_id_) {
    RejectInput(ErrorCode::kForbidden, "wrong_session", request, event);
    return;
  }
  if (type == "editing.dismiss") {
    command["event"] = {
        {"type", type}, {"target", command["target"]}, {"revision", command["revision"]}};
    command.erase("target");
    command.erase("revision");
    type = "input";
  }
  if (type == "input" && command.contains("event") && command["event"].is_object()) {
    const auto event_type = command["event"].value("type", std::string());
    if ((event_type == "mouse" || event_type == "wheel" || event_type == "touch" ||
         event_type == "gesture" || event_type == "selection.extent") &&
        !hooks_.allows(command.value("view", std::string()), request_epoch)) {
      RejectInput(ErrorCode::kConflict, "view_not_ready", request, event);
      return;
    }
  }
  command["method"] = type;
  command.erase("type");
  if (type == "input") {
    const auto sequence = input_sequence.NextBrowser();
    if (!sequence) {
      RejectInput(ErrorCode::kInternal, "input_sequence_exhausted", request, event);
      return;
    }
    command["sequence"] = std::to_string(*sequence);
    if (event.trace_input_sequence) {
      RK_SERVER_TRACE(hooks_.trace(), "input_browser_assigned", TraceIds{},
                      rk_record.peer = event.peer;
                      rk_record.client_sequence = event.trace_input_sequence;
                      rk_record.browser_sequence = *sequence;);
    }
  }
  if (dismissal)
    command.erase("outputGeneration");
  if (command.contains("outputGeneration")) {
    command["output_generation"] = command["outputGeneration"];
    command.erase("outputGeneration");
  }
  // This connection is already bound to this Session by authenticated Control.
  // The browser validates membership and all token/sequence/output generations.
  const auto input_control = hooks_.control();
  {
    // Only Browser's pre-admission BUSY is retryable. Keep the exact browser
    // sequence; an accepted asynchronous injection is never replayed.
    const auto deadline = QpcNow() + QpcFrequency() / 4;
    auto response = type == "input"
                        ? remotekit::RetryBrowserInput(
                              command,
                              [&](const Json& request) {
                                return hooks_.rpc(request, input_control, 10000, 0, admitted);
                              },
                              [&] {
                                return !stop_input && admitted() &&
                                       (dismissal || request_epoch == hooks_.epoch());
                              },
                              [&] { return QpcNow() >= deadline; },
                              [] { std::this_thread::sleep_for(std::chrono::milliseconds(5)); },
                              [&] { ++input_busy_retries; }, [&] { ++input_busy_exhausted; })
                        : hooks_.rpc(command, 0, 10000, 0, admitted);
    if (!response) {
      const auto& error = response.error();
      if (admitted())
        ReplyInput({{"ok", false}, {"error", WireError(error)}}, request, event.authorization);
      return;
    }
    auto reply = std::move(response).value();
    if (type == "input")
      reply["browserSequence"] = command["sequence"];
    if (admitted())
      ReplyInput(std::move(reply), request, event.authorization);
  }
}

void InputController::QueueInput(const Event& event) {
  std::lock_guard lock(input_mutex);
  if (!hooks_.admitted(event) || event.value != 0)
    return;
  if (event.trace_input_sequence) {
    RK_SERVER_TRACE(hooks_.trace(), "input_comp_dequeue", TraceIds{}, rk_record.peer = event.peer;
                    rk_record.client_sequence = event.trace_input_sequence;);
  }
  auto parsed = event.message;
  if (!parsed.is_object())
    return;
  const auto type = parsed.value("type", std::string());
  if (type != "input" && type != "editing.dismiss" && type != "focus" && type != "keyboard.layout")
    return;
  // A Session keyboard layout can arrive before the first input-ready frame.
  if (type != "keyboard.layout" && !IsDismissal(parsed) &&
      hooks_.input_stamp() != event.authorization) {
    RejectInput(ErrorCode::kForbidden, "input_not_authorized", parsed, event);
    return;
  }
  // Validate arrival order before move coalescing can replace a newer packet.
  // The Browser keeps its independent Session counter across RTC reconnects.
  if ((type == "input" || type == "editing.dismiss") &&
      (!parsed.contains("sequence") || !parsed["sequence"].is_string() ||
       !input_sequence.Admit(event.peer, parsed["sequence"].get<std::string>()))) {
    RejectInput(ErrorCode::kConflict, "stale_client_sequence", parsed, event);
    return;
  }
  bool move = !parsed.is_discarded() && parsed.value("type", std::string()) == "input" &&
              parsed.contains("event") && parsed["event"].value("type", std::string()) == "mouse" &&
              parsed["event"].value("action", std::string()) == "move";
  if (move && !input_queue.empty()) {
    auto before = input_queue.back().message;
    if (input_queue.back().peer == event.peer &&
        input_queue.back().authorization == event.authorization && !before.is_discarded() &&
        before.value("view", std::string()) == parsed.value("view", std::string()) &&
        before.contains("event") && before["event"].value("type", std::string()) == "mouse" &&
        before["event"].value("action", std::string()) == "move") {
      input_queue.back() = event;
      ++input_coalesced;
      input_wake.notify_one();
      return;
    }
  }
  if (input_queue.size() >= 256) {
    RejectInput(ErrorCode::kBusy, "input_queue_busy", parsed, event);
    return;
  }
  if (event.trace_input_sequence) {
    RK_SERVER_TRACE(hooks_.trace(), "input_worker_queue", TraceIds{}, rk_record.peer = event.peer;
                    rk_record.client_sequence = event.trace_input_sequence;
                    rk_record.queue = static_cast<int>(input_queue.size()););
  }
  input_queue.push_back(event);
  input_wake.notify_one();
}

void InputController::InputLoop() {
  while (true) {
    std::optional<Event> event;
    {
      std::unique_lock lock(input_mutex);
      const auto ready = [&] { return stop_input || !input_queue.empty(); };
      input_wake.wait(lock, ready);
      if (stop_input)
        break;
      if (!input_queue.empty()) {
        event = std::move(input_queue.front());
        input_queue.pop_front();
      }
    }
    if (event) {
      if (event->trace_input_sequence) {
        RK_SERVER_TRACE(hooks_.trace(), "input_worker_begin", TraceIds{},
                        rk_record.peer = event->peer;
                        rk_record.client_sequence = event->trace_input_sequence;);
      }
      auto handled = DataRouter::Boundary([&]() -> Result<void> {
        HandleData(*event);
        return {};
      });
      if (!handled && hooks_.admitted(*event)) {
        ++input_rejected;
        ReplyInput({{"ok", false}, {"error", WireError(handled.error())}}, event->message,
                   event->authorization);
      }
    }
  }
}
InputController::InputController(std::string session, Hooks hooks)
    : session_id_(std::move(session)), hooks_(std::move(hooks)) {}
InputController::~InputController() {
  Stop();
}
void InputController::Start(uint64_t peer) {
  Stop();
  {
    std::lock_guard lock(input_mutex);
    input_sequence.Bind(peer);
  }
  stop_input = false;
  input_thread = std::thread([this] {
    RunThread(
        "input", [this] { InputLoop(); },
        [this] {
          stop_input = true;
          hooks_.failed();
        });
  });
}
void InputController::Clear() {
  std::lock_guard lock(input_mutex);
  input_queue.clear();
}
void InputController::Stop() {
  {
    std::lock_guard lock(input_mutex);
    stop_input = true;
  }
  input_wake.notify_all();
  if (input_thread.joinable())
    input_thread.join();
  Clear();
  std::lock_guard lock(input_mutex);
  input_sequence.Bind(0);
}
Json InputController::Snapshot() const {
  std::lock_guard lock(input_mutex);
  return {{"inputRejected", input_rejected.load()},
          {"inputCoalesced", input_coalesced.load()},
          {"inputBusyRetries", input_busy_retries.load()},
          {"inputBusyExhausted", input_busy_exhausted.load()},
          {"inputQueue", input_queue.size()}};
}
}  // namespace remotekit
