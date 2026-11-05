#include "session/browser_rpc.hpp"
#include "media/server_trace.hpp"
#include <charconv>

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
  return {};
}
void BrowserRpc::Invalidate() {
  std::lock_guard lock(mutex_);
  if (auto handle = control_.exchange(0))
    sdk_.remotekit_sdk_control_close(handle);
}
Result<Json> BrowserRpc::Request(Json command,
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
    return Error{ErrorCode::kForbidden, "authorization_changed"};
  if (expected_control && Control() != expected_control)
    return Error{ErrorCode::kConflict, "stale_file_browser"};
  if (!Control())
    return Error{ErrorCode::kUnavailable, "browser control unavailable"};
  command["version"] = 1;
  command["id"] = ++serial_;
  const auto encoded = command.dump();
  std::vector<char> response(1024 * 1024);
  size_t count = 0;
  record("input_rpc_sdk_call");
  const int status =
      sdk_.remotekit_sdk_control_request(Control(), encoded.data(), encoded.size(), response.data(),
                                         response.size(), &count, timeout_ms);
  record("input_rpc_sdk_return", status);
  const auto failed = [&](Error error) -> Result<Json> {
    if (const auto handle = control_.exchange(0))
      sdk_.remotekit_sdk_control_close(handle);
    return error;
  };
  if (status)
    return failed(Error{media::SdkErrorCode(status, true),
                        "browser request transport SDK " + std::to_string(status)});
  if (count > response.size())
    return failed(Error{ErrorCode::kOutcomeUnknown, "browser response exceeds bound"});
  auto reply = Json::parse(response.data(), response.data() + count, nullptr, false);
  if (!reply.is_object() || !reply.contains("ok") || !reply["ok"].is_boolean())
    return failed(Error{ErrorCode::kOutcomeUnknown, "invalid browser response"});
  if (!reply["ok"].get<bool>()) {
    const auto browser_code = reply.value("code", Json());
    return Error{browser_code == 6 ? ErrorCode::kBusy : ErrorCode::kRejected,
                 "browser code=" + browser_code.dump() + " error=" +
                     (reply.contains("error") ? reply["error"].is_string()
                                                    ? reply["error"].get<std::string>()
                                                    : reply["error"].dump()
                                              : "command failed")};
  }
  return reply;
}
Result<void> BrowserRpc::OpenRender(remotekit_sdk_render_setup& setup) {
  std::lock_guard lock(mutex_);
  if (!Control())
    return Error{ErrorCode::kUnavailable, "browser control unavailable"};
  const int status =
      sdk_.remotekit_sdk_control_open_render(Control(), GetCurrentProcessId(), &setup, 15000);
  if (status)
    return Error{media::SdkErrorCode(status), "browser render setup SDK " + std::to_string(status)};
  return {};
}
}  // namespace remotekit
