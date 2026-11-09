#pragma once
#include <json.hpp>
#include "util/error.hpp"
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
    reply = dispatch();
  }
  return reply;
}

}  // namespace remotekit
