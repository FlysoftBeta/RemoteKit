#include "util/log.hpp"
#include "media/audio.hpp"
#include "diagnostics/timing.hpp"
#include "rtc/authorization.hpp"
#include "rtc/peer.hpp"
namespace remotekit {
using ConnectionPhase = ConnectionTiming::ConnectionPhase;
using Event = RtcEvent;
Result<void> AudioOutput::OpenAudio() {
  const uint64_t generation = static_cast<uint64_t>(QpcNow());
  const std::string name =
      "Local\\RemoteKit.audio." + browser.Incarnation() + "." + std::to_string(generation);
  auto mapped = audio_ring.Open(name, generation, std::stoull(id));
  if (!mapped)
    return mapped.error();
  {
    {
      auto audio_open_result = browser.Rpc().Request({{"method", "audio.open"},
                                                      {"mapping", name},
                                                      {"generation", std::to_string(generation)},
                                                      {"session", id}});
      if (!audio_open_result) {
        const Error operation_error = audio_open_result.error();
        audio_ring.Close();
        return operation_error;
      }
    }
  }

  audio_gaps = 0;
  audio_submitted = 0;
  audio_rejected = 0;
  state = State::kRunning;
  audio_thread = std::thread([this, generation] {
    RunThread(
        "audio",
        [this, generation] {
          uint64_t gaps = 0, stale = 0;
          while (state == State::kRunning) {
            remotekit::AudioPacket packet{};
            if (!audio_ring.Poll(packet, gaps)) {
              std::this_thread::sleep_for(std::chrono::milliseconds(2));
              continue;
            }
            audio_gaps = gaps + stale;
            const auto handle = peer_controller.Handle();
            const auto stamp = authorization.Stamp();
            if (!handle || !stamp || !peer_controller.Connected() ||
                packet.first_sample_qpc < authorization.AudioAfter())
              continue;
            // Bound age independently of the video encoder and never await its queue.
            if (QpcNow() - packet.first_sample_qpc > QpcFrequency() / 20) {
              ++stale;
              audio_gaps = gaps + stale;
              continue;
            }
            if (!authorization.Current(stamp))
              continue;
            const int status = sdk.remotekit_rtc_submit_audio(
                handle, packet.pcm, 480, generation, packet.sequence, packet.sample_index,
                packet.first_sample_qpc, packet.discontinuity);
            if (status == 0)
              ++audio_submitted;
            else
              ++audio_rejected;
          }
        },
        [this] {
          state = State::kFailed;
          ++audio_rejected;
        });
  });

  return {};
}
}  // namespace remotekit

namespace remotekit {

void AudioOutput::Stop() {
  const bool had_audio = audio_ring.IsOpen();
  state = State::kStopping;
  if (audio_thread.joinable())
    audio_thread.join();
  if (had_audio && browser.Rpc().Control() && browser.Alive()) {
    auto closed = browser.Rpc().Request({{"method", "audio.close"}});
    if (!closed)
      LogError(LogLevel::kWarn, "audio.close_failed", closed.error());
  }
  audio_ring.Close();
  state = State::kStopped;
}
Json AudioOutput::Snapshot() const {
  return {{"submitted", audio_submitted.load()},
          {"gaps", audio_gaps.load()},
          {"rejected", audio_rejected.load()}};
}

}  // namespace remotekit
