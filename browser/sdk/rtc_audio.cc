#include "remotekit/browser/sdk/rtc_internal.h"
using namespace remotekit::rtc;
namespace remotekit::rtc {
#include "remotekit/browser/sdk/rtc_silent_audio.h"
class StereoOpusEncoders : public webrtc::AudioEncoderFactory {
 public:
  std::vector<webrtc::AudioCodecSpec> GetSupportedEncoders() override {
    std::vector<webrtc::AudioCodecSpec> specs;
    webrtc::AudioEncoderOpus::AppendSupportedEncoders(&specs);
    for (auto& spec : specs) {
      spec.format.parameters["stereo"] = "1";
      spec.format.parameters["sprop-stereo"] = "1";
    }
    return specs;
  }
  std::optional<webrtc::AudioCodecInfo> QueryAudioEncoder(
      const webrtc::SdpAudioFormat& format) override {
    auto config = webrtc::AudioEncoderOpus::SdpToConfig(format);
    if (!config || config->num_channels != 2)
      return std::nullopt;
    return webrtc::AudioEncoderOpus::QueryAudioEncoder(*config);
  }
  std::unique_ptr<webrtc::AudioEncoder> Create(const webrtc::Environment& env,
                                               const webrtc::SdpAudioFormat& format,
                                               Options options) override {
    auto config = webrtc::AudioEncoderOpus::SdpToConfig(format);
    if (!config || config->num_channels != 2)
      return nullptr;
    config->application = webrtc::AudioEncoderOpusConfig::ApplicationMode::kAudio;
    return webrtc::AudioEncoderOpus::MakeAudioEncoder(env, *config, options);
  }
};
// WebRTC validates receive codec parameters even for a sendonly answer. As
// with the video capability factory, describe Opus but never create a decoder;
// authenticated remote sending directions are rejected before applying SDP.
class SendOnlyAudioDecoderCapabilities : public webrtc::AudioDecoderFactory {
 public:
  std::vector<webrtc::AudioCodecSpec> GetSupportedDecoders() override {
    std::vector<webrtc::AudioCodecSpec> specs;
    webrtc::AudioEncoderOpus::AppendSupportedEncoders(&specs);
    for (auto& spec : specs) {
      spec.format.parameters["stereo"] = "1";
      spec.format.parameters["sprop-stereo"] = "1";
    }
    return specs;
  }
  bool IsSupportedDecoder(const webrtc::SdpAudioFormat& format) override {
    return format.name == "opus" && format.clockrate_hz == 48000 && format.num_channels == 2;
  }
  std::unique_ptr<webrtc::AudioDecoder> Create(const webrtc::Environment&,
                                               const webrtc::SdpAudioFormat&) override {
    return nullptr;
  }
};

webrtc::scoped_refptr<webrtc::AudioEncoderFactory> MakeAudioEncoders() {
  return webrtc::make_ref_counted<StereoOpusEncoders>();
}
webrtc::scoped_refptr<webrtc::AudioDecoderFactory> MakeAudioDecoders() {
  return webrtc::make_ref_counted<SendOnlyAudioDecoderCapabilities>();
}
webrtc::scoped_refptr<webrtc::AudioDeviceModule> MakeAudioDevice() {
  return webrtc::make_ref_counted<SilentAudioDevice>();
}

}  // namespace remotekit::rtc
int remotekit_rtc_submit_audio(uint64_t id,
                               const int16_t* pcm,
                               uint32_t frames,
                               uint64_t generation,
                               uint64_t sequence,
                               uint64_t sample_index,
                               int64_t first_sample_qpc,
                               uint32_t discontinuity) {
  if (!pcm || frames != 480 || !generation || !sequence || sample_index % 480 ||
      first_sample_qpc <= 0 || discontinuity > 1)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  auto peer = FindPeer(id);
  if (!peer)
    return REMOTEKIT_SDK_INVALID_STATE;
  const auto authorization = peer->authorization->epoch.load();
  if (!(authorization & 1))
    return REMOTEKIT_SDK_INVALID_STATE;
  webrtc::scoped_refptr<PageAudioSource> source;
  {
    std::lock_guard lock(peer->api_mutex);
    if (peer->closing.load() || !peer->audio_source)
      return REMOTEKIT_SDK_INVALID_STATE;
    source = peer->audio_source;
  }
  std::lock_guard lock(peer->audio_mutex);
  if (peer->closing.load() || peer->authorization->epoch.load() != authorization)
    return REMOTEKIT_SDK_INVALID_STATE;
  if (!peer->audio_enabled)
    return REMOTEKIT_SDK_OK;
  const auto advance = peer->audio_timeline.Plan(generation, sequence, sample_index,
                                                 first_sample_qpc, discontinuity != 0);
  if (advance.step == remotekit::AudioStep::reject)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  LARGE_INTEGER qpc, frequency;
  QueryPerformanceCounter(&qpc);
  QueryPerformanceFrequency(&frequency);
  const int64_t delta_us = static_cast<int64_t>(
      static_cast<long double>(qpc.QuadPart - first_sample_qpc) * 1000000 / frequency.QuadPart);
  if (delta_us < -100000 || delta_us > 1000000)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  const bool new_clock = peer->audio_clock_generation != generation;
  const int64_t mapped_capture_ms = (webrtc::TimeMicros() - delta_us) / 1000;
  const int64_t capture_ms =
      new_clock ? mapped_capture_ms
                : peer->audio_origin_capture_ms +
                      static_cast<int64_t>((sample_index - peer->audio_origin_sample) / 48);
  // Reject incoherent/overflow-sized sample positions before WebRTC computes
  // RTP deltas. The disciplined source clock and same-machine QPC agree.
  if (std::abs(capture_ms - mapped_capture_ms) > 20)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  if (advance.step == remotekit::AudioStep::restart_gap ||
      advance.step == remotekit::AudioStep::restart_epoch ||
      advance.step == remotekit::AudioStep::restart_discontinuity) {
    // ChannelSend::StartSend sets first_frame_, which advances its existing
    // RTP clock by the absolute capture-time gap instead of compressing it.
    const int status = peer->signaling->BlockingCall([&] {
      if (peer->closing.load() || !peer->audio_sender)
        return REMOTEKIT_SDK_INVALID_STATE;
      auto parameters = peer->audio_sender->GetParameters();
      for (auto& encoding : parameters.encodings)
        encoding.active = false;
      if (!peer->audio_sender->SetParameters(parameters).ok())
        return REMOTEKIT_SDK_INVALID_STATE;
      return peer->ApplySenderActivity(peer->authorization->epoch.load() & 1)
                 ? REMOTEKIT_SDK_OK
                 : REMOTEKIT_SDK_INVALID_STATE;
    });
    if (status != REMOTEKIT_SDK_OK)
      return status;
    if (advance.step == remotekit::AudioStep::restart_gap) {
      ++peer->audio_restarts_gap;
      peer->audio_last_restart = 1;
    } else if (advance.step == remotekit::AudioStep::restart_epoch) {
      ++peer->audio_restarts_epoch;
      peer->audio_last_restart = 2;
    } else {
      ++peer->audio_restarts_discontinuity;
      peer->audio_last_restart = 3;
    }
  }
  if (advance.silence_blocks) {
    const int16_t silence[960]{};
    for (uint32_t i = advance.silence_blocks; i > 0; --i)
      source->Submit(silence, capture_ms - i * 10);
    peer->audio_silence_blocks += advance.silence_blocks;
  }
  source->Submit(pcm, capture_ms);
  peer->audio_timeline.Commit(generation, sequence, sample_index, first_sample_qpc);
  if (new_clock) {
    peer->audio_clock_generation = generation;
    peer->audio_origin_sample = sample_index;
    peer->audio_origin_capture_ms = capture_ms;
  }
  return REMOTEKIT_SDK_OK;
}
