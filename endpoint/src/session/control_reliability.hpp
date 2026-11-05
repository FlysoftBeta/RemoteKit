#pragma once
#include <json.hpp>
#include "util/error.hpp"
#include "util/wire_error.hpp"
#include <array>
#include <algorithm>
#include <deque>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

namespace remotekit {
using ControlJson = nlohmann::json;
inline ErrorCode InputRejectionCode(std::string_view message) {
  if (message == "input_queue_busy" || message == "touch_terminal_queue_busy")
    return ErrorCode::kBusy;
  if (message == "input_not_authorized" || message == "wrong_session")
    return ErrorCode::kForbidden;
  if (message == "invalid_touch_retirement_identity")
    return ErrorCode::kInvalidRequest;
  if (message == "input_sequence_exhausted")
    return ErrorCode::kLimitExceeded;
  return ErrorCode::kConflict;
}
template <class Rpc, class Current, class Expired, class Wait, class Retry, class Exhausted>
Result<ControlJson> RetryBrowserInput(const ControlJson& command,
                                      Rpc rpc,
                                      Current current,
                                      Expired expired,
                                      Wait wait,
                                      Retry retry,
                                      Exhausted exhausted) {
  auto reply = rpc(command);
  unsigned retries = 0;
  while (!reply && reply.error().code == ErrorCode::kBusy) {
    if (retries >= 50 || expired()) {
      exhausted();
      break;
    }
    if (!current())
      return Error{ErrorCode::kConflict, "input_identity_changed"};
    wait();
    if (!current())
      return Error{ErrorCode::kConflict, "input_identity_changed"};
    if (expired()) {
      exhausted();
      break;
    }
    ++retries;
    retry();
    reply = rpc(command);
  }
  return reply;
}

// Owned by the input worker. Admission reserves space for both the acceptance
// and final notice. Unsent notices and active queries cannot be evicted.
struct TouchTerminalReceipt {
  uint64_t peer{}, authorization{}, control{};
  std::string client_sequence, sequence;
  ControlJson query, acceptance, result;
  bool send_acceptance{}, send_result{}, polling{};
  int64_t due{}, deadline{};

  ControlJson Notice(const char* state,
                     bool ok,
                     const std::string& error = {},
                     ErrorCode code = ErrorCode::kOutcomeUnknown) const {
    ControlJson reply = {{"type", "input.result"},
                         {"clientSequence", client_sequence},
                         {"touchSequenceId", sequence},
                         {"touchState", state},
                         {"ok", ok}};
    if (!ok)
      reply["error"] = WireError({code, error});
    return reply;
  }
  void Accept(int64_t now, int64_t budget) {
    acceptance = Notice("accepted-pending", true);
    send_acceptance = true;
    Schedule(now, budget);
  }
  void Schedule(int64_t now, int64_t budget) {
    polling = true;
    due = now;
    deadline = now + budget;
  }
  void Finish(const char* state,
              bool ok,
              const std::string& error = {},
              ErrorCode code = ErrorCode::kOutcomeUnknown) {
    polling = false;
    result = Notice(state, ok, error, code);
    send_result = true;
  }
  bool Busy() const { return polling || send_acceptance || send_result; }
};

inline bool ApplyTouchTerminalStatus(TouchTerminalReceipt& receipt, const ControlJson& status) {
  if (status.value("sequenceId", std::string()) != receipt.sequence) {
    receipt.Finish("terminal-unconfirmed", false, "touch_terminal_identity_mismatch");
    return true;
  }
  const auto state = status.value("state", std::string());
  if (state == "pending")
    return false;
  if (state == "processed" && status.value("ok", false))
    receipt.Finish("processed", true);
  else if (state == "terminal-invalidated")
    receipt.Finish("terminal-invalidated", false,
                   status.value("error", std::string("touch_owner_invalidated")),
                   ErrorCode::kConflict);
  else
    receipt.Finish("terminal-unconfirmed", false,
                   status.value("error", std::string("touch_terminal_unconfirmed")));
  return true;
}

class TouchTerminalReceipts {
 public:
  static constexpr size_t kCapacity = 64;
  TouchTerminalReceipt* Reserve(TouchTerminalReceipt value) {
    if (records_.size() == kCapacity) {
      auto settled = std::find_if(records_.begin(), records_.end(),
                                  [](const auto& item) { return !item.Busy(); });
      if (settled == records_.end())
        return nullptr;
      records_.erase(settled);
    }
    records_.push_back(std::move(value));
    return &records_.back();
  }
  void Remove(TouchTerminalReceipt* value) {
    std::erase_if(records_, [&](const auto& item) { return &item == value; });
  }
  template <class Current>
  void Prune(Current current) {
    std::erase_if(records_, [&](const auto& item) { return !current(item); });
  }
  TouchTerminalReceipt* Find(uint64_t peer,
                             uint64_t authorization,
                             const std::string& client_sequence,
                             const std::string& sequence) {
    for (auto& item : records_)
      if (item.peer == peer && item.authorization == authorization &&
          item.client_sequence == client_sequence && item.sequence == sequence)
        return &item;
    return nullptr;
  }
  TouchTerminalReceipt* Due(int64_t now) {
    TouchTerminalReceipt* next = nullptr;
    for (auto& item : records_)
      if (item.polling && item.due <= now && (!next || item.due < next->due))
        next = &item;
    return next;
  }
  bool Busy() const {
    return std::any_of(records_.begin(), records_.end(),
                       [](const auto& item) { return item.Busy(); });
  }
  bool HasNotices() const {
    return std::any_of(records_.begin(), records_.end(),
                       [](const auto& item) { return item.send_acceptance || item.send_result; });
  }
  template <class Send>
  void Flush(Send send) {
    unsigned sent = 0;
    for (auto& item : records_) {
      if (item.send_acceptance) {
        if (sent == 4 || !send(item, item.acceptance))
          return;
        ++sent;
        item.send_acceptance = false;
      }
      if (item.send_result) {
        if (sent == 4 || !send(item, item.result))
          return;
        ++sent;
        item.send_result = false;
      }
    }
  }

 private:
  std::deque<TouchTerminalReceipt> records_;
};

// Only the latest layout transaction is retained (at most mode/layout/prepare).
// Serialize replacement and actual admission so an old prepare can never be
// admitted after a newer layout. BUSY leaves the head in place for the next tick.
}  // namespace remotekit
