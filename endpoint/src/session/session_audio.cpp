#include "session/session.hpp"
namespace remotekit {
Result<void> Session::OpenAudio() {
  const uint64_t generation = static_cast<uint64_t>(QpcNow());
  const std::string name =
      "Local\\RemoteKit.audio." + browser.Incarnation() + "." + std::to_string(generation);
  audio_ring.Open(name, generation, std::stoull(id));
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
  stop_audio = false;
  audio_thread = std::thread([this, generation] {
    RunThread(
        "audio",
        [this, generation] {
          uint64_t gaps = 0, stale = 0;
          while (!stop_audio.load()) {
            remotekit::AudioPacket packet{};
            if (!audio_ring.Poll(packet, gaps)) {
              std::this_thread::sleep_for(std::chrono::milliseconds(2));
              continue;
            }
            audio_gaps = gaps + stale;
            const auto handle = peer.load();
            const auto stamp = authorization.Stamp();
            if (!handle || !stamp || !rtc_connected.load() ||
                packet.first_sample_qpc < audio_authorized_after.load())
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
          stop_audio = true;
          ++audio_rejected;
        });
  });

  return {};
}
}  // namespace remotekit
