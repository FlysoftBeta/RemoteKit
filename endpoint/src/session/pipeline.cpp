#include "session/pipeline.hpp"
#include "diagnostics/stats.hpp"
#include "diagnostics/timing.hpp"
#include "media/comp_recovery.hpp"
#include "media/idle_keepalive.hpp"
#include "media/render_slots.hpp"
#include "rtc/authorization.hpp"
#include "rtc/peer.hpp"
#include "session/encoders.hpp"
#include "session/output.hpp"
#include "session/presentation.hpp"
#include "util/log.hpp"
namespace remotekit {
RetryUnit::Snapshot MediaPipeline::ClipboardRetryStatus() const {
  std::lock_guard lock(clipboard_retry_mutex_);
  return clipboard_retry_;
}
void MediaPipeline::PollClipboard() {
  std::lock_guard lock(clipboard_retry_mutex_);
  clipboard_retry_.Input(browser.Incarnation() + ":" + std::to_string(authorization.Stamp()));
  if (!clipboard_retry_.Ready())
    return;
  auto result = output.PollClipboard();
  if (!result)
    clipboard_retry_.Fail(result.error());
  else
    clipboard_retry_.Success();
}
using ConnectionPhase = ConnectionTiming::ConnectionPhase;
using Event = RtcEvent;
MediaPipeline::MediaPipeline(ControllerContext context,
                             PeerController& peer_controller,
                             AuthorizationController& authorization,
                             PresentationController& presentation,
                             OutputController& output,
                             EncoderRegistry& registry,
                             ConnectionTiming& timing,
                             Diagnostics& diagnostics)
    : ControllerContext(context),
      peer_controller(peer_controller),
      authorization(authorization),
      presentation(presentation),
      output(output),
      registry(registry),
      timing(timing),
      diagnostics(diagnostics),
      engine(context.sdk,
             output.Slots(),
             registry,
             context.trace,
             {context.options.idle_idr_ms, context.options.max_encode_width,
              context.options.max_encode_height}) {}
media::CompHost::Layout MediaPipeline::ObserveLayout(const SharedAtlasFrame& metadata) {
  auto next = presentation.Layout(metadata);
  const auto epoch = presentation.ObserveLayout(metadata);
  next["epoch"] = std::to_string(epoch);
  if (next != presentation.Snapshot()) {
    has_current_view = std::ranges::any_of(
        next.at("views"), [](const auto& view) { return !view.value("stale", false); });
    presentation.PublishLayout(std::move(next), epoch);
  }
  return {epoch, has_current_view};
}
std::optional<PresentationBarrier::Key> MediaPipeline::RefreshKey(uint64_t peer) {
  return presentation.RefreshKey(peer, presentation.Epoch());
}
void MediaPipeline::Invalidate(const char* reason) {
  if (!presentation.IsInvalid(reason))
    presentation.InvalidateLayout(reason);
}
void MediaPipeline::Reached(Milestone milestone) {
  timing.MarkConnection(milestone == Milestone::source_frame ? ConnectionPhase::source_frame
                                                             : ConnectionPhase::submit);
}
bool MediaPipeline::CanBegin() {
  return state == State::kRunning && !output.Suspended() && peer_controller.Connected();
}
bool MediaPipeline::Current(uint64_t scope) {
  return authorization.Current(scope);
}
void MediaPipeline::Failed(media::CompFailure failure) {
  auto& error = failure.error;
  const std::string_view reason = failure.invalidation;
  if (reason == "fatal") {
    auto status = browser.Rpc().Request({{"method", "output.status"}}, 0, 1000);
    if (status && status.value().contains("output")) {
      const auto& description = status.value()["output"];
      if (!description.value("error", std::string()).empty())
        error.message = description.value("message", description["error"].get<std::string>());
    }
    presentation.InvalidateLayout(failure.invalidation);
    auto closed = output.Close();
    if (!closed)
      LogError(LogLevel::kWarn, "output.stop_failed", closed.error(), {{"sessionId", id}});
    registry.SetError(error.message);
    LogError(LogLevel::kWarn, "media.failed", error, {{"sessionId", id}});
    return;
  }
  if (!reason.empty() && reason != "render-begin-failed" && reason != "codec-capability-error")
    presentation.InvalidateLayout(failure.invalidation);
  registry.SetError(error.message);
  if (reason == "render-begin-failed" || reason == "codec-capability-error")
    presentation.InvalidateLayout(failure.invalidation);
  if (reason == "codec-capability-error") {
    LogError(LogLevel::kWarn, "media.failed", error, {{"sessionId", id}});
    auto closed = output.Close();
    if (!closed)
      LogError(LogLevel::kWarn, "output.stop_failed", closed.error());
  }
}
void MediaPipeline::MediaLoop() {
  struct RenderExit {
    MediaPipeline& owner;
    ~RenderExit() {
      owner.engine.StopGeneration();
      std::string error;
      if (!owner.output.Slots().Close(error))
        LogError(LogLevel::kWarn, "media.render_drain_failed", Error{ErrorCode::kInternal, error});
    }
  } render_exit{*this};
  has_current_view = false;
  auto started = engine.StartGeneration();
  if (started) {
    Failed(std::move(*started));
    return;
  }
  int64_t last_stats = QpcNow();
  uint64_t previous_encoded = registry.Completed(), previous_bytes = registry.Bytes();
  uint64_t previous_delivered = output.Slots().delivered_frames();
  uint64_t active_authorization = authorization.Stamp();
  authorization.SetFrame(active_authorization);
  auto stream = [&] {
    return media::CompStream{peer_controller.Connected() ? peer_controller.Handle() : 0,
                             peer_controller.ReceiveLevel(),
                             authorization.Current(active_authorization) ? active_authorization : 0,
                             !output.Suspended()};
  };
  while (state == State::kRunning) {
    PollClipboard();
    const auto stamp = authorization.Stamp();
    if (stamp != active_authorization) {
      authorization.SetFrame(0);
      engine.ResetStream();
      has_current_view = false;
      presentation.InvalidateLayout(stamp ? "authorization-resuming" : "authorization-locked");
      if (peer_controller.Connected()) {
        {
          if (output.Slots().EventHandle()) {
            {
              auto output_close_result = output.Close();
              if (!output_close_result) {
                const Error error = output_close_result.error();
                LogError(LogLevel::kWarn, "authorization.output_failed", error);
                return;
              }
            }
            std::string drain_error;
            if (!output.Slots().Close(drain_error)) {
              Error error{ErrorCode::kOutcomeUnknown, drain_error};
              LogError(LogLevel::kWarn, "authorization.output_failed", error);
              return;
            };
          }
          if (stamp && authorization.Current(stamp)) {
            auto open_output_result = output.OpenOutput();
            if (!open_output_result) {
              const Error error = open_output_result.error();
              LogError(LogLevel::kWarn, "authorization.output_failed", error);
              return;
            }
          }
        }
      }
      active_authorization = stamp;
      authorization.SetFrame(stamp);
      if (stamp)
        engine.RequestRefresh();
    }
    auto cadence = engine.UpdateCadence(stream());
    if (cadence) {
      Failed(std::move(*cadence));
      break;
    }
    std::deque<Event> incoming;
    {
      std::lock_guard lock(event_mutex);
      incoming.swap(events);
    }
    for (auto& event : incoming) {
      if (event.peer != peer_controller.Handle())
        continue;
      if (event.type == REMOTEKIT_RTC_REFRESH_REQUEST) {
        engine.RequestRefresh();
      } else if (event.type == REMOTEKIT_RTC_STATE) {
        const bool connected = event.value == 2;
        if (event.connection_changed) {
          engine.ResetStream();
          has_current_view = false;
          presentation.InvalidateLayout(connected ? "rtc-resuming" : "rtc-disconnected");
          {
            if (connected) {
              if (authorization.Current(active_authorization)) {
                auto open_output_result_2 = output.OpenOutput();
                if (!open_output_result_2) {
                  const Error failure = open_output_result_2.error();
                  {
                    registry.SetError(failure.message.c_str());
                  }
                  presentation.InvalidateLayout("rtc-output-error");
                  {
                    auto closed = output.Close();
                    if (!closed)
                      LogError(LogLevel::kWarn, "output.close_failed", closed.error());
                  }

                  LogError(LogLevel::kWarn, "rtc.output_failed", failure, {{"sessionId", id}});
                  return;
                }
              }
              engine.RequestRefresh();
            } else {
              {
                auto output_close_result_2 = output.Close();
                if (!output_close_result_2) {
                  const Error failure = output_close_result_2.error();
                  {
                    registry.SetError(failure.message.c_str());
                  }
                  presentation.InvalidateLayout("rtc-output-error");
                  {
                    auto closed = output.Close();
                    if (!closed)
                      LogError(LogLevel::kWarn, "output.close_failed", closed.error());
                  }

                  LogError(LogLevel::kWarn, "rtc.output_failed", failure, {{"sessionId", id}});
                  return;
                }
              }
              std::string drain_error;
              if (!output.Slots().Close(drain_error))
                LogError(LogLevel::kWarn, "media.render_drain_failed",
                         Error{ErrorCode::kInternal, drain_error});
            }
          }
        }
      } else if (event.type == REMOTEKIT_RTC_ERROR)
        LogEvent(LogLevel::kDebug, "rtc.event", {{"sessionId", id}, {"detail", event.bytes}});
    }
    if (!peer_controller.Connected() || !authorization.Current(active_authorization)) {
      output.Slots().WithdrawAdmission();
      std::unique_lock lock(event_mutex);
      event_wake.wait_for(lock, std::chrono::milliseconds(20),
                          [&] { return state != State::kRunning || !events.empty(); });
      continue;
    }
    const auto current = stream();
    auto stepped = engine.Step(current, *this);
    if (stepped) {
      Failed(std::move(*stepped));
      break;
    }
    const auto handle = current.peer;
    const auto now = engine.Diagnostics().iteration_qpc;
    if (now - last_stats >= QpcFrequency()) {
      if (trace)
        trace->WallClock();
      if (handle && sdk.request_stats)
        sdk.request_stats(handle);
      auto report = diagnostics.Stats();
      report["type"] = "stats";
      const double seconds = static_cast<double>(now - last_stats) / QpcFrequency();
      const auto encoded = registry.Completed(), bytes = registry.Bytes();
      report["encodedFps"] = (encoded - previous_encoded) / seconds;
      report["encodedBitrateBps"] = 8.0 * (bytes - previous_bytes) / seconds;
      const auto delivered = output.Slots().delivered_frames();
      report["atlasDeliveredFrames"] = delivered;
      report["atlasDeliveredFps"] = (delivered - previous_delivered) / seconds;
      previous_delivered = delivered;
      previous_encoded = encoded;
      previous_bytes = bytes;
      const auto current_metadata =
          output.Suspended() ? SharedAtlasFrame{} : output.Slots().LatestMetadata();
      report["sourceAtlasWidth"] = current_metadata.width_pixels;
      report["sourceAtlasHeight"] = current_metadata.height_pixels;
      report["mediaScale"] = Sampling().scale;
      report["negotiatedReceiveLevel"] = peer_controller.ReceiveLevel();
      report["samplingFpsBudget"] = SamplingFps();
      report["resolutionLimitation"] = Sampling().limitation;
      report["samplingMaxFrameMacroblocks"] = Sampling().max_frame_macroblocks;
      report["samplingMaxMacroblocksPerSecond"] = Sampling().max_macroblocks_per_second;
      const auto latency = output.Slots().capture_to_ready_ms();
      report["captureToReadyMs"] = latency ? Json(*latency) : Json(nullptr);
      report["captureClock"] = latency ? "measured SDK TimeTicks to QPC mapping" : "unavailable";
      report["clockUncertaintyUs"] = output.Slots().clock_uncertainty_us();
      diagnostics.Publish(std::move(report));
      last_stats = now;
    }
    auto waited = engine.Wait(current);
    if (waited) {
      Failed(std::move(*waited));
      break;
    }
  }
}
uint32_t MediaPipeline::SamplingFps() const {
  return engine.Diagnostics().sampling_fps;
}

Result<Json> MediaPipeline::ApplyMediaPolicy(const Json& request) {
  if (!request.contains("audio") || !request.at("audio").is_boolean())
    return Error{ErrorCode::kInvalidRequest, "invalid media policy audio"};
  const bool audio = request.at("audio").get<bool>();
  if (!request.contains("maxFps"))
    return Error{ErrorCode::kInvalidRequest, "invalid media policy maxFps"};
  const auto& value = request.at("maxFps");
  if (!value.is_number_integer() || value.get<int64_t>() < 1 || value.get<int64_t>() > 240)
    return Error{ErrorCode::kInvalidRequest, "invalid media policy maxFps"};
  const auto preference = Required(request, "degradationPreference");
  uint32_t degradation;
  if (preference == "maintain-resolution")
    degradation = REMOTEKIT_RTC_MAINTAIN_RESOLUTION;
  else if (preference == "balanced")
    degradation = REMOTEKIT_RTC_BALANCED;
  else if (preference == "maintain-framerate")
    degradation = REMOTEKIT_RTC_MAINTAIN_FRAMERATE;
  else
    return Error{ErrorCode::kInvalidRequest, "invalid degradation preference"};
  {
    std::lock_guard lock(media_policy_mutex);
    auto applied = peer_controller.Policy(value.get<uint32_t>(), degradation, audio);
    if (!applied)
      return applied.error();
    engine.SetPolicy(value.get<uint32_t>(), degradation);
    policy_audio = audio;
    requested_media_policy = {
        {"audio", audio}, {"maxFps", value.get<uint32_t>()}, {"degradationPreference", preference}};
  }
  event_wake.notify_one();
  return Json{{"accepted", true}, {"applied", peer_controller.Handle() != 0}};
}
}  // namespace remotekit

namespace remotekit {

void MediaPipeline::Start() {
  if (media_thread.joinable())
    return;
  state = State::kRunning;
  media_thread = std::thread([this] {
    RunThread(
        "media",
        [this] {
          MediaLoop();
          if (state == State::kRunning) {
            state = State::kFailed;
            peer_controller.Failed();
          }
        },
        [this] {
          state = State::kFailed;
          peer_controller.Failed();
        });
  });
}
bool MediaPipeline::Join() {
  const bool running = media_thread.joinable();
  state = State::kStopping;
  Wake();
  if (running)
    media_thread.join();
  state = State::kStopped;
  return running;
}
void MediaPipeline::Wake() {
  engine.Wake();
  event_wake.notify_all();
}
void MediaPipeline::InputReceived(int64_t qpc) {
  engine.InputReceived(qpc);
  Wake();
}
void MediaPipeline::Queue(const RtcEvent& event) {
  {
    std::lock_guard lock(event_mutex);
    if (events.size() < 1024)
      events.push_back(event);
  }
  Wake();
}
void MediaPipeline::Refresh() {
  engine.RequestRefresh();
  Wake();
}
void MediaPipeline::RequestRefresh(const RtcEvent& event) {
  if (event.bytes.size() > 256)
    return;
  const auto now = QpcNow();
  auto previous = last_media_refresh_qpc.load();
  if ((!previous || now - previous >= QpcFrequency()) &&
      last_media_refresh_qpc.compare_exchange_strong(previous, now))
    Refresh();
}
void MediaPipeline::Rates(uint32_t bitrate, uint32_t fps) {
  engine.Rates(bitrate, fps);
  Wake();
}
void MediaPipeline::Reset() {
  std::lock_guard lock(event_mutex);
  events.clear();
  last_media_refresh_qpc = 0;
  engine.ResetInputs();
}
MediaSampling MediaPipeline::Sampling() const {
  return engine.Diagnostics().sampling;
}
Json MediaPipeline::Snapshot() {
  Json requested;
  {
    std::lock_guard lock(media_policy_mutex);
    requested = requested_media_policy;
  }
  const auto core = engine.Diagnostics();
  const auto degradation = core.degradation;
  const char* preference = degradation == REMOTEKIT_RTC_MAINTAIN_RESOLUTION  ? "maintain-resolution"
                           : degradation == REMOTEKIT_RTC_MAINTAIN_FRAMERATE ? "maintain-framerate"
                                                                             : "balanced";
  return {{"mediaPolicy",
           {{"requested", requested},
            {"applied", peer_controller.Handle() ? Json{{"audio", policy_audio.load()},
                                                        {"maxFps", core.max_fps},
                                                        {"degradationPreference", preference}}
                                                 : Json(nullptr)}}},
          {"effective_idle_ms", core.effective_idle_ms},
          {"tail_submissions", core.tail_submissions},
          {"tail_completions", core.tail_completions},
          {"source_interval_ms", core.source_interval_ms},
          {"last_tail_age_ms", core.last_tail_age_ms}};
}

}  // namespace remotekit
