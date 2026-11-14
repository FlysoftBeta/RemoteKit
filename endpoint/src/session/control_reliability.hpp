#pragma once
#include <json.hpp>
#include "util/error.hpp"
#include "util/retry_unit.hpp"
#include "session/browser_rpc.hpp"

namespace remotekit {
using ControlJson = nlohmann::json;
template <class Rpc, class Current, class Expired, class Wait, class Retry, class Exhausted>
Result<ControlJson> RetryBrowserInput(const ControlJson& command,
                                      Rpc rpc,
                                      Current current,
                                      Expired expired,
                                      Wait wait,
                                      Retry retry,
                                      Exhausted exhausted) {
  const auto dispatch = [&]() -> Result<ControlJson> {
    auto reply = rpc(command);
    if (reply && BrowserRpc::IsBusyBeforeAdmission(reply.value()))
      return BrowserRpc::ReplyError(reply.value());
    return reply;
  };
  auto reply = dispatch();
  RetryUnit unit{"input.admission"};
  unit.Input(command.dump());
  auto now = RetryUnit::Clock::now();
  while (!reply && reply.error().code == ErrorCode::kBusy) {
    unit.Fail(reply.error(), now);
    if (unit.Status() != RetryUnit::State::kWaiting || expired()) {
      exhausted();
      break;
    }
    if (!current())
      return Error{ErrorCode::kConflict, "input_identity_changed"};
    const auto delay = std::chrono::duration_cast<std::chrono::milliseconds>(unit.Until() - now);
    wait(delay);
    now = unit.Until();
    if (!current())
      return Error{ErrorCode::kConflict, "input_identity_changed"};
    if (expired()) {
      exhausted();
      break;
    }
    retry();
    reply = dispatch();
  }
  if (reply)
    unit.Success();
  return reply;
}

}  // namespace remotekit
