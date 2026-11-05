#pragma once
#include "remotekit/presentation_refresh.hpp"
#include "remotekit/comp_pacing.hpp"
#include "remotekit/idle_idr.hpp"
#include "remotekit/tail_refresh.hpp"
#include "remotekit/sampling.hpp"
#include "rtc/event.hpp"
#include "session/context.hpp"
namespace remotekit {
class PeerController;
class AuthorizationController;
class PresentationController;
class OutputController;
class EncoderRegistry;
class ConnectionTiming;
class Diagnostics;
class MediaPipeline : private ControllerContext {
 public:
  ~MediaPipeline() { Join(); }
  enum class State { kStopped, kRunning, kStopping, kFailed };
  State GetState() const { return state.load(); }
  MediaPipeline(ControllerContext context,
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
        diagnostics(diagnostics) {}
  void Start();
  bool Join();
  void Wake();
  void Queue(const RtcEvent& event);
  void Refresh();
  void RequestRefresh(const RtcEvent& event);
  void Rates(uint32_t bitrate, uint32_t fps);
  void Reset();
  uint32_t MaxFps() const { return policy_max_fps; }
  uint32_t Degradation() const { return policy_degradation; }
  Json Snapshot();
  MediaSampling Sampling() const;
  void SetSampling(MediaSampling value);
  void MediaLoop();
  uint32_t SamplingFps() const;
  Result<Json> ManageSessionMediaPolicy(const Json& request);

 private:
  PeerController& peer_controller;
  AuthorizationController& authorization;
  PresentationController& presentation;
  OutputController& output;
  EncoderRegistry& registry;
  ConnectionTiming& timing;
  Diagnostics& diagnostics;
  std::mutex media_policy_mutex;
  Json requested_media_policy = nullptr;
  std::atomic<uint32_t> policy_max_fps{60}, policy_degradation{REMOTEKIT_RTC_BALANCED};

  std::atomic<bool> refresh_connected{false};
  std::atomic<int64_t> last_media_refresh_qpc{0};
  // MediaLoop snapshots the policy once per iteration so layout and texture
  // submission cannot use different sampling budgets during a policy update.
 public:
  struct CompDiagnostics {
    uint32_t targetFps = 0, resumeMaxFps = 0, officialMaxFps = 0, codecMaxFps = 0, sourceWidth = 0,
             sourceHeight = 0, encodedWidth = 0, encodedHeight = 0;
    uint64_t adaptRequests = 0, adaptDrops = 0, adaptErrors = 0, adaptSizeChanges = 0;
    remotekit::PresentationRefresh::Stats refresh;
  };
  CompDiagnostics DiagnosticsSnapshot() const {
    std::lock_guard lock(comp_diagnostics_mutex);
    return comp_diagnostics;
  }

 private:
  mutable std::mutex comp_diagnostics_mutex;
  CompDiagnostics comp_diagnostics;
  uint32_t sampling_fps = 60;

  std::atomic<uint32_t> effective_idle_ms{150};
  std::atomic<double> source_interval_ms{0}, last_tail_age_ms{0};
  std::atomic<uint64_t> tail_submissions{0}, tail_completions{0};
  mutable std::mutex sampling_mutex;
  remotekit::MediaSampling sampling;

  std::thread media_thread;
  std::atomic<State> state{State::kStopped};
  std::atomic<uint32_t> comp_bitrate{1}, comp_fps{60};
  std::mutex event_mutex;
  std::condition_variable event_wake;
  std::deque<RtcEvent> events;
};
}  // namespace remotekit
