#include "util/log.hpp"
#include "media/pipeline.hpp"
#include "diagnostics/stats.hpp"
#include "diagnostics/timing.hpp"
#include "media/encoders.hpp"
#include "media/comp_recovery.hpp"
#include "media/output.hpp"
#include "media/presentation.hpp"
#include "media/render_slots.hpp"
#include "rtc/authorization.hpp"
#include "rtc/peer.hpp"
namespace remotekit {
using ConnectionPhase = ConnectionTiming::ConnectionPhase;
using Event = RtcEvent;
void MediaPipeline::MediaLoop() {
  std::shared_ptr<remotekit::TailIdrAttempt> tail_attempt;
  // All exits, including early return and source/Begin failure, stop this
  // generation. Block-local locks unwind before this function-scope guard.
  struct RenderExit {
    MediaPipeline& owner;
    std::shared_ptr<remotekit::TailIdrAttempt>& tail;
    ~RenderExit() {
      if (tail)
        tail->CancelWaiting();
      std::string error;
      if (!owner.output.Slots().Close(error))
        LogError(LogLevel::kWarn, "media.render_drain_failed", Error{ErrorCode::kInternal, error});
    }
  } render_exit{*this, tail_attempt};
  remotekit::PresentationRefresh presentation_refresh;
  struct TargetReset {
    std::mutex& mutex;
    CompDiagnostics& value;
    ~TargetReset() {
      std::lock_guard lock(mutex);
      value.targetFps = 0;
      value.refresh.pending = false;
    }
  } target_reset{comp_diagnostics_mutex, comp_diagnostics};
  HANDLE pace_timer =
      CreateWaitableTimerExW(nullptr, nullptr, 0x2, TIMER_MODIFY_STATE | SYNCHRONIZE);
  if (!pace_timer) {
    presentation.InvalidateLayout("comp-timer-unavailable");
    registry.SetError("high resolution Comp timer unavailable");
    return;
  }
  struct TimerCloser {
    HANDLE value;
    ~TimerCloser() { CloseHandle(value); }
  } timer_closer{pace_timer};
  uint64_t observed_wakes = output.Slots().Stats().wakes;
  remotekit::CompBeginSchedule begin_schedule;
  auto observe_wake = [&] {
    const auto wakes = output.Slots().Stats().wakes;
    if (wakes != observed_wakes) {
      observed_wakes = wakes;
      begin_schedule.Wake();
    }
  };
  int64_t last_stats = QpcNow();
  uint32_t official_max_fps = 240, codec_max_fps = 240;
  remotekit::CompCadence cadence;
  remotekit::CompRecoverySampling recovery;
  uint64_t previous_encoded = registry.Completed(), previous_bytes = registry.Bytes();
  uint64_t previous_delivered = output.Slots().delivered_frames();
  remotekit::IdleIdrPolicy idle(options.idle_idr_ms);
  bool has_current_view = false;

  bool first_source = true, first_submit = true;
  double next_tail_attempt_ms = 0;
  uint32_t tail_begins = 0;
  constexpr double tail_retry_ms = 250;
  effective_idle_ms = idle.delay_ms();
  source_interval_ms = 0;
  uint64_t active_authorization = authorization.Stamp();
  authorization.SetFrame(active_authorization);
  auto update_refresh = [&](uint64_t handle, double now_ms) {
    std::optional<remotekit::PresentationRefresh::Scope> scope;
    if (has_current_view && !output.Suspended() && authorization.Current(active_authorization)) {
      if (auto key = presentation.RefreshKey(handle, presentation.Epoch()))
        scope = remotekit::PresentationRefresh::Scope{handle, active_authorization, *key};
    }
    presentation_refresh.SetScope(scope);
    if (scope)
      presentation_refresh.Update(refresh_connected.exchange(false), now_ms);
  };
  while (state == State::kRunning) {
    auto clipboard_result = output.PollClipboard();
    if (!clipboard_result)
      LogEvent(LogLevel::kWarn, "clipboard.sync_failed");
    const auto stamp = authorization.Stamp();
    if (stamp != active_authorization) {
      authorization.SetFrame(0);
      if (tail_attempt)
        tail_attempt->CancelWaiting();
      tail_attempt.reset();
      presentation_refresh.SetScope(std::nullopt);
      has_current_view = false;
      next_tail_attempt_ms = 0;
      begin_schedule.Reset();
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
        refresh_connected = true;
    }
    if (begin_schedule.Due(QpcNow())) {
      if (peer_controller.Connected() && authorization.Current(active_authorization) &&
          !output.Suspended()) {
        remotekit_rtc_source_restrictions restrictions{};
        restrictions.struct_size = sizeof(restrictions);
        const int status =
            sdk.remotekit_rtc_get_source_restrictions(peer_controller.Handle(), &restrictions);
        if (status != REMOTEKIT_SDK_OK) {
          registry.SetError("RTC source restrictions failed " + std::to_string(status));
          break;
        }
        const auto native = output.Slots().LatestMetadata();
        recovery.Update(policy_degradation.load() == REMOTEKIT_RTC_BALANCED,
                        uint64_t{native.width_pixels} * native.height_pixels,
                        restrictions.target_pixels);
        official_max_fps = restrictions.max_fps ? restrictions.max_fps : 240;
      } else {
        recovery.Update(false, 0, 0);
      }
    }
    sampling_fps =
        cadence.Update(comp_bitrate.load(), comp_fps.load(), policy_max_fps.load(),
                       std::min(official_max_fps, codec_max_fps), output.Slots().HasCapacity(),
                       static_cast<int64_t>(1000000.0 * QpcNow() / QpcFrequency()));
    {
      std::lock_guard lock(comp_diagnostics_mutex);
      comp_diagnostics.targetFps = peer_controller.Connected() &&
                                           authorization.Current(active_authorization) &&
                                           !output.Suspended()
                                       ? sampling_fps
                                       : 0;
      comp_diagnostics.officialMaxFps = official_max_fps;
      comp_diagnostics.codecMaxFps = codec_max_fps;
      comp_diagnostics.resumeMaxFps =
          std::min({policy_max_fps.load(), official_max_fps, codec_max_fps});
      comp_diagnostics.refresh = presentation_refresh.Snapshot();
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
        refresh_connected = true;
      } else if (event.type == REMOTEKIT_RTC_STATE) {
        const bool connected = event.value == 2;
        if (event.connection_changed) {
          if (tail_attempt)
            tail_attempt->CancelWaiting();
          tail_attempt.reset();
          presentation_refresh.SetScope(std::nullopt);
          has_current_view = false;
          next_tail_attempt_ms = 0;
          begin_schedule.Reset();
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
              refresh_connected = true;
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
      std::unique_lock lock(event_mutex);
      event_wake.wait_for(lock, std::chrono::milliseconds(20),
                          [&] { return state != State::kRunning || !events.empty(); });
      continue;
    }
    remotekit_rtc_frame frame{};
    remotekit::SharedAtlasFrame metadata{};
    std::string error;
    auto result = output.Suspended() ? RenderSlots::Result::idle
                                     : output.Slots().Poll(frame, metadata, error);
    observe_wake();
    if (first_source && result == RenderSlots::Result::ready) {
      timing.MarkConnection(ConnectionPhase::source_frame);
      first_source = false;
    }
    if (result == RenderSlots::Result::error) {
      auto status = browser.Rpc().Request({{"method", "output.status"}}, 0, 1000);
      if (status && status.value().contains("output")) {
        const auto& description = status.value()["output"];
        if (!description.value("error", std::string()).empty())
          error = description.value("message", description["error"].get<std::string>());
      }
      presentation.InvalidateLayout("fatal");
      {
        {
          auto output_close_result_3 = output.Close();
          if (!output_close_result_3) {
            const Error close_error = output_close_result_3.error();
            LogError(LogLevel::kWarn, "output.stop_failed", close_error, {{"sessionId", id}});
          }
        }
      }

      {
        registry.SetError(error);
      }
      LogError(LogLevel::kWarn, "media.failed", Error{ErrorCode::kInternal, error},
               {{"sessionId", id}});
      break;
    }
    if (output.Suspended()) {
      if (!presentation.IsInvalid("no-visible-views"))
        presentation.InvalidateLayout("no-visible-views");
    }
    const auto handle = peer_controller.Handle();
    const auto now = QpcNow();
    const double now_ms = 1000.0 * now / QpcFrequency();
    update_refresh(handle, now_ms);
    if (tail_attempt) {
      using State = remotekit::TailIdrAttempt::State;
      if (now_ms >= next_tail_attempt_ms)
        tail_attempt->CancelWaiting();
      const auto state = tail_attempt->state();
      if (state == State::succeeded && idle.CompleteRefresh(now_ms, true)) {
        ++tail_completions;
        last_tail_age_ms = idle.age_ms(now_ms);
      }
      if (state != State::source_wait && state != State::encoding)
        tail_attempt.reset();
    }
    const bool tail_ready = idle.TailDue(now_ms) && !tail_attempt &&
                            now_ms >= next_tail_attempt_ms && !presentation_refresh.Pending();
    if (!output.Suspended() && comp_bitrate.load() && sampling_fps && begin_schedule.Due(now)) {
      const auto interval = static_cast<uint32_t>((1000000ull + sampling_fps - 1) / sampling_fps);
      output.Slots().Pressure(registry.Pending() > 1);
      bool sent = false;
      const bool force_tail = tail_ready && tail_begins < 3;
      const bool force_refresh =
          result != RenderSlots::Result::ready && presentation_refresh.CanForce(now_ms);
      if (!output.Slots().Begin(interval, force_tail || force_refresh || recovery.active(), error,
                                &sent)) {
        if (frame.release)
          frame.release(frame.release_context, frame.frame_id);
        {
          registry.SetError(error);
        }
        presentation.InvalidateLayout("render-begin-failed");
        break;
      }
      if (sent && force_tail)
        ++tail_begins;
      if (sent && force_refresh)
        presentation_refresh.Forced(now_ms);
      // Begin can drain a Wake queued after Poll. A sent Begin satisfies it.
      observe_wake();
      begin_schedule.Attempted(now, std::max<int64_t>(1, QpcFrequency() / sampling_fps), sent);
    }
    if (result == RenderSlots::Result::ready) {
      const bool fresh =
          idle.Observe(metadata.generation, metadata.frame_id, metadata.capture_time_us, now_ms);
      if (fresh) {
        if (tail_attempt)
          tail_attempt->CancelWaiting();
        tail_attempt.reset();
        next_tail_attempt_ms = 0;
        tail_begins = 0;
        effective_idle_ms = idle.delay_ms();
        source_interval_ms = idle.interval_ms();
      }
      remotekit_rtc_adaptation adapted{};
      adapted.struct_size = sizeof(adapted);
      const auto stamp = output.Slots().MonotonicMicros();
      const auto adapt_begin = trace ? QpcNow() : 0;
      const auto adaptation_status =
          handle && stamp ? sdk.remotekit_rtc_adapt_frame(handle, metadata.width_pixels,
                                                          metadata.height_pixels, stamp, &adapted)
                          : REMOTEKIT_SDK_INVALID_STATE;
      RK_SERVER_TRACE(trace, "comp_adapt_begin", TraceIds::Frame(frame),
                      rk_record.qpc = adapt_begin;
                      rk_record.peer = handle;);
      RK_SERVER_TRACE(trace, "comp_adapt_return", TraceIds::Frame(frame),
                      rk_record.status = adaptation_status;
                      rk_record.peer = handle; rk_record.reason = adapted.drop ? "drop" : "keep";);
      if (adaptation_status == 0)
        official_max_fps = adapted.max_fps ? adapted.max_fps : 240;
      {
        std::lock_guard lock(comp_diagnostics_mutex);
        auto& d = comp_diagnostics;
        if (handle && stamp)
          ++d.adaptRequests;
        if (adaptation_status == 0 && adapted.drop)
          ++d.adaptDrops;
        else if (adaptation_status != 0)
          ++d.adaptErrors;
        d.officialMaxFps = official_max_fps;
        d.sourceWidth = metadata.width_pixels;
        d.sourceHeight = metadata.height_pixels;
      }
      if (adaptation_status != 0 || adapted.drop || !comp_bitrate.load() || !sampling_fps) {
        frame.release(frame.release_context, frame.frame_id);
      } else {
        // Retain hard H264 texture/frame limits, without trading product quality
        // against cadence. Official AdaptFrame remains the network controller.
        const auto hard = remotekit::FitH264Sampling(
            adapted.width, adapted.height, 1, peer_controller.ReceiveLevel(),
            options.max_encode_width, options.max_encode_height);
        codec_max_fps = hard.width ? remotekit::H264FrameRateLimit(hard.width, hard.height,
                                                                   peer_controller.ReceiveLevel())
                                   : 0;
        {
          std::lock_guard lock(comp_diagnostics_mutex);
          comp_diagnostics.codecMaxFps = codec_max_fps;
        }
        if (!codec_max_fps) {
          frame.release(frame.release_context, frame.frame_id);
          const std::string failure = "no legal H264 frame rate for selected encoder dimensions " +
                                      std::to_string(hard.width) + "x" +
                                      std::to_string(hard.height) +
                                      " level=" + std::to_string(peer_controller.ReceiveLevel());
          {
            registry.SetError(failure);
          }
          presentation.InvalidateLayout("codec-capability-error");
          LogError(LogLevel::kWarn, "media.failed", Error{ErrorCode::kInternal, failure},
                   {{"sessionId", id}});
          {
            {
              auto output_close_result_4 = output.Close();
              if (!output_close_result_4) {
                const Error close_error = output_close_result_4.error();
                LogError(LogLevel::kWarn, "output.stop_failed", close_error);
              }
            }
          }

          break;
        }
        sampling_fps = std::min(sampling_fps, codec_max_fps);
        {
          std::lock_guard lock(comp_diagnostics_mutex);
          comp_diagnostics.targetFps = sampling_fps;
          comp_diagnostics.resumeMaxFps =
              std::min({policy_max_fps.load(), official_max_fps, codec_max_fps});
        }
        auto sample = hard;
        sample.scale = std::min(double(hard.width) / metadata.width_pixels,
                                double(hard.height) / metadata.height_pixels);
        SetSampling(sample);
        frame.width = Sampling().width;
        frame.height = Sampling().height;
        {
          std::lock_guard lock(comp_diagnostics_mutex);
          auto& d = comp_diagnostics;
          if (d.encodedWidth && (d.encodedWidth != frame.width || d.encodedHeight != frame.height))
            ++d.adaptSizeChanges;
          d.encodedWidth = frame.width;
          d.encodedHeight = frame.height;
        }
        // Build the epoch from this exact GPU-observed texture and chosen sample.
        // No old texture is relabeled using the latest-layout publication.
        auto next = presentation.Layout(metadata);
        const auto epoch = presentation.ObserveLayout(metadata);
        next["epoch"] = std::to_string(epoch);
        if (next != presentation.Snapshot()) {
          has_current_view = std::ranges::any_of(
              next.at("views"), [](const auto& view) { return !view.value("stale", false); });
          presentation.PublishLayout(std::move(next), epoch);
        }
        frame.layout_epoch = epoch;
        update_refresh(handle, now_ms);
        auto attempt = presentation_refresh.TryStart(now_ms, 1000.0 / sampling_fps);
        const bool tail = !fresh && tail_ready && !presentation_refresh.Pending();
        if (tail) {
          tail_attempt = std::make_shared<remotekit::TailIdrAttempt>();
          next_tail_attempt_ms = now_ms + tail_retry_ms;
          attempt = tail_attempt;
        }
        if (attempt) {
          auto wrapped = remotekit::TailRefreshLease::Wrap(frame, std::move(attempt));
          frame.release(frame.release_context, frame.frame_id);
          frame = wrapped;
        }
        if (first_submit) {
          timing.MarkConnection(ConnectionPhase::submit);
          first_submit = false;
        }
        const int status = authorization.Current(active_authorization)
                               ? sdk.remotekit_rtc_submit_texture(handle, &frame)
                               : 1;
        if (status != 0)
          frame.release(frame.release_context, frame.frame_id);
        else {
          recovery.Submitted();
          if (tail)
            ++tail_submissions;
        }
      }
    }
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
    const auto remaining = std::max<int64_t>(0, begin_schedule.deadline() - QpcNow());
    const auto wait_us = std::min<int64_t>(
        1000, remaining ? std::max<int64_t>(1, remaining * 1000000 / QpcFrequency()) : 1000);
    LARGE_INTEGER due{};
    due.QuadPart = -wait_us * 10;
    const HANDLE wait_handles[] = {pace_timer,
                                   output.Suspended() ? nullptr : output.Slots().EventHandle()};
    if (!SetWaitableTimerEx(pace_timer, &due, 0, nullptr, nullptr, nullptr, 0) ||
        WaitForMultipleObjects(wait_handles[1] ? 2 : 1, wait_handles, FALSE, 2) == WAIT_FAILED) {
      presentation.InvalidateLayout("comp-pacing-failed");
      registry.SetError("Comp pacing wait failed");
      break;
    }
  }
}

uint32_t MediaPipeline::SamplingFps() const {
  return sampling_fps;
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
    policy_max_fps = value.get<uint32_t>();
    policy_degradation = degradation;
    policy_audio = audio;
    requested_media_policy = {
        {"audio", audio}, {"maxFps", policy_max_fps.load()}, {"degradationPreference", preference}};
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
  event_wake.notify_all();
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
  refresh_connected = true;
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
  comp_bitrate = bitrate;
  comp_fps = fps;
  Wake();
}
void MediaPipeline::Reset() {
  std::lock_guard lock(event_mutex);
  events.clear();
  refresh_connected = false;
  last_media_refresh_qpc = 0;
  effective_idle_ms = std::min(1000u, options.idle_idr_ms);
}
MediaSampling MediaPipeline::Sampling() const {
  std::lock_guard lock(sampling_mutex);
  return sampling;
}
void MediaPipeline::SetSampling(MediaSampling value) {
  std::lock_guard lock(sampling_mutex);
  sampling = std::move(value);
}
Json MediaPipeline::Snapshot() {
  Json requested;
  {
    std::lock_guard lock(media_policy_mutex);
    requested = requested_media_policy;
  }
  const auto degradation = policy_degradation.load();
  const char* preference = degradation == REMOTEKIT_RTC_MAINTAIN_RESOLUTION  ? "maintain-resolution"
                           : degradation == REMOTEKIT_RTC_MAINTAIN_FRAMERATE ? "maintain-framerate"
                                                                             : "balanced";
  return {{"mediaPolicy",
           {{"requested", requested},
            {"applied", peer_controller.Handle() ? Json{{"audio", policy_audio.load()},
                                                        {"maxFps", policy_max_fps.load()},
                                                        {"degradationPreference", preference}}
                                                 : Json(nullptr)}}},
          {"effective_idle_ms", effective_idle_ms.load()},
          {"tail_submissions", tail_submissions.load()},
          {"tail_completions", tail_completions.load()},
          {"source_interval_ms", source_interval_ms.load()},
          {"last_tail_age_ms", last_tail_age_ms.load()}};
}

}  // namespace remotekit
