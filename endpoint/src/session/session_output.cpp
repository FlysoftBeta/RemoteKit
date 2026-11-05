#include "session/session.hpp"
namespace remotekit {
Result<void> Session::OpenOutput(bool preserve_visibility) {
  MarkConnection(ConnectionPhase::output_open_start);
  // OSR output resources require a subscribed view. With no visible output,
  // keep RTC/DataChannel alive without opening a render generation.
  // MediaLoop's resource replacement uses its existing subscription state.
  // Control may already be changing desired before PauseOutput joins us.
  if (!preserve_visibility)
    output_suspended = !has_visible_output.load();
  if (output_suspended || !peer_controller.Connected() || !authorization.Stamp())
    return {};
  remotekit_rtc_clock_sample clock{};
  clock.struct_size = sizeof(clock);
  if (!sdk.sample_clock || sdk.sample_clock(&clock) != 0 || !clock.qpc_frequency)
    return Error{ErrorCode::kUnavailable, "SDK monotonic clock mapping unavailable"};
  pool.SetClock(clock);
  if (trace)
    trace->SdkClock(clock);
  remotekit_sdk_render_setup setup{};
  setup.struct_size = sizeof(setup);
  auto result = browser.Rpc().OpenRender(setup);
  if (!result)
    return result.error();
  capture_clock_uncertainty_ms = pool.clock_uncertainty_us() / 1000;
  const auto& adapter = *streaming_adapter;
  std::string error;
  if (!pool.Open(setup, browser.Pid(), sdk, adapter.luid, adapter.device.Get(),
                 adapter.context.Get(), error))
    return Error{ErrorCode::kInvalidRequest,
                 error + " expected_adapter=" + AdapterLuid(adapter.luid) + " render_adapter=" +
                     AdapterLuid({setup.adapter_luid_low, setup.adapter_luid_high})};
  MarkConnection(ConnectionPhase::output_open_end);

  return {};
}

int Session::SendData(uint64_t handle, uint64_t stamp, const std::string& encoded) {
  const auto token = authorization.Admit();
  if (handle != token.peer || stamp != token.stamp || !authorization.Current(token))
    return 1;
  // All outboxes serialize objects. Append the active wire epoch at actual
  // admission, while the queue's local generation still owns this send.
  if (encoded.size() < 2 || encoded.front() != '{' || encoded.back() != '}')
    return 1;
  std::string wire = encoded.substr(0, encoded.size() - 1);
  if (wire.size() > 1)
    wire += ',';
  wire += "\"authEpoch\":" + std::to_string(token.epoch) + "}";
  return authorization.Current(token)
             ? sdk.remotekit_rtc_send_data(handle, wire.data(), wire.size(), 0)
             : 1;
}

void Session::Send(const Json& message, uint64_t expected_stamp) {
  const auto stamp = authorization.Stamp();
  auto handle = peer_controller.Handle();
  if (!stamp || (expected_stamp && stamp != expected_stamp) || !handle ||
      !peer_controller.DataOpen() || stamp != authorization.Frame())
    return;
  FlushControl();
  control_outbox.Transient(
      {handle, stamp}, message.dump(),
      [&](const std::string& encoded) { return SendData(handle, stamp, encoded); },
      message.value("type", std::string()) == "frame" ||
          message.value("type", std::string()) == "stats");
}

void Session::FlushControl() {
  const auto stamp = authorization.Stamp();
  const auto handle = peer_controller.Handle();
  if (!stamp || !handle || !peer_controller.DataOpen() || stamp != authorization.Frame())
    return;
  control_outbox.Flush({handle, stamp}, [&](const std::string& encoded) {
    return SendData(handle, stamp, encoded);
  });
}

void Session::FlushServices() {
  const auto stamp = authorization.Stamp();
  const auto handle = peer_controller.Handle();
  if (!stamp || !handle || !peer_controller.DataOpen() || stamp != authorization.Frame())
    return;
  // Layout and prepare always have admission priority over service replies.
  control_outbox.Transient({handle, stamp}, std::string(), [&](const std::string&) {
    direct_services.Flush(
        handle, [&](const std::string& encoded) { return SendData(handle, stamp, encoded); });
    return 0;
  });
  control_outbox.Transient({handle, stamp}, std::string(), [&](const std::string&) {
    file_services.Flush(
        handle, [&](const std::string& encoded) { return SendData(handle, stamp, encoded); });
    return 0;
  });
}

bool Session::ServiceMessage(const Event& event) {
  const auto& message = event.message;
  auto admission = authorization.LockAdmission();
  if (!ProductCurrent(event))
    return true;
  if (!remotekit::ProductActionEnvelope(message, event.bytes.size()))
    return true;
  const bool accepted =
      direct_services.Admit(event.peer, message, 1000.0 * QpcNow() / QpcFrequency());
  admission.unlock();
  if (!accepted)
    Send({{"type", "product.result"},
          {"version", 1},
          {"operationId", message["operationId"]},
          {"connectionId", peer_controller.Connection()},
          {"operationGeneration", message["operationGeneration"]},
          {"ok", false},
          {"error", "endpoint_backpressure"}},
         event.authorization);
  return true;
}

}  // namespace remotekit
