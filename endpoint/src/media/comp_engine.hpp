#pragma once
#include <optional>
#include "media/comp_pacing.hpp"
#include "media/comp_recovery.hpp"
#include "media/encoder_set.hpp"
#include "media/idle_keepalive.hpp"
#include "media/presentation_refresh.hpp"
#include "media/render_slots.hpp"
#include "media/sampling.hpp"
#include "media/tail_refresh.hpp"

namespace remotekit::media {
struct CompConfig {
  uint32_t idle_idr_ms;
  uint32_t max_encode_width, max_encode_height;
};
struct CompStream {
  uint64_t peer = 0;
  uint32_t receive_level = 0;
  uint64_t scope = 0;
  bool output_open = false;
};
struct CompFailure {
  Error error;
  const char* invalidation;
};
class CompHost {
 public:
  struct Layout {
    uint64_t epoch;
    bool has_current_view;
  };
  virtual Layout ObserveLayout(const SharedAtlasFrame&) = 0;
  virtual std::optional<PresentationBarrier::Key> RefreshKey(uint64_t peer) = 0;
  virtual void Invalidate(const char* reason) = 0;
  enum class Milestone { source_frame, submit };
  virtual void Reached(Milestone) = 0;
  // Revalidate revocation and shutdown after GPU observation.
  virtual bool Current(uint64_t scope) = 0;
  virtual bool CanBegin() = 0;

 protected:
  ~CompHost() = default;
};
class CompEngine {
 public:
  CompEngine(Sdk&, RenderSlots&, EncoderSet&, std::shared_ptr<ServerTrace>, CompConfig);
  ~CompEngine();
  void Rates(uint32_t bitrate, uint32_t fps);
  void InputReceived(int64_t qpc);
  void RequestRefresh();
  void SetPolicy(uint32_t max_fps, uint32_t degradation);
  void Wake();
  void ResetInputs();
  std::optional<CompFailure> StartGeneration();
  void StopGeneration();
  void ResetStream();
  // Keep restriction sampling ahead of the host's queued RTC transitions.
  std::optional<CompFailure> UpdateCadence(const CompStream&);
  std::optional<CompFailure> Step(const CompStream&, CompHost&);
  std::optional<CompFailure> Wait(const CompStream&);
  struct CompDiagnostics {
    uint32_t targetFps = 0, resumeMaxFps = 0, officialMaxFps = 0, codecMaxFps = 0, sourceWidth = 0,
             sourceHeight = 0, encodedWidth = 0, encodedHeight = 0;
    uint64_t adaptRequests = 0, adaptDrops = 0, adaptErrors = 0, adaptSizeChanges = 0;
    remotekit::PresentationRefresh::Stats refresh;
  };

  struct Snapshot {
    CompDiagnostics comp;
    MediaSampling sampling;
    uint32_t sampling_fps, effective_idle_ms, max_fps, degradation;
    int64_t iteration_qpc;
    double source_interval_ms, last_tail_age_ms;
    uint64_t tail_submissions, tail_completions;
  };
  Snapshot Diagnostics() const;

 private:
  CompFailure Failure(std::string message, const char* reason);
  void ObserveWake();
  void UpdateRefresh(const CompStream&, CompHost&, double now_ms);
  void SetSampling(MediaSampling value);
  Sdk& sdk;
  RenderSlots& slots;
  EncoderSet& encoders;
  std::shared_ptr<ServerTrace> trace;
  const CompConfig config;
  HANDLE pace_timer = nullptr, input_event = nullptr;
  CompBeginSchedule begin_schedule;
  CompCadence cadence;
  CompRecoverySampling recovery;
  IdleIdrPolicy idle;
  IdleKeepalive keepalive;
  PresentationRefresh presentation_refresh;
  std::shared_ptr<TailIdrAttempt> tail_attempt;
  uint64_t observed_wakes = 0;
  uint32_t official_max_fps = 240, codec_max_fps = 240;
  bool has_current_view = false, first_source = true, first_submit = true;
  double next_tail_attempt_ms = 0;
  uint32_t tail_begins = 0;
  static constexpr double tail_retry_ms = 250;
  std::atomic<uint32_t> comp_bitrate{1}, comp_fps{60};
  std::atomic<uint32_t> policy_max_fps{60}, policy_degradation{REMOTEKIT_RTC_BALANCED};
  std::atomic<int64_t> last_input_qpc{0}, iteration_qpc{0};
  std::atomic<bool> refresh_connected{false};
  mutable std::mutex comp_diagnostics_mutex;
  CompDiagnostics comp_diagnostics;
  std::atomic<uint32_t> sampling_fps{60}, effective_idle_ms{150};
  std::atomic<double> source_interval_ms{0}, last_tail_age_ms{0};
  std::atomic<uint64_t> tail_submissions{0}, tail_completions{0};
  mutable std::mutex sampling_mutex;
  MediaSampling sampling;
};
}  // namespace remotekit::media
