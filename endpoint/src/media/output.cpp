#include "media/output.hpp"
#include "diagnostics/timing.hpp"
#include "media/encoders.hpp"
#include "media/pipeline.hpp"
#include "media/presentation.hpp"
#include "rtc/authorization.hpp"
#include "rtc/peer.hpp"
namespace remotekit {
using ConnectionPhase = ConnectionTiming::ConnectionPhase;
using Event = RtcEvent;
Result<void> OutputController::OpenOutput() {
  timing.MarkConnection(ConnectionPhase::output_open_start);
  // OSR output resources require a subscribed view. With no visible output,
  // keep RTC/DataChannel alive without opening a render generation.
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
  const auto selected = registry.Adapter();
  if (!selected)
    return Error{ErrorCode::kUnavailable, "streaming adapter unavailable"};
  const auto& adapter = *selected;
  std::string error;
  if (!pool.Open(setup, browser.Pid(), sdk, adapter.luid, adapter.device.Get(),
                 adapter.context.Get(), error))
    return Error{ErrorCode::kInvalidRequest,
                 error + " expected_adapter=" + AdapterLuid(adapter.luid) + " render_adapter=" +
                     AdapterLuid({setup.adapter_luid_low, setup.adapter_luid_high})};
  capture_clock_uncertainty_ms = pool.clock_uncertainty_us() / 1000;
  timing.MarkConnection(ConnectionPhase::output_open_end);
  return PollClipboard(true);
}

Result<bool> OutputController::PauseOutput(bool reconfiguring) {
  const bool active = peer_controller.Handle() != 0;
  pipeline.Join();
  presentation.InvalidateLayout(reconfiguring ? "reconfigure" : "output-paused");
  auto closed = Close();
  if (!closed)
    return closed.error();
  return active;
}

Result<void> OutputController::ResumeOutput(bool active) {
  if (!active)
    return {};
  {
    auto open_output_result = OpenOutput();
    if (!open_output_result)
      return open_output_result.error();
  }
  pipeline.Start();

  return {};
}
}  // namespace remotekit

namespace remotekit {

Result<void> OutputController::Configure(int width,
                                         int height,
                                         float scale,
                                         Json views,
                                         bool visible) {
  auto result =
      browser.Rpc().Request({{"method", "output.configure"},
                             {"width", width},
                             {"height", height},
                             {"device_scale", scale},
                             {"allocation_alignment", RuntimeOptions::kAtlasAllocationAlignment},
                             {"viewConfigs", std::move(views)}});
  if (!result)
    return result.error();
  has_visible_output = visible;
  return {};
}
Result<void> OutputController::Close() {
  std::optional<Error> failure;
  if (browser.Rpc().Control() && !browser.Exited()) {
    auto closed = browser.Rpc().Request({{"method", "output.close"}});
    if (!closed)
      failure = closed.error();
  }
  std::string error;
  if (!pool.Close(error) && !failure)
    failure = Error{ErrorCode::kUnavailable, error};
  if (failure && failure->code == ErrorCode::kOutcomeUnknown)
    return Error{failure->code, failure->message, ErrorReason::kBrowserRestarting};
  if (failure)
    return browser.Exited() || browser.Rpc().Disconnected()
               ? browser.Unavailable(failure->message)
               : Error{failure->code, failure->message, ErrorReason::kOutputFailed};
  return {};
}

}  // namespace remotekit
