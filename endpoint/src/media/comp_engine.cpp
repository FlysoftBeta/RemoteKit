#include "media/comp_engine.hpp"
namespace remotekit::media {
CompEngine::CompEngine(Sdk& sdk,
                       RenderSlots& slots,
                       EncoderSet& encoders,
                       std::shared_ptr<ServerTrace> trace,
                       CompConfig config)
    : sdk(sdk),
      slots(slots),
      encoders(encoders),
      trace(std::move(trace)),
      config(config),
      idle(config.idle_idr_ms),
      keepalive(QpcFrequency()) {
  input_event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  effective_idle_ms = std::min(1000u, config.idle_idr_ms);
}
CompEngine::~CompEngine() {
  StopGeneration();
  if (input_event)
    CloseHandle(input_event);
}
CompFailure CompEngine::Failure(std::string message, const char* reason) {
  return CompFailure{Error{ErrorCode::kInternal, std::move(message)}, reason};
}
std::optional<CompFailure> CompEngine::StartGeneration() {
  StopGeneration();
  pace_timer = CreateWaitableTimerExW(nullptr, nullptr, 0x2, TIMER_MODIFY_STATE | SYNCHRONIZE);
  if (!pace_timer || !input_event)
    return Failure("high resolution Comp timer unavailable", "comp-timer-unavailable");
  observed_wakes = slots.Stats().wakes;
  begin_schedule = {};
  cadence = {};
  recovery = {};
  idle = IdleIdrPolicy(config.idle_idr_ms);
  keepalive = IdleKeepalive(QpcFrequency());
  presentation_refresh = {};
  official_max_fps = codec_max_fps = 240;
  first_source = first_submit = true;
  tail_begins = 0;
  has_current_view = false;
  next_tail_attempt_ms = 0;
  effective_idle_ms = idle.delay_ms();
  source_interval_ms = 0;
  return {};
}
void CompEngine::StopGeneration() {
  presentation_refresh.SetScope(std::nullopt);
  if (tail_attempt)
    tail_attempt->CancelWaiting();
  tail_attempt.reset();
  if (pace_timer)
    CloseHandle(pace_timer);
  pace_timer = nullptr;
  std::lock_guard lock(comp_diagnostics_mutex);
  comp_diagnostics.targetFps = 0;
  comp_diagnostics.refresh.pending = false;
}
void CompEngine::ResetStream() {
  if (tail_attempt)
    tail_attempt->CancelWaiting();
  tail_attempt.reset();
  presentation_refresh.SetScope(std::nullopt);
  has_current_view = false;
  next_tail_attempt_ms = 0;
  begin_schedule.Reset();
}
void CompEngine::ObserveWake() {
  const auto wakes = slots.Stats().wakes;
  if (wakes != observed_wakes) {
    observed_wakes = wakes;
    begin_schedule.Wake();
  }
}
void CompEngine::UpdateRefresh(const CompStream& stream, CompHost& host, double now_ms) {
  std::optional<PresentationRefresh::Scope> scope;
  if (has_current_view && stream.output_open && host.Current(stream.scope)) {
    if (auto key = host.RefreshKey(stream.peer))
      scope = PresentationRefresh::Scope{stream.peer, stream.scope, *key};
  }
  presentation_refresh.SetScope(scope);
  if (scope)
    presentation_refresh.Update(refresh_connected.exchange(false), now_ms);
}
void CompEngine::Wake() {
  if (input_event)
    SetEvent(input_event);
}
void CompEngine::Rates(uint32_t bitrate, uint32_t fps) {
  comp_bitrate = bitrate;
  comp_fps = fps;
  Wake();
}
void CompEngine::InputReceived(int64_t qpc) {
  auto previous = last_input_qpc.load();
  while (previous < qpc && !last_input_qpc.compare_exchange_weak(previous, qpc)) {
  }
  Wake();
}
void CompEngine::ResetInputs() {
  refresh_connected = false;
  effective_idle_ms = std::min(1000u, config.idle_idr_ms);
}
void CompEngine::RequestRefresh() {
  refresh_connected = true;
  Wake();
}
void CompEngine::SetPolicy(uint32_t max_fps, uint32_t degradation) {
  policy_max_fps = max_fps;
  policy_degradation = degradation;
  Wake();
}
void CompEngine::SetSampling(MediaSampling value) {
  std::lock_guard lock(sampling_mutex);
  sampling = std::move(value);
}
CompEngine::Snapshot CompEngine::Diagnostics() const {
  std::scoped_lock lock(comp_diagnostics_mutex, sampling_mutex);
  return {comp_diagnostics,        sampling,
          sampling_fps.load(),     effective_idle_ms.load(),
          policy_max_fps.load(),   policy_degradation.load(),
          iteration_qpc.load(),    source_interval_ms.load(),
          last_tail_age_ms.load(), tail_submissions.load(),
          tail_completions.load()};
}
std::optional<CompFailure> CompEngine::UpdateCadence(const CompStream& stream) {
  if (begin_schedule.Due(QpcNow())) {
    if ((stream.peer != 0) && (stream.scope != 0) && stream.output_open) {
      remotekit_rtc_source_restrictions restrictions{};
      restrictions.struct_size = sizeof(restrictions);
      const int status = sdk.remotekit_rtc_get_source_restrictions(stream.peer, &restrictions);
      if (status != REMOTEKIT_SDK_OK) {
        return Failure("RTC source restrictions failed " + std::to_string(status), "");
      }
      const auto native = slots.LatestMetadata();
      recovery.Update(policy_degradation.load() == REMOTEKIT_RTC_BALANCED,
                      uint64_t{native.width_pixels} * native.height_pixels,
                      restrictions.target_pixels);
      official_max_fps = restrictions.max_fps ? restrictions.max_fps : 240;
    } else {
      recovery.Update(false, 0, 0);
    }
  }
  sampling_fps = cadence.Update(comp_bitrate.load(), comp_fps.load(), policy_max_fps.load(),
                                std::min(official_max_fps, codec_max_fps), slots.HasCapacity(),
                                static_cast<int64_t>(1000000.0 * QpcNow() / QpcFrequency()));
  {
    std::lock_guard lock(comp_diagnostics_mutex);
    comp_diagnostics.targetFps =
        (stream.peer != 0) && (stream.scope != 0) && stream.output_open ? sampling_fps.load() : 0;
    comp_diagnostics.officialMaxFps = official_max_fps;
    comp_diagnostics.codecMaxFps = codec_max_fps;
    comp_diagnostics.resumeMaxFps =
        std::min({policy_max_fps.load(), official_max_fps, codec_max_fps});
    comp_diagnostics.refresh = presentation_refresh.Snapshot();
  }
  return {};
}
std::optional<CompFailure> CompEngine::Step(const CompStream& stream, CompHost& host) {
  remotekit_rtc_frame frame{};
  remotekit::SharedAtlasFrame metadata{};
  std::string error;
  auto result =
      !stream.output_open ? RenderSlots::Result::idle : slots.Poll(frame, metadata, error);
  ObserveWake();
  if (first_source && result == RenderSlots::Result::ready) {
    host.Reached(CompHost::Milestone::source_frame);
    first_source = false;
  }
  if (result == RenderSlots::Result::error) {
    return Failure(error, "fatal");
  }
  if (!stream.output_open) {
    host.Invalidate("no-visible-views");
  }
  const auto handle = stream.peer;
  const auto now = QpcNow();
  iteration_qpc = now;
  const double now_ms = 1000.0 * now / QpcFrequency();
  UpdateRefresh(stream, host, now_ms);
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
  const bool tail_ready = idle.TailDue(now_ms) && !tail_attempt && now_ms >= next_tail_attempt_ms &&
                          !presentation_refresh.Pending();
  const bool force_tail = tail_ready && tail_begins < 3;
  const bool force_refresh =
      result != RenderSlots::Result::ready && presentation_refresh.CanForce(now_ms);
  const bool force_keepalive =
      slots.Stats().idle && !force_tail && !force_refresh && !recovery.active() &&
      !presentation_refresh.Pending() &&
      keepalive.Due(now, encoders.LastEncodedQpc(), tail_attempt || idle.TailDue(now_ms));
  const bool begin_allowed = host.CanBegin() && stream.output_open && (stream.peer != 0) &&
                             host.Current(stream.scope) && comp_bitrate.load() && sampling_fps;
  if (!begin_allowed) {
    slots.WithdrawAdmission();
  } else {
    const auto last_input = last_input_qpc.load();
    slots.SetAdmissionPriority(last_input && now - last_input < QpcFrequency() / 2
                                   ? FrameAdmission::Priority::interactive
                                   : FrameAdmission::Priority::normal);
  }
  if (begin_allowed && slots.CanAttemptAdmission() &&
      (begin_schedule.Due(now) || slots.AdmissionPending() || force_keepalive)) {
    const auto interval = static_cast<uint32_t>((1000000ull + sampling_fps - 1) / sampling_fps);
    if (begin_schedule.Due(now) && !force_keepalive)
      slots.Pressure(encoders.Pending() > 1);
    bool sent = false;
    if (!slots.Begin(interval, force_tail || force_refresh || recovery.active() || force_keepalive,
                     error, &sent, force_keepalive)) {
      if (frame.release)
        frame.release(frame.release_context, frame.frame_id);
      return Failure(error, "render-begin-failed");
    }
    if (sent && force_keepalive)
      keepalive.Sent(now);
    if (sent && force_tail)
      ++tail_begins;
    if (sent && force_refresh)
      presentation_refresh.Forced(now_ms);
    // Begin can drain a Wake queued after Poll. A sent Begin satisfies it.
    ObserveWake();
    // Pending admission is independent of the cadence deadline. Its event can
    // retry immediately while restriction reads and pressure keep their
    // cadence.
    if (!force_keepalive && (begin_schedule.Due(now) || sent || !slots.AdmissionPending()))
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
    const auto stamp = slots.MonotonicMicros();
    const auto adapt_begin = trace ? QpcNow() : 0;
    const auto adaptation_status =
        handle && stamp ? sdk.remotekit_rtc_adapt_frame(handle, metadata.width_pixels,
                                                        metadata.height_pixels, stamp, &adapted)
                        : REMOTEKIT_SDK_INVALID_STATE;
    RK_SERVER_TRACE(trace, "comp_adapt_begin", TraceIds::Frame(frame), rk_record.qpc = adapt_begin;
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
          remotekit::FitH264Sampling(adapted.width, adapted.height, 1, stream.receive_level,
                                     config.max_encode_width, config.max_encode_height);
      codec_max_fps =
          hard.width ? remotekit::H264FrameRateLimit(hard.width, hard.height, stream.receive_level)
                     : 0;
      {
        std::lock_guard lock(comp_diagnostics_mutex);
        comp_diagnostics.codecMaxFps = codec_max_fps;
      }
      if (!codec_max_fps) {
        frame.release(frame.release_context, frame.frame_id);
        const std::string failure = "no legal H264 frame rate for selected encoder dimensions " +
                                    std::to_string(hard.width) + "x" + std::to_string(hard.height) +
                                    " level=" + std::to_string(stream.receive_level);
        return Failure(failure, "codec-capability-error");
      }
      sampling_fps = std::min(sampling_fps.load(), codec_max_fps);
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
      frame.width = sample.width;
      frame.height = sample.height;
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
      const auto layout = host.ObserveLayout(metadata);
      const auto epoch = layout.epoch;
      has_current_view = layout.has_current_view;
      frame.layout_epoch = epoch;
      UpdateRefresh(stream, host, now_ms);
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
        host.Reached(CompHost::Milestone::submit);
        first_submit = false;
      }
      const int status =
          host.Current(stream.scope) ? sdk.remotekit_rtc_submit_texture(handle, &frame) : 1;
      if (status != 0)
        frame.release(frame.release_context, frame.frame_id);
      else {
        recovery.Submitted();
        if (tail)
          ++tail_submissions;
      }
    }
  }
  return {};
}
std::optional<CompFailure> CompEngine::Wait(const CompStream& stream) {
  const auto remaining = std::max<int64_t>(0, begin_schedule.deadline() - QpcNow());
  const auto wait_us = std::min<int64_t>(
      1000, remaining ? std::max<int64_t>(1, remaining * 1000000 / QpcFrequency()) : 1000);
  LARGE_INTEGER due{};
  due.QuadPart = -wait_us * 10;
  HANDLE wait_handles[] = {pace_timer, input_event, nullptr, nullptr};
  DWORD wait_count = 2, admission_index = 0;
  if (stream.output_open) {
    if (const auto event = slots.EventHandle())
      wait_handles[wait_count++] = event;
    if (const auto event = slots.AdmissionEventHandle()) {
      admission_index = wait_count;
      wait_handles[wait_count++] = event;
    }
  }
  const auto wait = SetWaitableTimerEx(pace_timer, &due, 0, nullptr, nullptr, nullptr, 0)
                        ? WaitForMultipleObjects(wait_count, wait_handles, FALSE, 2)
                        : WAIT_FAILED;
  if (admission_index && wait == WAIT_OBJECT_0 + admission_index)
    slots.AdmissionWoken();
  if (wait == WAIT_FAILED) {
    return Failure("Comp pacing wait failed", "comp-pacing-failed");
  }
  return {};
}
}  // namespace remotekit::media
