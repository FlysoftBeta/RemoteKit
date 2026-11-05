#include "session/session.hpp"
namespace remotekit {
void Session::MediaLoop() {
  std::shared_ptr<remotekit::TailIdrAttempt> tail_attempt;
  // All exits, including early return and source/Begin failure, stop this
  // generation. Block-local locks unwind before this function-scope guard.
  struct RenderExit {
    Session& owner;
    std::shared_ptr<remotekit::TailIdrAttempt>& tail;
    ~RenderExit() {
      if (tail)
        tail->CancelWaiting();
      std::string error;
      if (!owner.pool.Close(error))
        fprintf(stderr, "media exit render drain: %s\n", error.c_str());
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
    InvalidateLayout("comp-timer-unavailable");
    std::lock_guard lock(stats->mutex);
    stats->error = "high resolution Comp timer unavailable";
    return;
  }
  struct TimerCloser {
    HANDLE value;
    ~TimerCloser() { CloseHandle(value); }
  } timer_closer{pace_timer};
  uint64_t observed_wakes = pool.Stats().wakes;
  remotekit::CompBeginSchedule begin_schedule;
  auto observe_wake = [&] {
    const auto wakes = pool.Stats().wakes;
    if (wakes != observed_wakes) {
      observed_wakes = wakes;
      begin_schedule.Wake();
    }
  };
  int64_t last_stats = QpcNow();
  uint32_t official_max_fps = 240, codec_max_fps = 240;
  remotekit::CompCadence cadence;
  uint64_t previous_encoded = stats->completed.load(), previous_bytes = stats->bytes.load();
  uint64_t previous_delivered = pool.delivered_frames();
  remotekit::IdleIdrPolicy idle(options.idle_idr_ms);
  bool has_current_view = false;

  bool first_source = true, first_submit = true;
  unsigned consecutive_reconfigures = 0;
  double next_tail_attempt_ms = 0;
  uint32_t tail_begins = 0;
  constexpr double tail_retry_ms = 250;
  effective_idle_ms = idle.delay_ms();
  source_interval_ms = 0;
  uint64_t active_authorization = authorization.Stamp();
  frame_authorization = active_authorization;
  auto update_refresh = [&](uint64_t handle, double now_ms) {
    std::optional<remotekit::PresentationRefresh::Scope> scope;
    if (has_current_view && !output_suspended && authorization.Current(active_authorization)) {
      if (auto key = presentation.RefreshKey(handle, layout_epoch.load()))
        scope = remotekit::PresentationRefresh::Scope{handle, active_authorization, *key};
    }
    presentation_refresh.SetScope(scope);
    if (scope)
      presentation_refresh.Update(refresh_connected.exchange(false), now_ms);
  };
  while (!stop_media) {
    const auto stamp = authorization.Stamp();
    if (stamp != active_authorization) {
      frame_authorization = 0;
      if (tail_attempt)
        tail_attempt->CancelWaiting();
      tail_attempt.reset();
      presentation_refresh.SetScope(std::nullopt);
      has_current_view = false;
      next_tail_attempt_ms = 0;
      begin_schedule.Reset();
      InvalidateLayout(stamp ? "authorization-resuming" : "authorization-locked");
      if (rtc_connected) {
        {
          if (pool.EventHandle()) {
            {
              auto output_close_result = browser.Rpc().Request({{"method", "output.close"}});
              if (!output_close_result) {
                const Error error = output_close_result.error();
                fprintf(stderr, "authorization output transition: %s\n", error.message.c_str());
                return;
              }
            }
            std::string drain_error;
            if (!pool.Close(drain_error)) {
              Error error{ErrorCode::kRejected, drain_error};
              fprintf(stderr, "authorization output transition: %s\n", error.message.c_str());
              return;
            };
          }
          if (stamp && authorization.Current(stamp)) {
            auto open_output_result = OpenOutput();
            if (!open_output_result) {
              const Error error = open_output_result.error();
              fprintf(stderr, "authorization output transition: %s\n", error.message.c_str());
              return;
            }
          }
        }
      }
      active_authorization = stamp;
      frame_authorization = stamp;
      if (stamp)
        refresh_connected = true;
    }
    sampling_fps = cadence.Update(comp_bitrate.load(), comp_fps.load(), policy_max_fps.load(),
                                  std::min(official_max_fps, codec_max_fps), pool.HasCapacity(),
                                  static_cast<int64_t>(1000000.0 * QpcNow() / QpcFrequency()));
    {
      std::lock_guard lock(comp_diagnostics_mutex);
      comp_diagnostics.targetFps = rtc_connected.load() &&
                                           authorization.Current(active_authorization) &&
                                           !output_suspended.load()
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
      if (event.peer != peer.load())
        continue;
      if (event.type == 0x10000 && ProductCurrent(event)) {
        auto message = Json::parse(event.bytes, nullptr, false);
        if (!message.is_discarded())
          Send(message, event.authorization);
      } else if (event.type == REMOTEKIT_RTC_STATS) {
        auto sample = Json::parse(event.bytes, nullptr, false);
        if (sample.is_object()) {
          std::lock_guard lock(stats->mutex);
          stats->sender_rtc_stats = std::move(sample);
        }
      } else if (event.type == REMOTEKIT_RTC_REFRESH_REQUEST) {
        refresh_connected = true;
      } else if (event.type == REMOTEKIT_RTC_STATE) {
        const bool connected = event.value == 2;
        if (connected != rtc_connected.exchange(connected)) {
          if (tail_attempt)
            tail_attempt->CancelWaiting();
          tail_attempt.reset();
          presentation_refresh.SetScope(std::nullopt);
          has_current_view = false;
          next_tail_attempt_ms = 0;
          begin_schedule.Reset();
          InvalidateLayout(connected ? "rtc-resuming" : "rtc-disconnected");
          {
            if (connected) {
              if (authorization.Current(active_authorization)) {
                auto open_output_result_2 = OpenOutput();
                if (!open_output_result_2) {
                  const Error failure = open_output_result_2.error();
                  {
                    std::lock_guard lock(stats->mutex);
                    stats->error = failure.message.c_str();
                  }
                  InvalidateLayout("rtc-output-error");
                  {
                    auto closed = browser.Rpc().Request({{"method", "output.close"}});
                    if (!closed)
                      fprintf(stderr, "output close: %s\n", closed.error().message.c_str());
                  }

                  fprintf(stderr, "session %s RTC output: %s\n", id.c_str(),
                          failure.message.c_str());
                  return;
                }
              }
              refresh_connected = true;
            } else {
              {
                auto output_close_result_2 = browser.Rpc().Request({{"method", "output.close"}});
                if (!output_close_result_2) {
                  const Error failure = output_close_result_2.error();
                  {
                    std::lock_guard lock(stats->mutex);
                    stats->error = failure.message.c_str();
                  }
                  InvalidateLayout("rtc-output-error");
                  {
                    auto closed = browser.Rpc().Request({{"method", "output.close"}});
                    if (!closed)
                      fprintf(stderr, "output close: %s\n", closed.error().message.c_str());
                  }

                  fprintf(stderr, "session %s RTC output: %s\n", id.c_str(),
                          failure.message.c_str());
                  return;
                }
              }
              std::string drain_error;
              if (!pool.Close(drain_error))
                fprintf(stderr, "disconnected render drain: %s\n", drain_error.c_str());
            }
          }
        }
      } else if (event.type == REMOTEKIT_RTC_DATA_STATE) {
        const bool opened = event.value == 1;
        if (opened && !data_open.exchange(opened))
          refresh_connected = true;
        if (!opened)
          data_open = false;
        if (data_open) {
          QueueLayout();
          direct_services.RefreshEditable();
        }
      } else if (event.type == REMOTEKIT_RTC_DATA) {
        auto routed = RouteData(event);
        if (!routed)
          Send({{"type", "error"},
                {"error",
                 {{"code", ErrorCodeName(routed.error().code)},
                  {"message", routed.error().message}}}},
               event.authorization);
      } else if (event.type == REMOTEKIT_RTC_ERROR)
        fprintf(stderr, "RTC %s: %s\n", id.c_str(), event.bytes.c_str());
    }
    FlushControl();
    if (!rtc_connected || !authorization.Current(active_authorization)) {
      std::unique_lock lock(event_mutex);
      event_wake.wait_for(lock, std::chrono::milliseconds(20),
                          [&] { return stop_media || !events.empty(); });
      continue;
    }
    remotekit_rtc_frame frame{};
    remotekit::SharedAtlasFrame metadata{};
    std::string error;
    auto result = output_suspended ? RenderSlots::Result::idle : pool.Poll(frame, metadata, error);
    observe_wake();
    if (first_source && result == RenderSlots::Result::ready) {
      MarkConnection(ConnectionPhase::source_frame);
      first_source = false;
    }
    if (result == RenderSlots::Result::reconfigure) {
      InvalidateLayout("reconfigure");
      if (tail_attempt)
        tail_attempt->CancelWaiting();
      tail_attempt.reset();
      presentation_refresh.SetScope(std::nullopt);
      has_current_view = false;
      next_tail_attempt_ms = 0;
      begin_schedule.Reset();
      idle = remotekit::IdleIdrPolicy(options.idle_idr_ms);
      effective_idle_ms = idle.delay_ms();
      source_interval_ms = 0;
      last_tail_age_ms = 0;
      auto reconfigured = [&]() -> Result<void> {
        if (++consecutive_reconfigures > 3)
          return Error{ErrorCode::kUnavailable,
                       "atlas repeatedly requested reconfiguration before a frame"};
        if (stop_media.load())
          return {};
        auto closed = browser.Rpc().Request({{"method", "output.close"}});
        if (!closed)
          return closed.error();
        if (stop_media.load())
          return {};
        return OpenOutput(true);
      }();
      if (stop_media.load())
        break;
      if (reconfigured) {
        previous_delivered = pool.delivered_frames();
        previous_encoded = stats->completed.load();
        previous_bytes = stats->bytes.load();
        last_stats = QpcNow();
        refresh_connected = true;
        {
          std::lock_guard lock(encoder_mutex);
          for (auto& [encoder, worker] : encoders)
            worker->Keyframe();
        }
        continue;
      }
      error = "atlas reconfigure failed: " + reconfigured.error().message;
      result = RenderSlots::Result::error;
    }
    if (result == RenderSlots::Result::error) {
      InvalidateLayout("fatal");
      {
        {
          auto output_close_result_3 = browser.Rpc().Request({{"method", "output.close"}});
          if (!output_close_result_3) {
            const Error close_error = output_close_result_3.error();
            fprintf(stderr, "session %s fatal output stop: %s\n", id.c_str(),
                    close_error.message.c_str());
          }
        }
      }

      {
        std::lock_guard lock(stats->mutex);
        stats->error = error;
      }
      fprintf(stderr, "session %s media: %s\n", id.c_str(), error.c_str());
      break;
    }
    const auto current_metadata =
        output_suspended ? remotekit::SharedAtlasFrame{} : pool.LatestMetadata();
    if (output_suspended) {
      if (current_geometry != "invalid:no-visible-views")
        InvalidateLayout("no-visible-views");
    }
    const auto handle = peer.load();
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
    if (!output_suspended && comp_bitrate.load() && sampling_fps && begin_schedule.Due(now)) {
      const auto interval = static_cast<uint32_t>((1000000ull + sampling_fps - 1) / sampling_fps);
      pool.Pressure(stats->pending.load() > 1);
      bool sent = false;
      const bool force_tail = tail_ready && tail_begins < 3;
      const bool force_refresh =
          result != RenderSlots::Result::ready && presentation_refresh.CanForce(now_ms);
      if (!pool.Begin(interval, force_tail || force_refresh, error, &sent)) {
        if (frame.release)
          frame.release(frame.release_context, frame.frame_id);
        {
          std::lock_guard lock(stats->mutex);
          stats->error = error;
        }
        InvalidateLayout("render-begin-failed");
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
      consecutive_reconfigures = 0;
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
      const auto stamp = pool.MonotonicMicros();
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
        const auto hard =
            remotekit::FitH264Sampling(adapted.width, adapted.height, 1, receive_level.load(),
                                       options.max_encode_width, options.max_encode_height);
        codec_max_fps = hard.width ? remotekit::H264FrameRateLimit(hard.width, hard.height,
                                                                   receive_level.load())
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
                                      " level=" + std::to_string(receive_level.load());
          {
            std::lock_guard lock(stats->mutex);
            stats->error = failure;
          }
          InvalidateLayout("codec-capability-error");
          fprintf(stderr, "session %s media: %s\n", id.c_str(), failure.c_str());
          {
            {
              auto output_close_result_4 = browser.Rpc().Request({{"method", "output.close"}});
              if (!output_close_result_4) {
                const Error close_error = output_close_result_4.error();
                fprintf(stderr, "codec failure output stop: %s\n", close_error.message.c_str());
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
        sampling = hard;
        sampling.scale = std::min(double(hard.width) / metadata.width_pixels,
                                  double(hard.height) / metadata.height_pixels);
        frame.width = sampling.width;
        frame.height = sampling.height;
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
        auto next = remotekit::LayoutCapabilities(
            Layout(metadata), browser.Rpc().Control() != 0 &&
                                  client_gestures_control.load() == browser.Rpc().Control());
        const auto epoch = ObserveLayout(metadata);
        next["epoch"] = std::to_string(epoch);
        if (next != layout) {
          has_current_view = std::ranges::any_of(
              next.at("views"), [](const auto& view) { return !view.value("stale", false); });
          PublishLayout(std::move(next), epoch);
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
          MarkConnection(ConnectionPhase::submit);
          first_submit = false;
        }
        const int status = authorization.Current(active_authorization)
                               ? sdk.remotekit_rtc_submit_texture(handle, &frame)
                               : 1;
        if (status != 0)
          frame.release(frame.release_context, frame.frame_id);
        else if (tail)
          ++tail_submissions;
      }
    }
    direct_services.Editable(peer.load(), current_metadata, output_suspended);
    if (now - last_stats >= QpcFrequency()) {
      if (trace)
        trace->WallClock();
      if (handle && sdk.request_stats)
        sdk.request_stats(handle);
      auto report = Stats();
      report["type"] = "stats";
      const double seconds = static_cast<double>(now - last_stats) / QpcFrequency();
      const auto encoded = stats->completed.load(), bytes = stats->bytes.load();
      report["encodedFps"] = (encoded - previous_encoded) / seconds;
      report["encodedBitrateBps"] = 8.0 * (bytes - previous_bytes) / seconds;
      const auto delivered = pool.delivered_frames();
      report["atlasDeliveredFrames"] = delivered;
      report["atlasDeliveredFps"] = (delivered - previous_delivered) / seconds;
      previous_delivered = delivered;
      previous_encoded = encoded;
      previous_bytes = bytes;
      report["sourceAtlasWidth"] = current_metadata.width_pixels;
      report["sourceAtlasHeight"] = current_metadata.height_pixels;
      report["mediaScale"] = sampling.scale;
      report["negotiatedReceiveLevel"] = receive_level.load();
      report["samplingFpsBudget"] = SamplingFps();
      report["resolutionLimitation"] = sampling.limitation;
      report["samplingMaxFrameMacroblocks"] = sampling.max_frame_macroblocks;
      report["samplingMaxMacroblocksPerSecond"] = sampling.max_macroblocks_per_second;
      report["receiveLevel"] = receive_level.load();
      report["inputRejected"] = input_rejected.load();
      report["inputCoalesced"] = input_coalesced.load();
      report["inputBusyRetries"] = input_busy_retries.load();
      report["inputBusyExhausted"] = input_busy_exhausted.load();
      {
        std::lock_guard lock(input_mutex);
        report["inputQueue"] = input_queue.size();
      }
      const auto latency = pool.capture_to_ready_ms();
      report["captureToReadyMs"] = latency ? Json(*latency) : Json(nullptr);
      report["captureClock"] = latency ? "measured SDK TimeTicks to QPC mapping" : "unavailable";
      report["clockUncertaintyUs"] = pool.clock_uncertainty_us();
      Send(report);
      last_stats = now;
    }
    const auto remaining = std::max<int64_t>(0, begin_schedule.deadline() - QpcNow());
    const auto wait_us = std::min<int64_t>(
        1000, remaining ? std::max<int64_t>(1, remaining * 1000000 / QpcFrequency()) : 1000);
    LARGE_INTEGER due{};
    due.QuadPart = -wait_us * 10;
    const HANDLE wait_handles[] = {pace_timer, output_suspended ? nullptr : pool.EventHandle()};
    if (!SetWaitableTimerEx(pace_timer, &due, 0, nullptr, nullptr, nullptr, 0) ||
        WaitForMultipleObjects(wait_handles[1] ? 2 : 1, wait_handles, FALSE, 2) == WAIT_FAILED) {
      InvalidateLayout("comp-pacing-failed");
      std::lock_guard lock(stats->mutex);
      stats->error = "Comp pacing wait failed";
      break;
    }
  }
}
}  // namespace remotekit
