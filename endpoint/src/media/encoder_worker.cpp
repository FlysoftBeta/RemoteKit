#include "util/log.hpp"
#include "util/thread.hpp"
#include "encoder_worker.hpp"
#include "media/sampling.hpp"
#include "media/tail_refresh.hpp"
#include <chrono>
#include <utility>
namespace remotekit::media {
nlohmann::json EncoderStats::Snapshot() {
  std::lock_guard lock(mutex);
  nlohmann::json low_power = nullptr;
  if (qsv_low_power) {
    low_power = {{"requested", qsv_low_power->requested}};
    auto add = [&](const char* name, const std::optional<int>& value) {
      low_power[name] = value ? nlohmann::json(*value) : nlohmann::json(nullptr);
    };
    add("queried", qsv_low_power->queried);
    add("initialized", qsv_low_power->initialized);
    add("queryStatus", qsv_low_power->query_status);
    add("initStatus", qsv_low_power->init_status);
    add("getVideoParamStatus", qsv_low_power->get_video_param_status);
  }
  nlohmann::json result = {
      {"qsvLowPower", low_power},
      {"senderRtcStats", sender_rtc_stats},
      {"encoder", backend},
      {"encodeSubmitted", submitted.load()},
      {"encodeCompleted", completed.load()},
      {"encodedBytes", bytes.load()},
      {"encodeDropped", dropped.load()},
      {"encodePending", pending.load()},
      {"encodeInflight", inflight.load()},
      {"queueFullDrops", queue_full_drops.load()},
      {"hardwareBusy", hardware_busy.load()},
      {"pausedDrops", paused_drops.load()},
      {"errorDrops", error_drops.load()},
      {"inactiveDrops", inactive_drops.load()},
      {"cancelledDrops", cancelled_drops.load()},
      {"queueWaitUs", queue_wait_us.load()},
      {"queueWaitSamples", queue_wait_samples.load()},
      {"rateUpdates", rate_updates.load()},
      {"keyframeRequests", keyframe_requests.load()},
      {"keyframesSubmitted", keyframes_submitted.load()},
      {"keyframesEncoded", keyframes_encoded.load()},
      {"lastEncodeMs",
       completed.load() ? nlohmann::json(last_encode_ms.load()) : nlohmann::json(nullptr)},
      {"gccTargetBitrate", gcc_target_bitrate},
      {"gccTargetFps", gcc_target_fps},
      {"requestedTargetUsage",
       requested_target_usage ? nlohmann::json(requested_target_usage) : nlohmann::json(nullptr)},
      {"appliedTargetUsage",
       applied_target_usage ? nlohmann::json(*applied_target_usage) : nlohmann::json(nullptr)},
      {"appliedBitrate",
       applied_bitrate ? nlohmann::json(applied_bitrate) : nlohmann::json(nullptr)},
      {"appliedMaxBitrate",
       applied_max_bitrate ? nlohmann::json(applied_max_bitrate) : nlohmann::json(nullptr)},
      {"appliedFps", applied_fps ? nlohmann::json(applied_fps) : nlohmann::json(nullptr)},
      {"actualLevel", actual_level},
      {"error", error.empty() ? nlohmann::json(nullptr) : nlohmann::json(error)}};
  if (qsv_rate_control) {
    const auto& info = *qsv_rate_control;
    result["qsvRateControl"] = {
        {"lowDelayBrc", info.low_delay_brc},      {"maxFrameSize", info.max_frame_size},
        {"maxFrameSizeI", info.max_frame_size_i}, {"maxFrameSizeP", info.max_frame_size_p},
        {"bufferSizeKb", info.buffer_size_kb},    {"initialDelayKb", info.initial_delay_kb}};
  }
  return result;
}
EncoderWorker::EncoderWorker(
    Sdk& sdk,
    uint64_t encoder,
    ID3D11Device* device,
    std::string mode,
    EncoderSettings defaults,
    std::shared_ptr<EncoderStats> stats,
    std::function<void(uint32_t, uint64_t, size_t, bool, const remotekit_rtc_frame&)> completed,
    std::shared_ptr<ServerTrace> trace,
    uint64_t peer,
    std::function<bool(const remotekit_rtc_frame&, bool, const std::function<bool()>&)> publish)
    : sdk_(sdk),
      encoder_(encoder),
      device_(device),
      mode_(std::move(mode)),
      settings_(defaults),
      stats_(std::move(stats)),
      completed_(std::move(completed)),
      publish_(std::move(publish)),
      trace_(std::move(trace)),
      trace_peer_(peer) {}
EncoderWorker::~EncoderWorker() {
  Stop();
}
void EncoderWorker::Error(const std::string& error) {
  failed_ = true;
  std::lock_guard lock(stats_->mutex);
  stats_->error = error;
  LogError(LogLevel::kWarn, "encoder.failed", remotekit::Error{ErrorCode::kInternal, error},
           {{"encoder", encoder_}});
}
bool EncoderWorker::RetainUnsafeInputs(Job* additional) {
  if (!hardware_ || hardware_->CanReleaseInputs())
    return false;
  // Frame callbacks represent pool leases, independently of COM lifetime.
  // This owner is transferred to the failed backend's process-lifetime store;
  // no callback is invoked and no source/surface can be recycled on timeout.
  struct RetainedInputs {
    std::vector<Job> jobs;
    std::vector<ComPtr<ID3D11Texture2D>> surfaces, sources;
  };
  auto retained = std::make_shared<RetainedInputs>();
  retained->surfaces = surfaces_;
  for (auto& [cookie, job] : inflight_) {
    retained->jobs.push_back(job);
    ComPtr<ID3D11Texture2D> source;
    source.Attach(static_cast<ID3D11Texture2D*>(job.frame.d3d11_texture));
    retained->sources.push_back(std::move(source));
    --stats_->inflight;
    ++stats_->error_drops;
    ++stats_->dropped;
    remotekit::TailRefreshLease::Finish(job.frame, false);
    if (sdk_.encoder_drop)
      sdk_.encoder_drop(encoder_, job.frame.rtp_timestamp);
  }
  inflight_.clear();
  if (additional) {
    retained->jobs.push_back(*additional);
    ComPtr<ID3D11Texture2D> source;
    source.Attach(static_cast<ID3D11Texture2D*>(additional->frame.d3d11_texture));
    retained->sources.push_back(std::move(source));
  }
  hardware_->HoldInputsUntilProcessExit(std::move(retained));
  return true;
}
bool EncoderWorker::Configure(const remotekit_rtc_encoder_config& config) {
  Stop();  // WebRTC may configure an existing encoder after a size transition.
  {
    std::lock_guard lock(stats_->mutex);
    stats_->applied_target_usage.reset();
    stats_->requested_target_usage = 0;
    stats_->qsv_rate_control.reset();
  }
  settings_.width = config.width;
  settings_.height = config.height;
  settings_.fps = config.fps ? config.fps : settings_.fps;
  settings_.bitrate = config.bitrate_bps ? config.bitrate_bps : settings_.bitrate;
  settings_.max_bitrate = config.max_bitrate_bps ? config.max_bitrate_bps : settings_.max_bitrate;
  settings_.level_idc = config.h264_level_idc;
  fps_limit_ =
      remotekit::H264FrameRateLimit(settings_.width, settings_.height, settings_.level_idc);
  if (!fps_limit_) {
    Error("encoder dimensions/level have no legal H264 frame rate");
    return false;
  }
  settings_.fps = std::min(settings_.fps, fps_limit_);
  const auto level_budget = remotekit::H264RateLimits(settings_.level_idc);
  if (level_budget.bitrate_bps) {
    settings_.max_bitrate = std::min(settings_.max_bitrate, level_budget.bitrate_bps);
    settings_.bitrate = std::min(settings_.bitrate, settings_.max_bitrate);
  }
  const auto requested_usage = settings_.target_usage;
  const bool requested_vbr = settings_.vbr;
  auto defaults = [&](bool qsv) {
    settings_.target_usage = settings_.target_usage_explicit ? requested_usage : (qsv ? 7u : 4u);
    settings_.vbr = settings_.rate_control_explicit ? requested_vbr : qsv;
  };
  defaults(mode_ != "nvenc");
  {
    std::lock_guard lock(stats_->mutex);
    stats_->requested_target_usage = settings_.target_usage;
  }
  std::string error;
  hardware_ = hardware_factory_ ? hardware_factory_()
                                : (mode_ == "nvenc" ? CreateNvencEncoder() : CreateQsvEncoder());
  hardware_->SetTrace(trace_, encoder_);
  converter_.SetTrace(trace_);
  if (!hardware_->Configure(device_.Get(), settings_, error)) {
    {
      std::lock_guard lock(stats_->mutex);
      stats_->qsv_low_power = hardware_->LowPowerInfo();
      stats_->qsv_rate_control = hardware_->RateControlInfo();
    }
    hardware_.reset();
    if (mode_ != "auto" || (settings_.qsv_low_power && settings_.qsv_low_power_explicit)) {
      Error(error);
      return false;
    }
    const std::string qsv_error = error;
    defaults(false);
    settings_.qsv_low_power = 0;
    hardware_ = CreateNvencEncoder();
    hardware_->SetTrace(trace_, encoder_);
    if (!hardware_->Configure(device_.Get(), settings_, error)) {
      Error("QSV: " + qsv_error + "; NVENC: " + error);
      hardware_.reset();
      return false;
    }
  }
  if (!converter_.Open(device_.Get(), settings_.width, settings_.height, settings_.fps, error)) {
    Error(error);
    return false;
  }
  for (uint32_t i = 0; i < settings_.async_depth; ++i) {
    ComPtr<ID3D11Texture2D> surface;
    if (!converter_.CreateSurface(surface, error)) {
      Error(error);
      return false;
    }
    surfaces_.push_back(std::move(surface));
    free_.push_back(i);
  }
  {
    std::lock_guard lock(stats_->mutex);
    stats_->backend = hardware_->Name();
    stats_->error.clear();
    stats_->qsv_rate_control = hardware_->RateControlInfo();
    if (auto info = hardware_->LowPowerInfo())
      stats_->qsv_low_power = *info;
    auto actual = hardware_->ActualSettings();
    stats_->applied_bitrate = actual.bitrate;
    stats_->applied_max_bitrate = actual.max_bitrate;
    stats_->applied_fps = actual.fps;
    stats_->actual_level = actual.level_idc;
    stats_->gcc_target_bitrate = 0;
    stats_->gcc_target_fps = 0;
    stats_->requested_target_usage = settings_.target_usage;
    if (std::string(hardware_->Name()) == "qsv")
      stats_->applied_target_usage = actual.target_usage;
  }
  rate_limit_ = settings_.max_bitrate;
  pending_rates_.reset();
  retained_frames_ = 0;
  paused_ = false;
  keyframe_ = true;
  stopping_ = false;
  failed_ = false;
  configured_ = true;
  thread_ = std::thread([this] {
    remotekit::RunThread(
        "encoder", [this] { Run(); },
        [this] {
          std::lock_guard lock(mutex_);
          failed_ = true;
        });
  });
  return true;
}
bool EncoderWorker::Enqueue(const remotekit_rtc_frame& frame, bool keyframe) {
  std::lock_guard lock(mutex_);
  if (!configured_ || stopping_ || failed_ || paused_) {
    RK_SERVER_TRACE(trace_, "worker_drop", TraceIds::Frame(frame, true),
                    rk_record.reason = "not_running_or_paused";
                    rk_record.encoder = encoder_; rk_record.peer = trace_peer_;);
    if (failed_)
      ++stats_->error_drops;
    else if (!configured_ || stopping_)
      ++stats_->inactive_drops;
    else
      ++stats_->paused_drops;
    ++stats_->dropped;
    return false;
  }
  // Slots bound the entire accepted FIFO, including GPU work in flight.
  // Refuse overload; replacing an older frame would conceal producer backlog.
  if (retained_frames_ >= kFrameCapacity) {
    ++stats_->queue_full_drops;
    ++stats_->dropped;
    RK_SERVER_TRACE(trace_, "worker_drop", TraceIds::Frame(frame, true),
                    rk_record.reason = "queue_full";
                    rk_record.encoder = encoder_; rk_record.peer = trace_peer_;);
    return false;
  }
  Job job;
  job.frame = frame;
  job.key = keyframe;
  job.cookie = ++cookie_;
  job.enqueued_qpc = QpcNow();
  // Hold both COM lifetime and the distinct atlas-pool slot lease.
  static_cast<ID3D11Texture2D*>(frame.d3d11_texture)->AddRef();
  frame.retain(frame.release_context, frame.frame_id);
  queue_.push_back(job);
  ++stats_->pending;
  ++retained_frames_;
  RK_SERVER_TRACE(trace_, "worker_enqueue", TraceIds::Frame(frame, true),
                  rk_record.cookie = job.cookie;
                  rk_record.encoder = encoder_; rk_record.peer = trace_peer_;
                  rk_record.queue = static_cast<int>(queue_.size()););
  wake_.notify_one();
  return true;
}
void EncoderWorker::Rates(uint32_t bitrate, uint32_t fps) {
  std::lock_guard lock(mutex_);
  {
    std::lock_guard stats_lock(stats_->mutex);
    stats_->gcc_target_bitrate = bitrate;
    stats_->gcc_target_fps = fps;
  }
  const bool paused = !bitrate || !fps;
  if (paused_.exchange(paused) && !paused)
    keyframe_ = true;
  // Preserve GCC's target pair. Only the configured/negotiated ceiling is
  // applied by Run; a zero target pauses rather than inventing a minimum rate.
  pending_rates_ = RateUpdate{bitrate, fps};
  RK_SERVER_TRACE(trace_, "worker_rates_requested", TraceIds{}, rk_record.encoder = encoder_;
                  rk_record.peer = trace_peer_; rk_record.bitrate_bps = bitrate;
                  rk_record.fps = fps; rk_record.inflight = stats_->inflight.load();
                  rk_record.queue = static_cast<int>(queue_.size()););
  wake_.notify_one();
}
void EncoderWorker::Keyframe() {
  ++stats_->keyframe_requests;
  keyframe_ = true;
  wake_.notify_one();
}
void EncoderWorker::Complete(AccessUnit& unit) {
  auto found = inflight_.find(unit.frame_cookie);
  if (found == inflight_.end()) {
    Error("unknown hardware frame completion cookie");
    return;
  }
  auto job = found->second;
  inflight_.erase(found);
  free_.push_back(job.surface);
  --stats_->inflight;
  RK_SERVER_TRACE(trace_, "hardware_complete", TraceIds::Frame(job.frame, true),
                  rk_record.cookie = job.cookie;
                  rk_record.encoder = encoder_; rk_record.peer = trace_peer_;
                  rk_record.bytes = unit.bytes.size();
                  rk_record.inflight = static_cast<int>(inflight_.size()););
  remotekit_rtc_encoded_frame result{};
  result.struct_size = sizeof(result);
  result.annex_b = unit.bytes.data();
  result.size = unit.bytes.size();
  result.width = settings_.width;
  result.height = settings_.height;
  result.rtp_timestamp = job.frame.rtp_timestamp;
  result.capture_time_us = job.frame.capture_time_us;
  result.keyframe = unit.keyframe;
  result.qp = unit.qp;
  uint32_t wire_timestamp = 0;
  RK_SERVER_TRACE(trace_, "encoded_begin", TraceIds::Frame(job.frame, true),
                  rk_record.cookie = job.cookie;
                  rk_record.encoder = encoder_; rk_record.peer = trace_peer_;);
  int status = REMOTEKIT_SDK_BUSY;
  auto send = [&] {
    status = sdk_.remotekit_rtc_encoded(encoder_, &result, &wire_timestamp);
    return status == 0;
  };
  const bool permitted = publish_ ? publish_(job.frame, unit.keyframe, send) : (send(), true);
  if (!permitted) {
    // Hardware Poll has completed: both GPU leases can now follow the normal
    // release path. Dropped bitstream references require a fresh IDR.
    keyframe_ = true;
    ++stats_->dropped;
    if (sdk_.encoder_drop)
      sdk_.encoder_drop(encoder_, job.frame.rtp_timestamp);
  }
  remotekit::TailRefreshLease::Finish(job.frame, status == 0 && unit.keyframe);
  RK_SERVER_TRACE(
      trace_, "encoded_return", TraceIds::Frame(job.frame, true), rk_record.cookie = job.cookie;
      rk_record.encoder = encoder_; rk_record.peer = trace_peer_; rk_record.status = status;
      rk_record.bytes = unit.bytes.size(); rk_record.ids.wire_known = status == 0;
      rk_record.ids.wire_rtp_timestamp = wire_timestamp;);
  if (status == 0 && completed_)
    completed_(wire_timestamp, job.frame.layout_epoch, unit.bytes.size(), unit.keyframe, job.frame);
  if (permitted && status != 0 && status != REMOTEKIT_SDK_INVALID_STATE)
    Error("RTC encoded completion failed " + std::to_string(status));
  if (permitted) {
    ++stats_->completed;
    stats_->bytes += unit.bytes.size();
    if (unit.keyframe)
      ++stats_->keyframes_encoded;
  }
  stats_->last_encode_ms = 1000.0 * (QpcNow() - job.submitted_qpc) / QpcFrequency();
  job.frame.release(job.frame.release_context, job.frame.frame_id);
  static_cast<ID3D11Texture2D*>(job.frame.d3d11_texture)->Release();
  --retained_frames_;
}
void EncoderWorker::Run() {
  while (true) {
    {
      std::unique_lock lock(mutex_);
      if (!stopping_ && queue_.empty() && inflight_.empty())
        wake_.wait_for(lock, std::chrono::milliseconds(5));
      if (stopping_ || failed_) {
        hardware_->CancelPendingRateUpdate();
        break;
      }
    }
    std::optional<RateUpdate> rates;
    {
      std::lock_guard lock(mutex_);
      if (inflight_.empty())
        rates = std::exchange(pending_rates_, std::nullopt);
      if (paused_) {
        hardware_->CancelPendingRateUpdate();
        for (auto& job : queue_) {
          remotekit::TailRefreshLease::Finish(job.frame, false);
          if (sdk_.encoder_drop)
            sdk_.encoder_drop(encoder_, job.frame.rtp_timestamp);
          job.frame.release(job.frame.release_context, job.frame.frame_id);
          static_cast<ID3D11Texture2D*>(job.frame.d3d11_texture)->Release();
          --stats_->pending;
          --retained_frames_;
          ++stats_->paused_drops;
          ++stats_->dropped;
        }
        queue_.clear();
      }
    }
    const auto deadline = hardware_->RateUpdateDeadline();
    const bool deferred_rate_due =
        !paused_ && inflight_.empty() && deadline && std::chrono::steady_clock::now() >= *deadline;
    if (deferred_rate_due && !rates)
      rates = RateUpdate{settings_.bitrate, settings_.fps};
    if (rates && rates->bitrate && rates->fps &&
        (std::min(rates->bitrate, rate_limit_) != settings_.bitrate ||
         std::min(rates->fps, fps_limit_) != settings_.fps || deferred_rate_due)) {
      std::string error;
      const auto effective_rate = std::min(rates->bitrate, rate_limit_);
      const auto effective_fps = std::min(rates->fps, fps_limit_);
      RK_SERVER_TRACE(trace_, "worker_set_rates_begin", TraceIds{}, rk_record.encoder = encoder_;
                      rk_record.peer = trace_peer_; rk_record.bitrate_bps = effective_rate;
                      rk_record.fps = effective_fps; rk_record.queue = stats_->pending.load(););
      const bool applied = hardware_->SetRates(effective_rate, effective_fps, error, rate_limit_);
      RK_SERVER_TRACE(trace_, "worker_set_rates_return", TraceIds{}, rk_record.encoder = encoder_;
                      rk_record.peer = trace_peer_; rk_record.status = applied ? 0 : 1;);
      if (!applied) {
        {
          std::lock_guard lock(stats_->mutex);
          if (auto info = hardware_->LowPowerInfo())
            stats_->qsv_low_power = *info;
          stats_->qsv_rate_control = hardware_->RateControlInfo();
        }
        Error(error);
        break;
      }
      ++stats_->rate_updates;
      if (hardware_->TakeKeyframeRequest())
        keyframe_ = true;
      settings_.bitrate = effective_rate;
      settings_.fps = effective_fps;
      {
        std::lock_guard lock(stats_->mutex);
        auto actual = hardware_->ActualSettings();
        stats_->qsv_rate_control = hardware_->RateControlInfo();
        stats_->applied_bitrate = actual.bitrate;
        stats_->applied_max_bitrate = actual.max_bitrate;
        stats_->applied_fps = actual.fps;
        stats_->actual_level = actual.level_idc;
        if (std::string(hardware_->Name()) == "qsv")
          stats_->applied_target_usage = actual.target_usage;
        if (auto info = hardware_->LowPowerInfo())
          stats_->qsv_low_power = *info;
      }
    }
    // Fill the hardware queue before waiting for completion, preserving real
    // async_depth 2/4 behavior. A bounded host queue drops rather than growing.
    while (!free_.empty() && !paused_) {
      Job job;
      {
        std::lock_guard lock(mutex_);
        if (queue_.empty() || stopping_ || paused_ || pending_rates_)
          break;
        job = queue_.front();
        queue_.pop_front();
        --stats_->pending;
      }
      const auto dequeued = QpcNow();
      stats_->queue_wait_us += static_cast<uint64_t>(
          1000000.0 * std::max<int64_t>(0, dequeued - job.enqueued_qpc) / QpcFrequency());
      ++stats_->queue_wait_samples;
      RK_SERVER_TRACE(trace_, "worker_dequeue", TraceIds::Frame(job.frame, true),
                      rk_record.cookie = job.cookie;
                      rk_record.encoder = encoder_; rk_record.peer = trace_peer_;
                      rk_record.inflight = static_cast<int>(inflight_.size()););
      job.surface = free_.front();
      std::string error;
      if (trace_)
        converter_.SetTraceFrame(TraceIds::Frame(job.frame, true));
      if (!converter_.Convert(static_cast<ID3D11Texture2D*>(job.frame.d3d11_texture),
                              surfaces_[job.surface].Get(), error)) {
        ++stats_->error_drops;
        remotekit::TailRefreshLease::Finish(job.frame, false);
        if (sdk_.encoder_drop)
          sdk_.encoder_drop(encoder_, job.frame.rtp_timestamp);
        ++stats_->dropped;
        if (!converter_.SafeToRelease()) {
          // An unconfirmed VP read cannot return a surface lease to the producer.
          // RenderSlots then retains its state until process/device teardown.
          auto* retained = new Job(job);
          (void)retained;
          surfaces_[job.surface]->AddRef();
          error += "; GPU leases retained until process exit";
        } else {
          job.frame.release(job.frame.release_context, job.frame.frame_id);
          static_cast<ID3D11Texture2D*>(job.frame.d3d11_texture)->Release();
        }
        Error(error);
        break;
      }
      job.submitted_qpc = QpcNow();
      const bool requested_key = keyframe_.exchange(false);
      const bool key = job.key || requested_key;
      auto* input = surfaces_[job.surface].Get();
      auto status = hardware_->Submit(input, key, job.cookie, error);
      RK_SERVER_TRACE(trace_, "hardware_submit", TraceIds::Frame(job.frame, true),
                      rk_record.cookie = job.cookie;
                      rk_record.encoder = encoder_; rk_record.peer = trace_peer_;
                      rk_record.status = static_cast<int>(status););
      if (status == CodecResult::busy) {
        ++stats_->hardware_busy;
        if (key)
          keyframe_ = true;
        // BUSY did not consume the input. Retry this same oldest job before
        // later frames, retaining its original queue age and GPU lease.
        {
          std::lock_guard lock(mutex_);
          queue_.push_front(job);
          ++stats_->pending;
        }
        break;
      }
      if (status != CodecResult::accepted) {
        // Submit errors may follow partial driver submission. Close the backend
        // before releasing this job, just as Run's inflight cancellation does.
        const bool retained = RetainUnsafeInputs(&job);
        hardware_.reset();
        ++stats_->error_drops;
        remotekit::TailRefreshLease::Finish(job.frame, false);
        RK_SERVER_TRACE(trace_, "worker_drop", TraceIds::Frame(job.frame, true),
                        rk_record.reason = "hardware_submit_error";
                        rk_record.cookie = job.cookie; rk_record.encoder = encoder_;);
        if (sdk_.encoder_drop)
          sdk_.encoder_drop(encoder_, job.frame.rtp_timestamp);
        ++stats_->dropped;
        if (!retained) {
          job.frame.release(job.frame.release_context, job.frame.frame_id);
          static_cast<ID3D11Texture2D*>(job.frame.d3d11_texture)->Release();
        }
        Error(error);
        break;
      }
      free_.pop_front();
      inflight_.emplace(job.cookie, job);
      ++stats_->inflight;
      ++stats_->submitted;
      if (key)
        ++stats_->keyframes_submitted;
    }
    if (failed_)
      break;
    if (!inflight_.empty()) {
      AccessUnit unit;
      std::string error;
      auto status = hardware_->Poll(2, unit, error);
      if (status == CodecResult::ready)
        Complete(unit);
      else if (status == CodecResult::error) {
        Error(error);
        break;
      }
    }
  }
  std::vector<AccessUnit> completed;
  std::string error;
  if (hardware_) {
    const bool drained = hardware_->Drain(completed, error);
    for (auto& unit : completed)
      Complete(unit);
    if (!drained && !error.empty())
      Error(error);
  }
  // A backend without a proven cancellation boundary keeps unresolved leases
  // with the quarantined session. Healthy backends close before lease release.
  RetainUnsafeInputs();
  hardware_.reset();
  for (auto& [cookie, job] : inflight_) {
    --stats_->inflight;
    if (failed_)
      ++stats_->error_drops;
    else
      ++stats_->cancelled_drops;
    remotekit::TailRefreshLease::Finish(job.frame, false);
    RK_SERVER_TRACE(trace_, "worker_drop", TraceIds::Frame(job.frame, true),
                    rk_record.reason = "close_inflight";
                    rk_record.cookie = cookie; rk_record.encoder = encoder_;);
    if (sdk_.encoder_drop)
      sdk_.encoder_drop(encoder_, job.frame.rtp_timestamp);
    ++stats_->dropped;
    job.frame.release(job.frame.release_context, job.frame.frame_id);
    static_cast<ID3D11Texture2D*>(job.frame.d3d11_texture)->Release();
  }
  inflight_.clear();
  std::lock_guard lock(mutex_);
  for (auto& job : queue_) {
    --stats_->pending;
    if (failed_)
      ++stats_->error_drops;
    else
      ++stats_->cancelled_drops;
    remotekit::TailRefreshLease::Finish(job.frame, false);
    RK_SERVER_TRACE(trace_, "worker_drop", TraceIds::Frame(job.frame, true),
                    rk_record.reason = "close_pending";
                    rk_record.cookie = job.cookie; rk_record.encoder = encoder_;);
    if (sdk_.encoder_drop)
      sdk_.encoder_drop(encoder_, job.frame.rtp_timestamp);
    ++stats_->dropped;
    job.frame.release(job.frame.release_context, job.frame.frame_id);
    static_cast<ID3D11Texture2D*>(job.frame.d3d11_texture)->Release();
  }
  queue_.clear();
}
EncoderWorker::State EncoderWorker::state() {
  std::lock_guard lock(mutex_);
  if (failed_)
    return State::kFailed;
  if (stopping_)
    return State::kStopping;
  if (!configured_)
    return State::kStopped;
  return paused_ ? State::kPaused : State::kRunning;
}
void EncoderWorker::Stop() {
  {
    std::lock_guard lock(mutex_);
    stopping_ = true;
  }
  wake_.notify_all();
  if (thread_.joinable())
    thread_.join();
  configured_ = false;
  hardware_.reset();
  surfaces_.clear();
  free_.clear();
  retained_frames_ = 0;
}
}  // namespace remotekit::media
