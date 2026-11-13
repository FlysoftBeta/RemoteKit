#pragma once
#include "media/comp_engine.hpp"
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
class MediaPipeline : private ControllerContext, private media::CompHost {
 public:
  ~MediaPipeline() { Join(); }
  enum class State { kStopped, kRunning, kStopping, kFailed };
  State GetState() const { return state.load(); }
  MediaPipeline(ControllerContext,
                PeerController&,
                AuthorizationController&,
                PresentationController&,
                OutputController&,
                EncoderRegistry&,
                ConnectionTiming&,
                Diagnostics&);
  void Start();
  bool Join();
  void Wake();
  void InputReceived(int64_t qpc);
  void Queue(const RtcEvent& event);
  void Refresh();
  void RequestRefresh(const RtcEvent& event);
  void Rates(uint32_t bitrate, uint32_t fps);
  void Reset();
  bool Audio() const { return policy_audio; }
  uint32_t MaxFps() const { return engine.Diagnostics().max_fps; }
  uint32_t Degradation() const { return engine.Diagnostics().degradation; }
  Json Snapshot();
  MediaSampling Sampling() const;
  void MediaLoop();
  uint32_t SamplingFps() const;
  Result<Json> ApplyMediaPolicy(const Json& request);

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
  std::atomic<bool> policy_audio{true};

  std::atomic<int64_t> last_media_refresh_qpc{0};
  media::CompEngine engine;
  bool has_current_view = false;
  Layout ObserveLayout(const SharedAtlasFrame&) override;
  std::optional<PresentationBarrier::Key> RefreshKey(uint64_t peer) override;
  void Invalidate(const char* reason) override;
  void Reached(Milestone) override;
  bool Current(uint64_t scope) override;
  bool CanBegin() override;
  void Failed(media::CompFailure failure);

 public:
  media::CompEngine::CompDiagnostics DiagnosticsSnapshot() const {
    return engine.Diagnostics().comp;
  }

 private:
  std::thread media_thread;
  std::atomic<State> state{State::kStopped};
  std::mutex event_mutex;
  std::condition_variable event_wake;
  std::deque<RtcEvent> events;
};
}  // namespace remotekit
