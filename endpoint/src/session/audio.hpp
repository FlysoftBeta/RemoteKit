#pragma once
#include "media/audio_ring.hpp"
#include "rtc/authorization.hpp"
#include "rtc/peer.hpp"
#include "session/context.hpp"
namespace remotekit {
class PeerController;
class AuthorizationController;
class AudioOutput : private ControllerContext {
 public:
  ~AudioOutput() { Stop(); }
  enum class State { kStopped, kRunning, kStopping, kFailed };
  State GetState() const { return state.load(); }
  AudioOutput(ControllerContext context,
              PeerController& peer_controller,
              AuthorizationController& authorization)
      : ControllerContext(context),
        peer_controller(peer_controller),
        authorization(authorization) {}
  void Stop();
  Json Snapshot() const;
  Result<void> OpenAudio();

 private:
  PeerController& peer_controller;
  AuthorizationController& authorization;
  AudioRing audio_ring;
  std::thread audio_thread;
  std::atomic<State> state{State::kStopped};
  std::atomic<uint64_t> audio_gaps{0}, audio_submitted{0}, audio_rejected{0};
};
}  // namespace remotekit
