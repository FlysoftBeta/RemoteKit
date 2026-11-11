#include "util/log.hpp"
#include "session/browser_rpc.hpp"
#include "media/server_trace.hpp"
#include "protocol/control.h"
#include "util/wire_error.hpp"
#include <charconv>
#include <chrono>

namespace remotekit {
void BrowserRpc::SetTrace(std::shared_ptr<media::ServerTrace> trace, DWORD pid) {
  producer_pid_ = pid;
  trace_.store(std::move(trace));
}
Result<void> BrowserRpc::Connect(const std::string& channel) {
  std::lock_guard lock(mutex_);
  if (Control())
    return Error{ErrorCode::kConflict, "browser control already connected"};
  uint64_t handle = 0;
  const int status = sdk_.remotekit_sdk_control_connect(channel.c_str(), &handle);
  if (status)
    return Error{media::SdkErrorCode(status),
                 "browser control connect SDK " + std::to_string(status)};
  if (!handle)
    return Error{ErrorCode::kUnavailable, "browser control connect returned no handle"};
  control_ = handle;
  disconnected_ = false;
  needs_health_check_ = false;
  return {};
}
void BrowserRpc::Invalidate() {
  std::lock_guard lock(mutex_);
  if (auto handle = control_.exchange(0))
    sdk_.remotekit_sdk_control_close(handle);
  // Explicit teardown ends this connection epoch. A later process which has
  // not connected yet must not inherit proof that the previous pipe died.
  disconnected_ = false;
  needs_health_check_ = false;
}
Result<Json> BrowserRpc::Exchange(Json command,
                                  uint64_t expected_control,
                                  uint32_t timeout_ms,
                                  bool opportunistic,
                                  const std::function<bool()>& admitted) {
  const auto trace = trace_.load();
  uint64_t sequence = 0;
  if (trace && command.value("method", Json()) == "input" && command.contains("sequence") &&
      command["sequence"].is_string()) {
    const auto& value = command["sequence"].get_ref<const std::string&>();
    const auto [end, error] = std::from_chars(value.data(), value.data() + value.size(), sequence);
    if (error != std::errc{} || end != value.data() + value.size())
      sequence = 0;
  }
  const auto record = [&](const char* stage, int status = 0) {
    if (!sequence)
      return;
    RK_SERVER_TRACE(trace, stage, media::TraceIds{}, rk_record.browser_sequence = sequence;
                    rk_record.status = status; rk_record.producer_pid = producer_pid_.load(););
  };
  record("input_rpc_lock_wait");
  std::unique_lock lock(mutex_, std::defer_lock);
  if (opportunistic) {
    if (!lock.try_lock())
      return Error{ErrorCode::kBusy, "browser RPC lock busy"};
  } else
    lock.lock();
  record("input_rpc_lock_acquired");
  if (admitted && !admitted())
    return Error{ErrorCode::kConflict, "Authorization changed before Browser dispatch"};
  if (expected_control && Control() != expected_control)
    return Error{ErrorCode::kConflict, "stale_file_browser"};
  if (!Control())
    return Error{ErrorCode::kUnavailable, "browser control unavailable"};
  command["version"] = 1;
  // Browser session numbers are scoped to a single Browser process.
  if (command.contains("session"))
    command["session"] = "1";
  if (command.contains("viewConfigs") && command["viewConfigs"].is_array())
    for (auto& view : command["viewConfigs"])
      view["session"] = "1";
  command["id"] = ++serial_;
  const auto encoded = command.dump();
  const bool clipboard = command.value("method", std::string()).starts_with("clipboard.");
  std::vector<char> response(clipboard ? 32 * 1024 * 1024 : 1024 * 1024);
  size_t count = 0;
  record("input_rpc_sdk_call");
  const auto started = std::chrono::steady_clock::now();
  const int status =
      sdk_.remotekit_sdk_control_request(Control(), encoded.data(), encoded.size(), response.data(),
                                         response.size(), &count, timeout_ms);
  record("input_rpc_sdk_return", status);
  const auto failed = [&](Error error) -> Result<Json> {
    if (status == REMOTEKIT_SDK_CHANNEL_CLOSED || status == REMOTEKIT_SDK_LOST ||
        status == REMOTEKIT_SDK_MOJO_ERROR) {
      disconnected_ = true;
      if (const auto handle = control_.exchange(0))
        sdk_.remotekit_sdk_control_close(handle);
    }
    LogError(LogLevel::kWarn, "browser.rpc_failed", error,
             {{"method", command.value("method", std::string())},
              {"requestId", serial_},
              {"elapsedMs", std::chrono::duration_cast<std::chrono::milliseconds>(
                                std::chrono::steady_clock::now() - started)
                                .count()},
              {"sdkStatus", status},
              {"control", Control()}});
    return error;
  };
  if (status) {
    needs_health_check_ = true;
    return failed(Error{media::SdkErrorCode(status),
                        "browser request transport SDK " + std::to_string(status),
                        status == REMOTEKIT_SDK_CHANNEL_CLOSED
                            ? std::optional<ErrorReason>(ErrorReason::kBrowserRestarting)
                            : std::nullopt});
  }
  if (count > response.size())
    return failed(Error{ErrorCode::kOutcomeUnknown, "browser response exceeds bound"});
  auto reply = Json::parse(response.data(), response.data() + count, nullptr, false);
  if (!reply.is_object() || !reply.contains("ok") || !reply["ok"].is_boolean())
    return failed(Error{ErrorCode::kOutcomeUnknown, "invalid browser response"});
  needs_health_check_ = false;
  return reply;
}
Result<Json> BrowserRpc::Request(Json command,
                                 uint64_t expected_control,
                                 uint32_t timeout_ms,
                                 bool opportunistic,
                                 const std::function<bool()>& admitted) {
  const bool credentials = command.contains("username") || command.contains("password");
  auto reply = Exchange(std::move(command), expected_control, timeout_ms, opportunistic, admitted);
  if (!reply)
    return reply;
  if (credentials) {
    if (!reply.value().value("ok", false))
      return ReplyError(reply.value());
    return Json{{"ok", true}};
  }
  return CheckReply(std::move(reply).value());
}
Error BrowserRpc::ReplyError(const Json& reply) {
  const auto error = reply.find("error");
  return ParseWireError(error == reply.end() ? Json() : *error);
}
Result<Json> BrowserRpc::CheckReply(Json reply) {
  if (reply.value("ok", false))
    return reply;
  return ReplyError(reply);
}
bool BrowserRpc::IsBusyBeforeAdmission(const Json& reply) {
  return !reply.value("ok", false) && ReplyError(reply).code == ErrorCode::kBusy &&
         !reply.value("inputAdmitted", false);
}
Result<void> BrowserRpc::OpenRender(remotekit_sdk_render_setup& setup) {
  std::unique_lock lock(mutex_);
  if (!Control())
    return Error{ErrorCode::kUnavailable, "browser control unavailable"};
  const auto started = std::chrono::steady_clock::now();
  remotekit_sdk_failure failure{};
  const int status = sdk_.remotekit_sdk_control_open_render(Control(), GetCurrentProcessId(),
                                                            &setup, 15000, &failure);
  if (status) {
    if (status == REMOTEKIT_SDK_CHANNEL_CLOSED || status == REMOTEKIT_SDK_LOST ||
        status == REMOTEKIT_SDK_MOJO_ERROR) {
      disconnected_ = true;
      if (const auto handle = control_.exchange(0))
        sdk_.remotekit_sdk_control_close(handle);
    }
    needs_health_check_ = true;
    LogError(LogLevel::kWarn, "browser.rpc_failed", media::SdkFailure(status, failure),
             {{"method", "output.open"},
              {"elapsedMs", std::chrono::duration_cast<std::chrono::milliseconds>(
                                std::chrono::steady_clock::now() - started)
                                .count()},
              {"sdkStatus", status},
              {"control", Control()}});
    return media::SdkFailure(status, failure);
  }
  return {};
}
}  // namespace remotekit
