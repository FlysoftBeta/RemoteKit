#include "remotekit/browser/sdk/rtc_internal.h"
using namespace remotekit::rtc;
namespace remotekit::rtc {
class ExternalEncoder : public webrtc::VideoEncoder {
 public:
  ExternalEncoder(uint64_t peer,
                  const remotekit_rtc_options& options,
                  uint32_t level,
                  std::shared_ptr<RequestedPlayoutDelay> playout,
                  std::shared_ptr<SdkTrace> trace,
                  std::shared_ptr<MediaAuthorization> authorization)
      : peer_(peer),
        id_(NewID()),
        options_(options),
        level_(level),
        state_(std::make_shared<EncoderState>()) {
    state_->playout_delay = std::move(playout);
    state_->trace = std::move(trace);
    state_->authorization = std::move(authorization);
    auto& r = GetRegistry();
    std::lock_guard lock(r.mutex);
    r.encoders.emplace(id_, state_);
  }
  ~ExternalEncoder() override { Release(); }
  int InitEncode(const webrtc::VideoCodec* codec, const Settings& settings) override {
    if (!codec || codec->codecType != webrtc::kVideoCodecH264)
      return WEBRTC_VIDEO_CODEC_ERR_PARAMETER;
    if (!created_) {
      {
        std::lock_guard lock(state_->mutex);
        if (!state_->active) {
          id_ = NewID();
          state_->active = true;
          auto& r = GetRegistry();
          std::lock_guard registry_lock(r.mutex);
          r.encoders.emplace(id_, state_);
        }
      }
      if (options_.encoder.create(options_.context, peer_, id_) != 0)
        return WEBRTC_VIDEO_CODEC_ERROR;
      created_ = true;
    }
    remotekit_rtc_encoder_config config{};
    config.struct_size = sizeof(config);
    config.width = codec->width;
    config.height = codec->height;
    config.fps = codec->maxFramerate;
    config.bitrate_bps = codec->startBitrate * 1000u;
    config.max_bitrate_bps = codec->maxBitrate * 1000u;
    config.max_payload_size = static_cast<uint32_t>(settings.max_payload_size);
    config.h264_level_idc = level_;
    std::fprintf(stderr,
                 "RTC encoder configure: peer=%llu encoder=%llu %ux%u fps=%u "
                 "start=%u max=%u level=%u requestedStart=%u requestedMax=%u\n",
                 peer_, id_, config.width, config.height, config.fps, config.bitrate_bps,
                 config.max_bitrate_bps, level_, options_.start_bitrate_bps,
                 options_.max_bitrate_bps);
    const int configured = options_.encoder.configure(options_.context, id_, &config);
    if (configured == 0) {
      std::lock_guard lock(state_->mutex);
      state_->logged_sps = false;
    }
    return configured == 0 ? WEBRTC_VIDEO_CODEC_OK : WEBRTC_VIDEO_CODEC_ERROR;
  }
  int32_t RegisterEncodeCompleteCallback(webrtc::EncodedImageCallback* c) override {
    std::lock_guard lock(state_->mutex);
    state_->callback = c;
    return WEBRTC_VIDEO_CODEC_OK;
  }
  int32_t Release() override {
    {
      std::lock_guard lock(state_->mutex);
      state_->active = false;
      state_->callback = nullptr;
      state_->pending.clear();
    }
    if (created_) {
      created_ = false;
      options_.encoder.destroy(options_.context, id_);
    }
    auto& r = GetRegistry();
    std::lock_guard lock(r.mutex);
    r.encoders.erase(id_);
    return WEBRTC_VIDEO_CODEC_OK;
  }
  int32_t Encode(const webrtc::VideoFrame& frame,
                 const std::vector<webrtc::VideoFrameType>* types) override {
    if (!created_ || frame.video_frame_buffer()->type() != webrtc::VideoFrameBuffer::Type::kNative)
      return WEBRTC_VIDEO_CODEC_ERR_PARAMETER;
    const auto* buffer = static_cast<TextureBuffer*>(frame.video_frame_buffer().get());
    auto input = buffer->frame();
    input.rtp_timestamp = frame.rtp_timestamp();
    {
      std::lock_guard lock(state_->mutex);
      const auto epoch = state_->authorization->epoch.load();
      if (!(epoch & 1) || buffer->authorization() != epoch || state_->pending.size() >= 64 ||
          !state_->pending.emplace(input.rtp_timestamp, epoch).second) {
        if (state_->active && state_->callback)
          state_->callback->OnFrameDropped(input.rtp_timestamp, 0, true);
        return WEBRTC_VIDEO_CODEC_OK;
      }
    }
    state_->trace->Add("encode_enter", id_, &input, input.rtp_timestamp);
    const bool key = types && std::find(types->begin(), types->end(),
                                        webrtc::VideoFrameType::kVideoFrameKey) != types->end();
    if (key && options_.encoder.request_keyframe)
      options_.encoder.request_keyframe(options_.context, id_);
    const int result = options_.encoder.encode(options_.context, id_, &input, key);
    state_->trace->Add("encode_return", id_, &input, input.rtp_timestamp, 0, result);
    if (result != REMOTEKIT_SDK_OK) {
      std::lock_guard lock(state_->mutex);
      if (state_->pending.erase(input.rtp_timestamp) && result == REMOTEKIT_SDK_BUSY &&
          state_->active && state_->callback)
        state_->callback->OnFrameDropped(input.rtp_timestamp, 0, true);
    }
    return result == REMOTEKIT_SDK_OK || result == REMOTEKIT_SDK_BUSY ? WEBRTC_VIDEO_CODEC_OK
                                                                      : WEBRTC_VIDEO_CODEC_ERROR;
  }
  void SetRates(const RateControlParameters& p) override {
    if (last_rate_ != p.bitrate.get_sum_bps() || last_fps_ != p.framerate_fps) {
      std::fprintf(stderr, "RTC encoder rates: encoder=%llu target=%u fps=%.2f timeMs=%lld\n", id_,
                   p.bitrate.get_sum_bps(), p.framerate_fps, webrtc::TimeMillis());
      last_rate_ = p.bitrate.get_sum_bps();
      last_fps_ = p.framerate_fps;
    }
    options_.encoder.set_rates(options_.context, id_, p.bitrate.get_sum_bps(),
                               static_cast<uint32_t>(std::max(0.0, p.framerate_fps)));
  }
  EncoderInfo GetEncoderInfo() const override {
    EncoderInfo info;
    info.implementation_name = "RemoteKit external H264";
    info.supports_native_handle = true;
    info.is_hardware_accelerated = true;
    // External hardware rate control cannot guarantee fast target tracking.
    // Keep WebRTC's frame dropper active to protect against overshoot.
    info.has_trusted_rate_controller = false;
    // Hardware frame QP includes block-level quantization that a slice header
    // alone cannot report. Use WebRTC's H264 quality thresholds.
    info.scaling_settings = ScalingSettings(24, 37);
    info.is_qp_trusted = true;
    info.requested_resolution_alignment = 2;
    info.apply_alignment_to_all_simulcast_layers = true;
    return info;
  }

 private:
  uint64_t peer_, id_;
  remotekit_rtc_options options_;
  uint32_t level_;
  bool created_ = false;
  uint32_t last_rate_ = 0;
  double last_fps_ = 0;
  std::shared_ptr<EncoderState> state_;
};

webrtc::SdpVideoFormat H264Format() {
  // Level 5.2 permits full 4K60 atlases. Negotiation can lower it;
  // configure receives the negotiated level and endpoint must honor it.
  return webrtc::SdpVideoFormat("H264", {{"profile-level-id", "42e034"},
                                         {"level-asymmetry-allowed", "1"},
                                         {"packetization-mode", "1"}});
}
// PeerConnection builds receive channels even for send-only transceivers and
// intersects receive/send codec capabilities when constructing SDP. Preserve
// our declared send level without importing a lower software decoder limit.
class SendOnlyDecoderCapabilities : public webrtc::VideoDecoderFactory {
 public:
  std::vector<webrtc::SdpVideoFormat> GetSupportedFormats() const override {
    return {H264Format()};
  }
  std::unique_ptr<webrtc::VideoDecoder> Create(const webrtc::Environment&,
                                               const webrtc::SdpVideoFormat&) override {
    return nullptr;
  }
};
class ExternalEncoderFactory : public webrtc::VideoEncoderFactory {
 public:
  ExternalEncoderFactory(uint64_t peer,
                         const remotekit_rtc_options& o,
                         std::shared_ptr<RemoteReceiveLimits> remote,
                         std::shared_ptr<RequestedPlayoutDelay> playout,
                         std::shared_ptr<SdkTrace> trace,
                         std::shared_ptr<MediaAuthorization> authorization)
      : peer_(peer),
        options_(o),
        remote_(std::move(remote)),
        playout_(std::move(playout)),
        trace_(std::move(trace)),
        authorization_(std::move(authorization)) {}
  std::vector<webrtc::SdpVideoFormat> GetSupportedFormats() const override {
    return {H264Format()};
  }
  std::unique_ptr<webrtc::VideoEncoder> Create(const webrtc::Environment&,
                                               const webrtc::SdpVideoFormat& f) override {
    const auto profile = webrtc::ParseSdpForH264ProfileLevelId(f.parameters);
    auto mode = f.parameters.find("packetization-mode");
    if (f.name != "H264" || !profile ||
        profile->profile != webrtc::H264Profile::kProfileConstrainedBaseline ||
        mode == f.parameters.end() || mode->second != "1")
      return nullptr;
    const uint32_t receive_level = remote_->h264_level.load();
    if (!receive_level)
      return nullptr;
    return std::make_unique<ExternalEncoder>(
        peer_, options_, std::min(static_cast<uint32_t>(profile->level), receive_level), playout_,
        trace_, authorization_);
  }

 private:
  uint64_t peer_;
  remotekit_rtc_options options_;
  std::shared_ptr<RemoteReceiveLimits> remote_;
  std::shared_ptr<RequestedPlayoutDelay> playout_;
  std::shared_ptr<SdkTrace> trace_;
  std::shared_ptr<MediaAuthorization> authorization_;
};

std::unique_ptr<webrtc::VideoEncoderFactory> MakeVideoEncoders(
    uint64_t peer,
    const remotekit_rtc_options& options,
    std::shared_ptr<RemoteReceiveLimits> remote,
    std::shared_ptr<RequestedPlayoutDelay> playout,
    std::shared_ptr<SdkTrace> trace,
    std::shared_ptr<MediaAuthorization> authorization) {
  return std::make_unique<ExternalEncoderFactory>(peer, options, std::move(remote),
                                                  std::move(playout), std::move(trace),
                                                  std::move(authorization));
}
std::unique_ptr<webrtc::VideoDecoderFactory> MakeVideoDecoders() {
  return std::make_unique<SendOnlyDecoderCapabilities>();
}

}  // namespace remotekit::rtc
int remotekit_rtc_encoded(uint64_t id,
                          const remotekit_rtc_encoded_frame* frame,
                          uint32_t* wire_rtp_timestamp) {
  if (wire_rtp_timestamp)
    *wire_rtp_timestamp = 0;
  if (!frame || frame->struct_size != sizeof(*frame) ||
      !ValidBytes(frame->annex_b, frame->size, kMaxAccessUnit) || !frame->width || !frame->height ||
      frame->width > 16384 || frame->height > 16384 || frame->qp < -1 || frame->qp > 51)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  std::shared_ptr<EncoderState> s;
  {
    auto& r = GetRegistry();
    std::lock_guard lock(r.mutex);
    auto it = r.encoders.find(id);
    if (it != r.encoders.end())
      s = it->second.lock();
  }
  if (!s)
    return REMOTEKIT_SDK_INVALID_STATE;
  s->trace->Add("encoded_begin", id, nullptr, frame->rtp_timestamp, 0, 0, 0,
                frame->capture_time_us);
  std::lock_guard lock(s->mutex);
  if (!s->active || !s->callback)
    return REMOTEKIT_SDK_INVALID_STATE;
  const auto pending = s->pending.extract(frame->rtp_timestamp);
  if (pending.empty())
    return REMOTEKIT_SDK_INVALID_STATE;
  std::lock_guard completion_lock(s->authorization->completion_mutex);
  if (pending.mapped() != s->authorization->epoch.load()) {
    s->callback->OnFrameDropped(frame->rtp_timestamp, 0, true);
    return REMOTEKIT_SDK_INVALID_STATE;
  }
  if (!s->logged_sps) {
    const std::span<const uint8_t> bytes(static_cast<const uint8_t*>(frame->annex_b), frame->size);
    for (size_t i = 0; i + 7 < bytes.size(); ++i) {
      if (bytes[i] != 0 || bytes[i + 1] != 0)
        continue;
      size_t nalu = 0;
      if (bytes[i + 2] == 1)
        nalu = i + 3;
      else if (bytes[i + 2] == 0 && bytes[i + 3] == 1)
        nalu = i + 4;
      if (nalu && (bytes[nalu] & 31) == 7) {
        std::fprintf(stderr,
                     "RTC H264 SPS: encoder=%llu profile-level-id=%02x%02x%02x "
                     "size=%ux%u rtp=%u\n",
                     id, unsigned(bytes[nalu + 1]), unsigned(bytes[nalu + 2]),
                     unsigned(bytes[nalu + 3]), frame->width, frame->height, frame->rtp_timestamp);
        s->logged_sps = true;
        break;
      }
    }
  }
  webrtc::EncodedImage image;
  image.SetEncodedData(
      webrtc::EncodedImageBuffer::Create(static_cast<const uint8_t*>(frame->annex_b), frame->size));
  image._encodedWidth = frame->width;
  image._encodedHeight = frame->height;
  image.SetRtpTimestamp(frame->rtp_timestamp);
  image.capture_time_ms_ = frame->capture_time_us / 1000;
  image._frameType = frame->keyframe ? webrtc::VideoFrameType::kVideoFrameKey
                                     : webrtc::VideoFrameType::kVideoFrameDelta;
  image.qp_ = frame->qp;
  image.content_type_ = webrtc::VideoContentType::SCREENSHARE;
  const uint64_t requested_playout = s->playout_delay->packed.load();
  if (requested_playout != UINT64_MAX) {
    image.SetPlayoutDelay(webrtc::VideoPlayoutDelay(
        webrtc::TimeDelta::Millis(static_cast<int32_t>(requested_playout >> 32)),
        webrtc::TimeDelta::Millis(static_cast<int32_t>(requested_playout & UINT32_MAX))));
  }
  webrtc::CodecSpecificInfo codec{};
  codec.codecType = webrtc::kVideoCodecH264;
  codec.codecSpecific.H264.packetization_mode = webrtc::H264PacketizationMode::NonInterleaved;
  codec.codecSpecific.H264.temporal_idx = webrtc::kNoTemporalIdx;
  codec.codecSpecific.H264.idr_frame = frame->keyframe != 0;
  auto result = s->callback->OnEncodedImage(image, &codec);
  s->trace->Add("encoded_return", id, nullptr, frame->rtp_timestamp,
                result.error == webrtc::EncodedImageCallback::Result::OK ? result.frame_id : 0,
                result.error == webrtc::EncodedImageCallback::Result::OK
                    ? REMOTEKIT_SDK_OK
                    : REMOTEKIT_SDK_INVALID_STATE,
                0, frame->capture_time_us);
  if (result.error == webrtc::EncodedImageCallback::Result::OK && wire_rtp_timestamp)
    *wire_rtp_timestamp = result.frame_id;
  return result.error == webrtc::EncodedImageCallback::Result::OK ? REMOTEKIT_SDK_OK
                                                                  : REMOTEKIT_SDK_INVALID_STATE;
}
int remotekit_rtc_encoder_drop(uint64_t id, uint32_t rtp_timestamp) {
  std::shared_ptr<EncoderState> state;
  {
    auto& registry = GetRegistry();
    std::lock_guard lock(registry.mutex);
    auto it = registry.encoders.find(id);
    if (it != registry.encoders.end())
      state = it->second.lock();
  }
  if (!state)
    return REMOTEKIT_SDK_INVALID_STATE;
  std::lock_guard lock(state->mutex);
  if (!state->active || !state->callback)
    return REMOTEKIT_SDK_INVALID_STATE;
  if (!state->pending.erase(rtp_timestamp))
    return REMOTEKIT_SDK_INVALID_STATE;
  state->trace->Add("encoder_drop", id, nullptr, rtp_timestamp);
  state->callback->OnFrameDropped(rtp_timestamp, 0, true);
  return REMOTEKIT_SDK_OK;
}
int remotekit_rtc_set_playout_delay(uint64_t id, int32_t min_ms, int32_t max_ms) {
  const bool clear = min_ms == -1 && max_ms == -1;
  if (!clear &&
      (min_ms < 0 || max_ms < min_ms || max_ms > 40950 || min_ms % 10 != 0 || max_ms % 10 != 0))
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  const uint64_t packed =
      clear ? UINT64_MAX : (static_cast<uint64_t>(min_ms) << 32) | static_cast<uint32_t>(max_ms);
  return WithPeer(id, [&](Peer& peer) {
    // WithPeer's API lock serializes valid updates and cancellation checks.
    // RTP sender/receiver retain an earlier header limit when later images
    // omit it, so never report a successful clear after an explicit request.
    if (clear)
      return peer.playout_delay->packed.load() == UINT64_MAX ? REMOTEKIT_SDK_OK
                                                             : REMOTEKIT_SDK_INVALID_STATE;
    peer.playout_delay->packed.store(packed);
    return REMOTEKIT_SDK_OK;
  });
}
int remotekit_rtc_get_receive_level(uint64_t id, uint32_t* level_idc) {
  if (!level_idc)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  *level_idc = 0;
  auto peer = FindPeer(id);
  if (!peer || peer->IsClosing())
    return REMOTEKIT_SDK_INVALID_STATE;
  *level_idc = std::min(52u, peer->remote_limits->h264_level.load());
  return REMOTEKIT_SDK_OK;
}
