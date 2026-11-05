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
void InputController::ReplyInput(Json reply, const Json& request, uint64_t stamp) {
  const bool focus = request.is_object() && request.value("type", Json()) == "focus";
  reply["type"] = focus ? "focus" : "input.result";
  if (focus) {
    reply["focusRequestId"] = request.value("focusRequestId", Json());
    reply["layoutEpoch"] = request.value("layoutEpoch", Json());
  } else if (request.is_object() && request.contains("sequence")) {
    reply["clientSequence"] = request["sequence"];
  } else if (request.is_object() && request.contains("clientSequence")) {
    reply["clientSequence"] = request["clientSequence"];
  }
  if (!reply.value("ok", false) && reply.contains("code")) {
    reply["error"] = WireError(BrowserRpc::ReplyError(reply));
    reply.erase("code");
    reply.erase("detail");
  }
  hooks_.send(reply, stamp);
}

std::string InputController::ClientTouchSequence(const Json& request) {
  if (request.value("type", std::string()) == "input.touchRetire")
    return request.value("sequenceId", std::string());
  const auto raw = request.find("event");
  if (raw == request.end() || !raw->is_object() || raw->value("type", std::string()) != "touch" ||
      raw->value("gestureMode", std::string()) != "client-v1")
    return {};
  return raw->value("sequenceId", std::string());
}

std::string InputController::ClientTouchTerminal(const Json& request) {
  const auto sequence = ClientTouchSequence(request);
  if (sequence.empty() || sequence.size() > 128)
    return {};
  const auto client_sequence = request.value("sequence", std::string());
  if (client_sequence.empty() || client_sequence.size() > 20)
    return {};
  if (request.value("type", std::string()) == "input.touchRetire")
    return sequence;
  const auto action = request.at("event").value("action", std::string());
  if (action != "end" && action != "cancel")
    return {};
  return sequence;
}

remotekit::TouchTerminalReceipt* InputController::ReserveTouchTerminal(
    remotekit::TouchTerminalReceipts& terminals,
    const Event& event,
    const Json& request,
    const std::string& sequence,
    uint64_t input_control) {
  remotekit::TouchTerminalReceipt candidate;
  candidate.peer = event.peer;
  candidate.authorization = event.authorization;
  candidate.control = input_control;
  candidate.client_sequence = request.value("sequence", std::string());
  candidate.sequence = sequence;
  candidate.query = {{"method", "input.touchStatus"}, {"sequenceId", sequence}};
  for (const auto* key : {"session", "view", "instance", "document", "focus"})
    if (request.contains(key))
      candidate.query[key] = request[key];
  return terminals.Reserve(std::move(candidate));
}

void InputController::RejectInput(const char* error,
                                  const Json& request,
                                  const Event& event,
                                  remotekit::TouchTerminalReceipts* terminals) {
  ++input_rejected;
  if (terminals) {
    const auto sequence = ClientTouchTerminal(request);
    if (!sequence.empty()) {
      const auto client_sequence = request.value("sequence", std::string());
      // A stale duplicate may never overwrite the original request's receipt.
      if (terminals->Find(event.peer, event.authorization, client_sequence, sequence))
        return;
      remotekit::TouchTerminalReceipt rejection;
      rejection.peer = event.peer;
      rejection.authorization = event.authorization;
      rejection.client_sequence = client_sequence;
      rejection.sequence = sequence;
      if (auto* receipt = terminals->Reserve(std::move(rejection))) {
        receipt->Finish("rejected", false, error, InputRejectionCode(error));
        return;
      }
    }
  }
  Json reply = {{"ok", false}, {"error", WireError({InputRejectionCode(error), error})}};
  if (const auto sequence = ClientTouchSequence(request); !sequence.empty()) {
    reply["touchState"] = "rejected";
    reply["touchSequenceId"] = sequence;
  }
  ReplyInput(std::move(reply), request, event.authorization);
}

void InputController::PollTouchTerminal(remotekit::TouchTerminalReceipt& receipt) {
  const auto current = [&] {
    return hooks_.peer() == receipt.peer && hooks_.current(receipt.authorization) &&
           hooks_.control() == receipt.control;
  };
  if (!current()) {
    receipt.Finish("terminal-unconfirmed", false, "touch_terminal_identity_changed");
    return;
  }
  if (QpcNow() >= receipt.deadline) {
    receipt.Finish("terminal-unconfirmed", false, "touch_terminal_timeout");
    return;
  }
  auto status = hooks_.rpc(receipt.query, receipt.control, 10000, true, current);
  if (!status) {
    if (status.error().code == ErrorCode::kBusy)
      receipt.due = QpcNow() + QpcFrequency() / 200;
    else
      receipt.Finish("terminal-unconfirmed", false, status.error().message, status.error().code);
    return;
  }
  if (!current())
    receipt.Finish("terminal-unconfirmed", false, "touch_terminal_identity_changed");
  else if (!remotekit::ApplyTouchTerminalStatus(receipt, status.value()))
    receipt.due = QpcNow() + QpcFrequency() / 200;
}

void InputController::FlushTouchTerminals(remotekit::TouchTerminalReceipts& terminals) {
  hooks_.flush();
  terminals.Flush([&](const auto& receipt, const Json& message) {
    bool sent = false;
    hooks_.notice(receipt.peer, receipt.authorization, message.dump(),
                  [&](const std::string& encoded) {
                    sent = hooks_.peer() == receipt.peer && hooks_.data_open() &&
                           hooks_.frame_stamp() == receipt.authorization &&
                           hooks_.send_data(receipt.peer, receipt.authorization, encoded) == 0;
                  });
    return sent;
  });
}

void InputController::HandleData(const Event& event, remotekit::TouchTerminalReceipts& terminals) {
  const auto token = hooks_.admission();
  const auto current_token = [&] {
    return event.peer == token.peer && event.authorization == token.stamp &&
           hooks_.revalidate(token);
  };
  const auto admitted = [&] { return current_token() && hooks_.input_stamp() == token.stamp; };
  if (event.value != 0 || !hooks_.admitted(event))
    return;
  auto command = event.message;
  if (command.is_discarded() || !command.is_object())
    return;
  auto type = command.value("type", std::string());
  if (type == "input.touchStatus") {
    const auto client_sequence = command.value("clientSequence", std::string());
    const auto sequence = command.value("sequenceId", std::string());
    if (client_sequence.empty() || client_sequence.size() > 20 || sequence.empty() ||
        sequence.size() > 128)
      return;
    if (auto* receipt =
            terminals.Find(event.peer, event.authorization, client_sequence, sequence)) {
      const auto state = receipt->result.is_object()
                             ? receipt->result.value("touchState", std::string())
                             : std::string();
      if (receipt->polling)
        receipt->send_acceptance = receipt->acceptance.is_object();
      else if (state == "terminal-unconfirmed" && receipt->control == hooks_.control())
        receipt->Schedule(QpcNow(), 2 * QpcFrequency());
      else
        receipt->send_result = true;
    } else
      ReplyInput({{"ok", false},
                  {"error", WireError({ErrorCode::kNotFound, "unknown_touch_terminal"})},
                  {"touchState", "terminal-unconfirmed"},
                  {"touchSequenceId", sequence}},
                 command, event.authorization);
    return;
  }
  if (type != "input" && type != "focus" && type != "input.touchRetire")
    return;
  const auto request = command;
  if (event.input_rejection) {
    RejectInput(event.input_rejection, request, event, &terminals);
    return;
  }
  if (type == "input.touchRetire") {
    const auto sequence = ClientTouchTerminal(request);
    uint64_t old_epoch = 0, token_id = 0;
    if (sequence.empty() || !DataRouter::Number(request, "layoutEpoch", old_epoch) ||
        old_epoch >= hooks_.epoch() || request.value("session", std::string()) != session_id_ ||
        !DataRouter::Number(request, "view", token_id) ||
        !DataRouter::Number(request, "instance", token_id) ||
        !DataRouter::Number(request, "document", token_id) ||
        !DataRouter::Number(request, "focus", token_id)) {
      RejectInput("invalid_touch_retirement_identity", request, event, &terminals);
      return;
    }
    const auto input_control = hooks_.control();
    auto* receipt = ReserveTouchTerminal(terminals, event, request, sequence, input_control);
    if (!receipt) {
      RejectInput("touch_terminal_queue_busy", request, event);
      return;
    }
    auto retire = receipt->query;
    retire["method"] = "input.touchRetire";
    // This command has no coordinates and only operates on the exact old
    // Browser owner. Keep the normal coordinate/keyframe gates below.
    const auto current = [&] { return current_token() && input_control == hooks_.control(); };
    {
      auto rpc_result = hooks_.rpc(retire, input_control, 10000, false, current);
      if (!rpc_result) {
        const Error error = rpc_result.error();
        receipt->Finish("terminal-unconfirmed", false, error.message, error.code);
        return;
      }
      const auto reply = std::move(rpc_result).value();
      if (!current())
        receipt->Finish("terminal-unconfirmed", false, "touch_terminal_identity_changed");
      else if (!remotekit::ApplyTouchTerminalStatus(*receipt, reply))
        receipt->Accept(QpcNow(), 2 * QpcFrequency());
    }

    return;
  }
  if (!admitted()) {
    RejectInput("input_not_authorized", request, event, &terminals);
    return;
  }
  const auto request_epoch = hooks_.epoch();
  if (command.value("layoutEpoch", std::string()) != std::to_string(request_epoch)) {
    RejectInput("stale_layout_epoch", request, event, &terminals);
    return;
  }
  command.erase("layoutEpoch");
  command.erase("focusRequestId");
  if (command.value("session", std::string()) != session_id_) {
    RejectInput("wrong_session", request, event, &terminals);
    return;
  }
  if (type == "input" && command.contains("event") && command["event"].is_object()) {
    const auto event_type = command["event"].value("type", std::string());
    if ((event_type == "mouse" || event_type == "wheel" || event_type == "touch" ||
         event_type == "gesture") &&
        !hooks_.allows(command.value("view", std::string()), request_epoch)) {
      RejectInput("view_not_ready", request, event, &terminals);
      return;
    }
  }
  command["method"] = type;
  command.erase("type");
  if (type == "input") {
    const auto sequence = input_sequence.NextBrowser();
    if (!sequence) {
      RejectInput("input_sequence_exhausted", request, event, &terminals);
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
  if (command.contains("outputGeneration")) {
    command["output_generation"] = command["outputGeneration"];
    command.erase("outputGeneration");
  }
  // This connection is already bound to this Session by authenticated Control.
  // The browser validates membership and all token/sequence/output generations.
  const auto input_control = hooks_.control();
  const auto touch_sequence = ClientTouchSequence(request);
  remotekit::TouchTerminalReceipt* receipt = nullptr;
  if (!touch_sequence.empty()) {
    const auto action = request.at("event").value("action", std::string());
    if (action == "end" || action == "cancel") {
      receipt = ReserveTouchTerminal(terminals, event, request, touch_sequence, input_control);
      if (!receipt) {
        RejectInput("touch_terminal_queue_busy", request, event);
        return;
      }
    }
  }
  {
    // Only Browser's pre-admission BUSY is retryable. Keep the exact browser
    // sequence; an accepted asynchronous injection is never replayed.
    const auto deadline = QpcNow() + QpcFrequency() / 4;
    auto response =
        type == "input"
            ? remotekit::RetryBrowserInput(
                  command,
                  [&](const Json& request) {
                    return hooks_.rpc(request, input_control, 10000, 0, admitted);
                  },
                  [&] { return !stop_input && admitted() && request_epoch == hooks_.epoch(); },
                  [&] { return QpcNow() >= deadline; },
                  [] { std::this_thread::sleep_for(std::chrono::milliseconds(5)); },
                  [&] { ++input_busy_retries; }, [&] { ++input_busy_exhausted; })
            : hooks_.rpc(command, 0, 10000, 0, admitted);
    if (!response) {
      const auto& error = response.error();
      if (receipt)
        receipt->Finish("terminal-unconfirmed", false, error.message, error.code);
      else if (admitted()) {
        Json reply = {{"ok", false}, {"error", WireError(error)}};
        if (!touch_sequence.empty()) {
          reply["touchState"] = "terminal-unconfirmed";
          reply["touchSequenceId"] = touch_sequence;
        }
        ReplyInput(std::move(reply), request, event.authorization);
      }
      return;
    }
    auto reply = std::move(response).value();
    const auto invalidated = reply.value("touchState", std::string()) == "terminal-invalidated" &&
                             reply.value("touchSequenceId", std::string()) == touch_sequence;
    if (receipt && !invalidated && reply.value("touchTerminal", false) &&
        (reply.value("ok", false) || reply.value("inputAdmitted", false))) {
      if (reply.value("touchSequenceId", std::string()) == touch_sequence)
        receipt->Accept(QpcNow(), 2 * QpcFrequency());
      else
        receipt->Finish("terminal-unconfirmed", false, "touch_terminal_identity_mismatch");
      return;
    }

    if (receipt) {
      terminals.Remove(receipt);
      receipt = nullptr;
    }
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
  const auto reject = [&](const char* error) {
    // Keep a bounded spill area for terminal rejections when the normal input
    // backlog is full. The worker retains the result across SDK BUSY.
    if (input_queue.size() < 256 + remotekit::TouchTerminalReceipts::kCapacity &&
        !ClientTouchTerminal(parsed).empty()) {
      input_queue.push_back(event);
      input_queue.back().input_rejection = error;
      input_wake.notify_one();
    } else
      RejectInput(error, parsed, event);
  };
  const auto type = parsed.value("type", std::string());
  if (type != "input.touchStatus" && type != "input.touchRetire" &&
      hooks_.input_stamp() != event.authorization) {
    reject("input_not_authorized");
    return;
  }
  // Validate arrival order before move coalescing can replace a newer packet.
  // The Browser keeps its independent Session counter across RTC reconnects.
  if ((type == "input" || type == "input.touchRetire") &&
      (!parsed.contains("sequence") || !parsed["sequence"].is_string() ||
       !input_sequence.Admit(event.peer, parsed["sequence"].get<std::string>()))) {
    reject("stale_client_sequence");
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
    reject("input_queue_busy");
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
  remotekit::TouchTerminalReceipts terminals;
  while (true) {
    std::optional<Event> event;
    {
      std::unique_lock lock(input_mutex);
      const auto ready = [&] { return stop_input || !input_queue.empty(); };
      if (terminals.Busy())
        input_wake.wait_for(lock, std::chrono::milliseconds(5), ready);
      else
        input_wake.wait(lock, ready);
      if (stop_input)
        break;
      if (!input_queue.empty()) {
        event = std::move(input_queue.front());
        input_queue.pop_front();
      }
    }
    terminals.Prune([&](const auto& receipt) {
      return hooks_.peer() == receipt.peer && hooks_.current(receipt.authorization);
    });
    if (event) {
      if (event->trace_input_sequence) {
        RK_SERVER_TRACE(hooks_.trace(), "input_worker_begin", TraceIds{},
                        rk_record.peer = event->peer;
                        rk_record.client_sequence = event->trace_input_sequence;);
      }
      auto handled = DataRouter::Boundary([&]() -> Result<void> {
        HandleData(*event, terminals);
        return {};
      });
      if (!handled && hooks_.admitted(*event)) {
        ++input_rejected;
        ReplyInput({{"ok", false},
                    {"error",
                     {{"code", ErrorCodeName(handled.error().code)},
                      {"message", handled.error().message}}}},
                   event->message, event->authorization);
      }
    }
    // One due status read per input turn. A pending sequence does not hold
    // dispatch while waiting for its next query.
    if (auto* receipt = terminals.Due(QpcNow()))
      PollTouchTerminal(*receipt);
    if (terminals.HasNotices())
      FlushTouchTerminals(terminals);
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
  stop_input = true;
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
