#include "rtc/data_router.hpp"
#include "input/wire_validation.hpp"
#include "util/wire_error.hpp"
#include "rtc/dc_services.hpp"
#include <charconv>
#include <cmath>
#include <cstdio>
#include <windows.h>

namespace remotekit {
Result<DataRouter::Kind> DataRouter::Classify(const Json& message) {
  if (!message.is_object() || !message.contains("type") || !message["type"].is_string())
    return Error{ErrorCode::kInvalidRequest, "invalid DataChannel envelope"};
  const auto& type = message["type"].get_ref<const std::string&>();
  if (type == "product.action")
    return Kind::kProduct;
  if (type == "media.presentation" || type == "presentation.ready")
    return Kind::kPresentation;
  if (type == "keyboard.layout") {
    const auto layout = ParseKeyboardLayout(message);
    if (!layout)
      return layout.error();
    return Kind::kInput;
  }
  if (type == "input") {
    const auto raw = message.find("event");
    if (raw != message.end() && raw->is_object() &&
        (raw->value("type", Json()) == "touch" || raw->contains("gestureMode")) &&
        raw->value("gestureMode", Json()) != "client-v1")
      return Error{ErrorCode::kInvalidRequest, "gestureMode must be client-v1"};
    if (raw != message.end() && raw->is_object()) {
      const auto valid = ValidateInputFidelity(*raw);
      if (!valid)
        return valid.error();
      const auto event_type = raw->value("type", Json());
      if (event_type == "selection_command") {
        uint64_t menu = 0;
        const auto command = raw->value("command", Json());
        if (!Number(*raw, "menu", menu) || !menu ||
            (command != "cut" && command != "copy" && command != "paste" &&
             command != "selectAll" && command != "contextMenu"))
          return Error{ErrorCode::kInvalidRequest, "invalid selection command"};
      }
      if (event_type == "context_command") {
        uint64_t menu = 0;
        const auto command = raw->value("command", Json());
        if (!Number(*raw, "menu", menu) || !menu ||
            (command != "undo" && command != "redo" && command != "cut" && command != "copy" &&
             command != "paste" && command != "selectAll" && command != "copyLinkAddress" &&
             command != "copyImage" && command != "copyImageAddress" && command != "dismiss"))
          return Error{ErrorCode::kInvalidRequest, "invalid context command"};
      }
      if (event_type == "gesture" && raw->value("action", Json()) == "longPress") {
        const auto elapsed = raw->find("sampleElapsedUs");
        const auto x = raw->find("x"), y = raw->find("y");
        const auto sequence = raw->find("sequenceId");
        if (raw->value("gestureMode", Json()) != "client-v1" || sequence == raw->end() ||
            !sequence->is_string() || sequence->get_ref<const std::string&>().empty() ||
            sequence->get_ref<const std::string&>().size() > 128 || elapsed == raw->end() ||
            !elapsed->is_number() || !std::isfinite(elapsed->get<double>()) ||
            elapsed->get<double>() < 0 || elapsed->get<double>() > 86400000000.0 ||
            std::floor(elapsed->get<double>()) != elapsed->get<double>() || x == raw->end() ||
            !x->is_number() || y == raw->end() || !y->is_number() ||
            !std::isfinite(x->get<double>()) || !std::isfinite(y->get<double>()) ||
            std::abs(x->get<double>()) > 1e7 || std::abs(y->get<double>()) > 1e7)
          return Error{ErrorCode::kInvalidRequest, "invalid long press"};
      }
    }
    return Kind::kInput;
  }
  if (type == "focus")
    return Kind::kInput;
  if (type == "files.request")
    return Kind::kFiles;
  if (type == "clock.ping")
    return Kind::kClock;
  if (type == "media.feedback")
    return Kind::kFeedback;
  if (type == "media.refresh")
    return Kind::kRefresh;
  return Error{ErrorCode::kInvalidRequest, "unknown DataChannel message type"};
}
bool DataRouter::Number(const Json& message, const char* field, uint64_t& result) {
  const auto found = message.find(field);
  if (found == message.end() || !found->is_string())
    return false;
  const auto& value = found->get_ref<const std::string&>();
  if (value.empty() || (value.size() > 1 && value[0] == '0'))
    return false;
  const auto parsed = std::from_chars(value.data(), value.data() + value.size(), result);
  return parsed.ec == std::errc{} && parsed.ptr == value.data() + value.size();
}
Result<void> DataRouter::Boundary(const std::function<Result<void>()>& fn) {
  try {
    return fn();
  } catch (const Json::exception& error) {
    fprintf(stderr, "data router invalid request: %s\n", error.what());
    return Error{ErrorCode::kInvalidRequest, "invalid DataChannel JSON"};
  } catch (const std::exception& error) {
    fprintf(stderr, "data router internal: %s\n", error.what());
    return Error{ErrorCode::kInternal, "internal DataChannel error"};
  } catch (...) {
    fprintf(stderr, "data router internal: unknown exception\n");
    return Error{ErrorCode::kInternal, "internal DataChannel error"};
  }
}
Result<void> DataRouter::Receive(RtcEvent event) {
  auto result = Boundary([&]() -> Result<void> {
    if (event.peer != hooks_.peer())
      return {};
    if (event.value != 0)
      return Error{ErrorCode::kInvalidRequest, "binary product message"};
    event.authorization = hooks_.stamp();
    event.message = Json::parse(event.bytes);
    const auto epoch = event.message.find("authEpoch");
    if (epoch == event.message.end() || !epoch->is_number_unsigned() ||
        epoch->get<uint64_t>() != hooks_.epoch())
      return {};
    auto kind = Classify(event.message);
    if (!kind)
      return kind.error();
    Number(event.message, "sequence", event.trace_input_sequence);
    if (!hooks_.current(event) && event.message.value("type", Json()) != "media.presentation")
      return {};
    hooks_.received(event);
    std::lock_guard lock(mutex_);
    if (pending_.size() >= 1024)
      return Error{ErrorCode::kBusy, "DataChannel queue busy"};
    pending_.push_back({kind.value(), std::move(event)});
    return {};
  });
  if (!result) {
    std::lock_guard lock(mutex_);
    if (pending_.size() < 1024)
      pending_.push_back({Kind::kInput, std::move(event), result.error()});
  }
  return result;
}
void DataRouter::DataState(const RtcEvent& event) {
  std::lock_guard lock(mutex_);
  if (pending_.size() < 1024)
    pending_.push_back({Kind::kDataState, event});
}
void DataRouter::Clear() {
  std::lock_guard lock(mutex_);
  pending_.clear();
}
void DataRouter::Drain() {
  std::deque<Message> pending;
  {
    std::lock_guard lock(mutex_);
    pending.swap(pending_);
  }
  for (const auto& message : pending) {
    const auto& event = message.event;
    if (event.peer != hooks_.peer())
      continue;
    auto result = Boundary([&]() -> Result<void> {
      if (message.error) {
        if (!hooks_.current(event))
          return {};
        Json reply = {{"type", "error"}, {"error", WireError(*message.error)}};
        if (event.message.is_object() && event.message.value("type", Json()) == "input") {
          reply["type"] = "input.result";
          reply["ok"] = false;
          reply["clientSequence"] = event.message.value("sequence", Json());
        }
        hooks_.send(reply, event.authorization);
        return {};
      }
      if (message.kind != Kind::kDataState &&
          event.message.value("authEpoch", Json()) != hooks_.epoch())
        return {};
      if (message.kind != Kind::kDataState && !hooks_.current(event) &&
          event.message.value("type", Json()) != "media.presentation")
        return {};
      Dispatch(message);
      return {};
    });
    if (!result)
      hooks_.send({{"type", "error"}, {"error", WireError(result.error())}}, event.authorization);
  }
}
void DataRouter::Dispatch(const Message& message) {
  const auto& event = message.event;
  switch (message.kind) {
    case Kind::kProduct:
      hooks_.product(event);
      break;
    case Kind::kPresentation:
      hooks_.presentation(event);
      break;
    case Kind::kInput:
      hooks_.input(event);
      break;
    case Kind::kFiles:
      hooks_.files(event);
      break;
    case Kind::kFeedback:
      hooks_.feedback(event);
      break;
    case Kind::kRefresh:
      hooks_.refresh(event);
      break;
    case Kind::kDataState:
      hooks_.data_state(event);
      break;
    case Kind::kClock: {
      const auto& request = event.message;
      if (event.bytes.size() > 512 || request.value("version", Json()) != 1 ||
          !request.contains("requestId") || !BoundedServiceId(request["requestId"]))
        break;
      LARGE_INTEGER before{}, after{}, frequency{};
      FILETIME utc{};
      QueryPerformanceCounter(&before);
      GetSystemTimePreciseAsFileTime(&utc);
      QueryPerformanceCounter(&after);
      QueryPerformanceFrequency(&frequency);
      ULARGE_INTEGER ticks{};
      ticks.LowPart = utc.dwLowDateTime;
      ticks.HighPart = utc.dwHighDateTime;
      hooks_.send({{"type", "clock.pong"},
                   {"version", 1},
                   {"requestId", request["requestId"]},
                   {"serverTimeMs", double(ticks.QuadPart - 116444736000000000ULL) / 10000.0},
                   {"serverMonotonicMs",
                    1000.0 * (before.QuadPart + (after.QuadPart - before.QuadPart) / 2) /
                        frequency.QuadPart}},
                  event.authorization);
      break;
    }
  }
}
}  // namespace remotekit
