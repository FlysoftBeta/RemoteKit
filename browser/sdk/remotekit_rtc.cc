#include "remotekit/sdk/include/remotekit_rtc.h"

#include <winsock2.h>
#include <d3d11.h>
#include <wrl/client.h>

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cmath>
#include <cstdio>
#include <functional>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <span>
#include <type_traits>
#include <utility>
#include <vector>

#include "base/no_destructor.h"
#include "base/environment.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/process/process_handle.h"
#include "base/json/json_writer.h"
#include "base/time/time.h"
#include "base/values.h"
#include "third_party/webrtc/api/audio/audio_device.h"
#include "third_party/webrtc/api/audio_codecs/audio_decoder_factory.h"
#include "third_party/webrtc/api/audio_codecs/audio_encoder_factory.h"
#include "third_party/webrtc/api/create_modular_peer_connection_factory.h"
#include "third_party/webrtc/api/enable_media.h"
#include "third_party/webrtc/api/environment/environment_factory.h"
#include "third_party/webrtc/api/jsep.h"
#include "third_party/webrtc/api/make_ref_counted.h"
#include "third_party/webrtc/api/peer_connection_interface.h"
#include "third_party/webrtc/api/rtp_transceiver_interface.h"
#include "third_party/webrtc/api/set_local_description_observer_interface.h"
#include "third_party/webrtc/api/set_remote_description_observer_interface.h"
#include "third_party/webrtc/api/stats/rtc_stats_collector_callback.h"
#include "third_party/webrtc/api/stats/rtcstats_objects.h"
#include "third_party/webrtc/api/video/adapted_video_track_source.h"
#include "third_party/webrtc/api/video/encoded_image.h"
#include "third_party/webrtc/api/video/i420_buffer.h"
#include "third_party/webrtc/api/video_codecs/h264_profile_level_id.h"
#include "third_party/webrtc/api/video_codecs/video_encoder_factory.h"
#include "third_party/webrtc/api/video_codecs/video_decoder_factory.h"
#include "third_party/webrtc/modules/video_coding/include/video_error_codes.h"
#include "third_party/webrtc/modules/video_coding/include/video_codec_interface.h"
#include "third_party/webrtc/pc/session_description.h"
#include "third_party/webrtc/rtc_base/ssl_adapter.h"
#include "third_party/webrtc/rtc_base/thread.h"
#include "third_party/webrtc/rtc_base/time_utils.h"

int RemoteKitSdkBeginRtc();
void RemoteKitSdkEndRtc();

namespace {
#include "remotekit/browser/sdk/rtc_silent_audio.h"
#include "remotekit/browser/sdk/rtc_trace.h"

constexpr size_t kMaxMessage = 1024 * 1024;
constexpr size_t kMaxAccessUnit = 32 * 1024 * 1024;
using webrtc::scoped_refptr;

class EmptyAudioEncoders : public webrtc::AudioEncoderFactory {
 public:
  std::vector<webrtc::AudioCodecSpec> GetSupportedEncoders() override { return {}; }
  std::optional<webrtc::AudioCodecInfo> QueryAudioEncoder(
      const webrtc::SdpAudioFormat&) override { return std::nullopt; }
  std::unique_ptr<webrtc::AudioEncoder> Create(const webrtc::Environment&,
      const webrtc::SdpAudioFormat&, Options) override { return nullptr; }
};
class EmptyAudioDecoders : public webrtc::AudioDecoderFactory {
 public:
  std::vector<webrtc::AudioCodecSpec> GetSupportedDecoders() override { return {}; }
  bool IsSupportedDecoder(const webrtc::SdpAudioFormat&) override { return false; }
  std::unique_ptr<webrtc::AudioDecoder> Create(const webrtc::Environment&,
      const webrtc::SdpAudioFormat&) override { return nullptr; }
};

struct LeaseTracker {
  std::mutex mutex;
  std::condition_variable done;
  size_t active = 0;
};
class TextureBuffer : public webrtc::VideoFrameBuffer {
 public:
  TextureBuffer(const remotekit_rtc_frame& frame, std::shared_ptr<LeaseTracker> tracker)
      : frame_(frame), tracker_(std::move(tracker)) {
    { std::lock_guard lock(tracker_->mutex); ++tracker_->active; }
    texture_ = static_cast<ID3D11Texture2D*>(frame.d3d11_texture);
  }
  ~TextureBuffer() override {
    texture_.Reset();
    frame_.release(frame_.release_context, frame_.frame_id);
    { std::lock_guard lock(tracker_->mutex); --tracker_->active; }
    tracker_->done.notify_all();
  }
  Type type() const override { return Type::kNative; }
  int width() const override { return static_cast<int>(frame_.width); }
  int height() const override { return static_cast<int>(frame_.height); }
  scoped_refptr<webrtc::I420BufferInterface> ToI420() override { return nullptr; }
  const remotekit_rtc_frame& frame() const { return frame_; }
 private:
  remotekit_rtc_frame frame_;
  Microsoft::WRL::ComPtr<ID3D11Texture2D> texture_;
  std::shared_ptr<LeaseTracker> tracker_;
};

class TextureSource : public webrtc::AdaptedVideoTrackSource {
 public:
  TextureSource(std::shared_ptr<LeaseTracker> tracker, std::function<void()> refresh)
      : tracker_(std::move(tracker)), refresh_(std::move(refresh)) {}
  SourceState state() const override { return kLive; }
  bool remote() const override { return false; }
  bool is_screencast() const override { return true; }
  std::optional<bool> needs_denoising() const override { return false; }
  void RequestRefreshFrame() override { refresh_(); }
  void Submit(const remotekit_rtc_frame& input, int64_t media_timestamp_us) {
    OnFrame(webrtc::VideoFrame::Builder()
        .set_video_frame_buffer(webrtc::make_ref_counted<TextureBuffer>(input, tracker_))
        .set_timestamp_us(media_timestamp_us)
        .set_rotation(webrtc::kVideoRotation_0).build());
  }
 private:
  std::shared_ptr<LeaseTracker> tracker_;
  std::function<void()> refresh_;
};

struct RequestedPlayoutDelay {
  // One atomic preserves min/max as a coherent pair across setter/encode.
  std::atomic<uint64_t> packed{UINT64_MAX};
};
struct EncoderState {
  std::mutex mutex;
  webrtc::EncodedImageCallback* callback = nullptr;
  bool active = true;
  bool logged_sps = false;
  std::shared_ptr<RequestedPlayoutDelay> playout_delay;
  std::shared_ptr<SdkTrace> trace;
};
struct RemoteReceiveLimits {
  std::atomic<uint32_t> h264_level{51};
};
class Peer;
struct Registry {
  std::mutex mutex;
  uint64_t next = 1;
  std::map<uint64_t, std::shared_ptr<Peer>> peers;
  std::map<uint64_t, std::weak_ptr<EncoderState>> encoders;
};
Registry& GetRegistry() { static base::NoDestructor<Registry> r; return *r; }
uint64_t NewID() {
  auto& r = GetRegistry();
  std::lock_guard lock(r.mutex);
  return r.next++;
}

class ExternalEncoder : public webrtc::VideoEncoder {
 public:
  ExternalEncoder(uint64_t peer, const remotekit_rtc_options& options,
                  uint32_t level, std::shared_ptr<RequestedPlayoutDelay> playout,
                  std::shared_ptr<SdkTrace> trace)
      : peer_(peer), id_(NewID()), options_(options), level_(level),
        state_(std::make_shared<EncoderState>()) {
    state_->playout_delay = std::move(playout);
    state_->trace = std::move(trace);
    auto& r = GetRegistry();
    std::lock_guard lock(r.mutex);
    r.encoders.emplace(id_, state_);
  }
  ~ExternalEncoder() override { Release(); }
  int InitEncode(const webrtc::VideoCodec* codec,
                 const Settings& settings) override {
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
    std::fprintf(stderr, "RTC encoder configure: peer=%llu encoder=%llu %ux%u fps=%u "
        "start=%u max=%u level=%u requestedStart=%u requestedMax=%u\n",
        peer_, id_, config.width, config.height, config.fps, config.bitrate_bps,
        config.max_bitrate_bps, level_, options_.start_bitrate_bps, options_.max_bitrate_bps);
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
    if (!created_ || frame.video_frame_buffer()->type() !=
                         webrtc::VideoFrameBuffer::Type::kNative)
      return WEBRTC_VIDEO_CODEC_ERR_PARAMETER;
    auto input = static_cast<TextureBuffer*>(frame.video_frame_buffer().get())->frame();
    input.rtp_timestamp = frame.rtp_timestamp();
    state_->trace->Add("encode_enter", id_, &input, input.rtp_timestamp);
    const bool key = types && std::find(types->begin(), types->end(),
        webrtc::VideoFrameType::kVideoFrameKey) != types->end();
    if (key && options_.encoder.request_keyframe)
      options_.encoder.request_keyframe(options_.context, id_);
    const int result = options_.encoder.encode(options_.context, id_, &input, key);
    state_->trace->Add("encode_return", id_, &input, input.rtp_timestamp, 0, result);
    if (result == REMOTEKIT_SDK_BUSY) {
      std::lock_guard lock(state_->mutex);
      if (state_->active && state_->callback)
        state_->callback->OnFrameDropped(input.rtp_timestamp, 0, true);
      return WEBRTC_VIDEO_CODEC_OK;
    }
    return result == 0 ? WEBRTC_VIDEO_CODEC_OK : WEBRTC_VIDEO_CODEC_ERROR;
  }
  void SetRates(const RateControlParameters& p) override {
    if (last_rate_ != p.bitrate.get_sum_bps() || last_fps_ != p.framerate_fps) {
      std::fprintf(stderr, "RTC encoder rates: encoder=%llu target=%u fps=%.2f timeMs=%lld\n",
          id_, p.bitrate.get_sum_bps(), p.framerate_fps, webrtc::TimeMillis());
      last_rate_ = p.bitrate.get_sum_bps(); last_fps_ = p.framerate_fps;
    }
    options_.encoder.set_rates(options_.context, id_,
        p.bitrate.get_sum_bps(), static_cast<uint32_t>(std::max(0.0, p.framerate_fps)));
  }
  EncoderInfo GetEncoderInfo() const override {
    EncoderInfo info;
    info.implementation_name = "RemoteKit external H264";
    info.supports_native_handle = true;
    info.is_hardware_accelerated = true;
    info.has_trusted_rate_controller = true;
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
      {"level-asymmetry-allowed", "1"}, {"packetization-mode", "1"}});
}
// PeerConnection builds receive channels even for send-only transceivers and
// intersects receive/send codec capabilities when constructing SDP. Preserve
// our declared send level without importing a lower software decoder limit.
// This SDK does not expose a receiving video track or decoder implementation.
class SendOnlyDecoderCapabilities : public webrtc::VideoDecoderFactory {
 public:
  std::vector<webrtc::SdpVideoFormat> GetSupportedFormats() const override {
    return {H264Format()};
  }
  std::unique_ptr<webrtc::VideoDecoder> Create(const webrtc::Environment&,
      const webrtc::SdpVideoFormat&) override { return nullptr; }
};
class ExternalEncoderFactory : public webrtc::VideoEncoderFactory {
 public:
  ExternalEncoderFactory(uint64_t peer, const remotekit_rtc_options& o,
                         std::shared_ptr<RemoteReceiveLimits> remote,
                         std::shared_ptr<RequestedPlayoutDelay> playout,
                         std::shared_ptr<SdkTrace> trace)
      : peer_(peer), options_(o), remote_(std::move(remote)), playout_(std::move(playout)),
        trace_(std::move(trace)) {}
  std::vector<webrtc::SdpVideoFormat> GetSupportedFormats() const override {
    return {H264Format()};
  }
  std::unique_ptr<webrtc::VideoEncoder> Create(const webrtc::Environment&,
      const webrtc::SdpVideoFormat& f) override {
    const auto profile = webrtc::ParseSdpForH264ProfileLevelId(f.parameters);
    auto mode = f.parameters.find("packetization-mode");
    if (f.name != "H264" || !profile || profile->profile !=
        webrtc::H264Profile::kProfileConstrainedBaseline ||
        mode == f.parameters.end() || mode->second != "1") return nullptr;
    const uint32_t receive_level = remote_->h264_level.load();
    if (!receive_level) return nullptr;
    return std::make_unique<ExternalEncoder>(peer_, options_,
        std::min(static_cast<uint32_t>(profile->level), receive_level), playout_, trace_);
  }
 private:
  uint64_t peer_;
  remotekit_rtc_options options_;
  std::shared_ptr<RemoteReceiveLimits> remote_;
  std::shared_ptr<RequestedPlayoutDelay> playout_;
  std::shared_ptr<SdkTrace> trace_;
};

class LocalDescriptionObserver;
class RemoteDescriptionObserver;
class CreateDescriptionObserver;

class Peer : public webrtc::PeerConnectionObserver,
             public webrtc::DataChannelObserver,
             public std::enable_shared_from_this<Peer> {
 public:
  Peer(uint64_t id, const remotekit_rtc_options& options)
      : id(id), options(options), trace(std::make_shared<SdkTrace>(id)) {}
  ~Peer() override = default;
  int Start();
  void Close() {
    closing.store(true);
    if (signaling_started) signaling->BlockingCall([this] {
      if (data) { data->UnregisterObserver(); data->Close(); data = nullptr; }
      if (pc) { pc->Close(); pc = nullptr; }
      source = nullptr;
      factory = nullptr;
    });
    if (signaling) signaling->Stop();
    if (network) network->Stop();
    if (winsock_started) { WSACleanup(); winsock_started = false; }
    // WebRTC can discard queued native frames after VideoSendStream teardown.
    // Their release callbacks are part of the host-context close barrier too.
    {
      std::unique_lock lock(leases->mutex);
      leases->done.wait(lock, [this] { return leases->active == 0; });
    }
    std::lock_guard lock(event_mutex); // Wait for an already running callback.
    trace->Save();
  }
  void Event(uint32_t type, const void* bytes = nullptr, size_t size = 0,
             const char* auxiliary = nullptr, int32_t value = 0) {
    std::lock_guard lock(event_mutex);
    if (!closing.load()) options.event(options.context, id, type,
        bytes, size, auxiliary, value);
  }
  void Error(const std::string& text) {
    Event(REMOTEKIT_RTC_ERROR, text.data(), text.size());
  }
  void Offer(bool offer);
  void AttachData(scoped_refptr<webrtc::DataChannelInterface> channel) {
    if (channel->label() != "remotekit" || data) { channel->Close(); return; }
    data = std::move(channel);
    data->RegisterObserver(this);
    OnStateChange();
  }
  void OnSignalingChange(webrtc::PeerConnectionInterface::SignalingState) override {}
  void OnIceGatheringChange(webrtc::PeerConnectionInterface::IceGatheringState state) override {
    if (state == webrtc::PeerConnectionInterface::kIceGatheringComplete && pc &&
        pc->local_description()) {
      const auto* local = pc->local_description();
      auto sdp = local->ToString();
      Event(REMOTEKIT_RTC_ICE_COMPLETE, sdp.data(), sdp.size(), nullptr,
            local->GetType() == webrtc::SdpType::kOffer ? 1 : 0);
    }
  }
  void OnIceCandidate(const webrtc::IceCandidate* candidate) override {
    auto text = candidate->ToString();
    auto mid = candidate->sdp_mid();
    Event(REMOTEKIT_RTC_ICE, text.data(), text.size(), mid.c_str(),
          candidate->sdp_mline_index());
  }
  void OnConnectionChange(webrtc::PeerConnectionInterface::PeerConnectionState s) override {
    Event(REMOTEKIT_RTC_STATE, nullptr, 0, nullptr, static_cast<int32_t>(s));
  }
  void OnDataChannel(scoped_refptr<webrtc::DataChannelInterface> channel) override {
    AttachData(std::move(channel));
  }
  void OnStateChange() override {
    Event(REMOTEKIT_RTC_DATA_STATE, nullptr, 0, nullptr, data->state());
  }
  void OnMessage(const webrtc::DataBuffer& message) override {
    if (message.data.size() <= kMaxMessage)
      Event(REMOTEKIT_RTC_DATA, message.data.data(), message.data.size(),
            nullptr, message.binary ? 1 : 0);
  }
  const uint64_t id;
  remotekit_rtc_options options;
  std::shared_ptr<SdkTrace> trace;
  std::mutex api_mutex, event_mutex;
  std::atomic<bool> closing{false};
  std::atomic<bool> stats_pending{false};
  bool signaling_started = false;
  bool winsock_started = false;
  int64_t last_media_timestamp_us = 0;
  std::unique_ptr<webrtc::Thread> network, signaling;
  scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory;
  scoped_refptr<webrtc::PeerConnectionInterface> pc;
  scoped_refptr<TextureSource> source;
  scoped_refptr<webrtc::DataChannelInterface> data;
  std::shared_ptr<LeaseTracker> leases = std::make_shared<LeaseTracker>();
  std::shared_ptr<RemoteReceiveLimits> remote_limits = std::make_shared<RemoteReceiveLimits>();
  std::shared_ptr<RequestedPlayoutDelay> playout_delay = std::make_shared<RequestedPlayoutDelay>();
};

template <typename T>
void PutStat(base::DictValue& destination, const char* key, const std::optional<T>& value) {
  if (!value) return;
  if constexpr (std::is_floating_point_v<T>)
    if (!std::isfinite(*value)) return;
  if constexpr (std::is_same_v<T, std::string> || std::is_same_v<T, bool>)
    destination.Set(key, *value);
  else
    destination.Set(key, static_cast<double>(*value));
}
base::DictValue CandidateStats(const webrtc::RTCIceCandidateStats& candidate) {
  auto result = base::DictValue().Set("id", candidate.id());
  PutStat(result, "address", candidate.address);
  PutStat(result, "ip", candidate.ip);
  PutStat(result, "port", candidate.port);
  PutStat(result, "protocol", candidate.protocol);
  PutStat(result, "candidateType", candidate.candidate_type);
  PutStat(result, "relayProtocol", candidate.relay_protocol);
  return result;
}
class StatsObserver : public webrtc::RTCStatsCollectorCallback {
 public:
  explicit StatsObserver(std::weak_ptr<Peer> peer) : peer_(std::move(peer)) {}
  void OnStatsDelivered(const scoped_refptr<const webrtc::RTCStatsReport>& report) override {
    auto peer = peer_.lock();
    if (!peer) return;
    if (peer->closing.load()) { peer->stats_pending = false; return; }
    auto result = base::DictValue().Set("type", "sender-rtc-stats")
        .Set("sampleTimeUs", static_cast<double>(report->timestamp().us()))
        .Set("callbackMonotonicUs", static_cast<double>(base::TimeTicks::Now().since_origin().InMicroseconds()));
    const uint64_t requested = peer->playout_delay->packed.load();
    result.Set("requestedPlayoutDelay", base::DictValue()
        .Set("minMs", requested == UINT64_MAX ? -1 : static_cast<int>(requested >> 32))
        .Set("maxMs", requested == UINT64_MAX ? -1 : static_cast<int>(requested & UINT32_MAX)));
    base::ListValue outbound;
    std::string transport_id;
    for (const auto* stream : report->GetStatsOfType<webrtc::RTCOutboundRtpStreamStats>()) {
      if (stream->kind.value_or("") != "video") continue;
      if (transport_id.empty()) transport_id = stream->transport_id.value_or("");
      auto row = base::DictValue().Set("id", stream->id());
      PutStat(row, "ssrc", stream->ssrc);
      PutStat(row, "kind", stream->kind);
      PutStat(row, "mid", stream->mid);
      PutStat(row, "transportId", stream->transport_id);
      PutStat(row, "codecId", stream->codec_id);
      PutStat(row, "bytesSent", stream->bytes_sent);
      PutStat(row, "packetsSent", stream->packets_sent);
      PutStat(row, "retransmittedBytesSent", stream->retransmitted_bytes_sent);
      PutStat(row, "retransmittedPacketsSent", stream->retransmitted_packets_sent);
      PutStat(row, "framesEncoded", stream->frames_encoded);
      PutStat(row, "keyFramesEncoded", stream->key_frames_encoded);
      PutStat(row, "framesSent", stream->frames_sent);
      PutStat(row, "framesPerSecond", stream->frames_per_second);
      PutStat(row, "frameWidth", stream->frame_width);
      PutStat(row, "frameHeight", stream->frame_height);
      PutStat(row, "totalEncodeTime", stream->total_encode_time);
      PutStat(row, "totalPacketSendDelay", stream->total_packet_send_delay);
      PutStat(row, "targetBitrate", stream->target_bitrate);
      PutStat(row, "qualityLimitationReason", stream->quality_limitation_reason);
      PutStat(row, "nackCount", stream->nack_count);
      PutStat(row, "pliCount", stream->pli_count);
      PutStat(row, "firCount", stream->fir_count);
      if (stream->quality_limitation_durations) {
        base::DictValue durations;
        for (const auto& [reason, seconds] : *stream->quality_limitation_durations)
          if (std::isfinite(seconds)) durations.Set(reason, seconds);
        row.Set("qualityLimitationDurations", std::move(durations));
      }
      outbound.Append(std::move(row));
    }
    result.Set("outbound", std::move(outbound));
    const auto* transport = report->GetAs<webrtc::RTCTransportStats>(transport_id);
    if (!transport) {
      for (const auto* candidate : report->GetStatsOfType<webrtc::RTCTransportStats>())
        if (candidate->selected_candidate_pair_id) { transport = candidate; break; }
    }
    const auto* pair = transport && transport->selected_candidate_pair_id ?
        report->GetAs<webrtc::RTCIceCandidatePairStats>(*transport->selected_candidate_pair_id) : nullptr;
    if (pair) {
      auto row = base::DictValue().Set("id", pair->id());
      PutStat(row, "state", pair->state);
      PutStat(row, "nominated", pair->nominated);
      PutStat(row, "currentRoundTripTime", pair->current_round_trip_time);
      PutStat(row, "totalRoundTripTime", pair->total_round_trip_time);
      PutStat(row, "availableOutgoingBitrate", pair->available_outgoing_bitrate);
      PutStat(row, "bytesSent", pair->bytes_sent);
      PutStat(row, "bytesReceived", pair->bytes_received);
      PutStat(row, "packetsSent", pair->packets_sent);
      PutStat(row, "packetsReceived", pair->packets_received);
      result.Set("selectedPair", std::move(row));
      if (pair->local_candidate_id) {
        if (const auto* candidate = report->GetAs<webrtc::RTCLocalIceCandidateStats>(*pair->local_candidate_id))
          result.Set("localCandidate", CandidateStats(*candidate));
      }
      if (pair->remote_candidate_id) {
        if (const auto* candidate = report->GetAs<webrtc::RTCRemoteIceCandidateStats>(*pair->remote_candidate_id))
          result.Set("remoteCandidate", CandidateStats(*candidate));
      }
    }
    if (auto json = base::WriteJson(result))
      peer->Event(REMOTEKIT_RTC_STATS, json->data(), json->size());
    peer->stats_pending = false;
  }
 private:
  std::weak_ptr<Peer> peer_;
};

class LocalDescriptionObserver : public webrtc::SetLocalDescriptionObserverInterface {
 public:
  LocalDescriptionObserver(std::weak_ptr<Peer> p, std::string sdp, bool offer)
      : peer_(p), sdp_(std::move(sdp)), offer_(offer) {}
  void OnSetLocalDescriptionComplete(webrtc::RTCError error) override {
    if (auto p = peer_.lock(); p && !p->closing.load()) {
      if (!error.ok()) p->Error(error.message());
      else p->Event(offer_ ? REMOTEKIT_RTC_SDP_OFFER : REMOTEKIT_RTC_SDP_ANSWER,
                    sdp_.data(), sdp_.size());
    }
  }
 private:
  std::weak_ptr<Peer> peer_;
  std::string sdp_;
  bool offer_;
};
class CreateDescriptionObserver : public webrtc::CreateSessionDescriptionObserver {
 public:
  CreateDescriptionObserver(std::weak_ptr<Peer> p, bool offer) : peer_(p), offer_(offer) {}
  void OnSuccess(webrtc::SessionDescriptionInterface* raw) override {
    std::unique_ptr<webrtc::SessionDescriptionInterface> sdp(raw);
    if (auto p = peer_.lock(); p && !p->closing.load()) {
      std::string text = sdp->ToString();
      p->pc->SetLocalDescription(std::move(sdp),
          webrtc::make_ref_counted<LocalDescriptionObserver>(peer_, std::move(text), offer_));
    }
  }
  void OnFailure(webrtc::RTCError error) override {
    if (auto p = peer_.lock()) p->Error(error.message());
  }
 private:
  std::weak_ptr<Peer> peer_;
  bool offer_;
};
class RemoteDescriptionObserver : public webrtc::SetRemoteDescriptionObserverInterface {
 public:
  RemoteDescriptionObserver(std::weak_ptr<Peer> p, bool offer) : peer_(p), offer_(offer) {}
  void OnSetRemoteDescriptionComplete(webrtc::RTCError error) override {
    if (auto p = peer_.lock(); p && !p->closing.load()) {
      if (!error.ok()) p->Error(error.message());
      else if (offer_) p->Offer(false);
    }
  }
 private:
  std::weak_ptr<Peer> peer_;
  bool offer_;
};

int Peer::Start() {
  WSADATA winsock{};
  if (WSAStartup(MAKEWORD(2, 2), &winsock) != 0) return REMOTEKIT_SDK_INVALID_STATE;
  winsock_started = true;
  network = webrtc::Thread::CreateWithSocketServer();
  signaling = webrtc::Thread::Create();
  if (!network->Start()) return REMOTEKIT_SDK_INVALID_STATE;
  signaling_started = signaling->Start();
  if (!signaling_started) return REMOTEKIT_SDK_INVALID_STATE;
  return signaling->BlockingCall([this] {
    auto env = webrtc::CreateEnvironment();
    webrtc::PeerConnectionFactoryDependencies deps;
    deps.env = env;
    deps.network_thread = network.get();
    deps.socket_factory = network->socketserver();
    deps.signaling_thread = signaling.get();
    deps.adm = webrtc::make_ref_counted<SilentAudioDevice>();
    deps.audio_encoder_factory = webrtc::make_ref_counted<EmptyAudioEncoders>();
    deps.audio_decoder_factory = webrtc::make_ref_counted<EmptyAudioDecoders>();
    deps.video_encoder_factory = std::make_unique<ExternalEncoderFactory>(
        id, options, remote_limits, playout_delay, trace);
    deps.video_decoder_factory = std::make_unique<SendOnlyDecoderCapabilities>();
    const bool loopback_test = base::Environment::Create()->GetVar("REMOTEKIT_RTC_LOOPBACK_TEST").value_or("") == "1";
    webrtc::EnableMedia(deps);
    factory = webrtc::CreateModularPeerConnectionFactory(std::move(deps));
    if (!factory) return REMOTEKIT_SDK_INVALID_STATE;
    if (loopback_test) {
      webrtc::PeerConnectionFactoryInterface::Options factory_options;
      factory_options.network_ignore_mask = 0;
      factory->SetOptions(factory_options);
      std::fprintf(stderr, "RTC explicit loopback candidate experiment enabled: peer=%llu\n", id);
    }
    webrtc::PeerConnectionInterface::RTCConfiguration config;
    config.sdp_semantics = webrtc::SdpSemantics::kUnifiedPlan;
    if (options.ice_server_url && *options.ice_server_url) {
      webrtc::PeerConnectionInterface::IceServer server;
      server.urls.emplace_back(options.ice_server_url);
      if (options.ice_username) server.username = options.ice_username;
      if (options.ice_password) server.password = options.ice_password;
      config.servers.push_back(std::move(server));
    }
    auto result = factory->CreatePeerConnectionOrError(config,
        webrtc::PeerConnectionDependencies(this));
    if (!result.ok()) { Error(result.error().message()); return REMOTEKIT_SDK_INVALID_STATE; }
    pc = result.MoveValue();
    source = webrtc::make_ref_counted<TextureSource>(leases, [weak = weak_from_this()] {
      if (auto peer = weak.lock()) peer->Event(REMOTEKIT_RTC_REFRESH_REQUEST);
    });
    auto track = factory->CreateVideoTrack(source, "remotekit-atlas");
    // JSEP only reuses unassociated transceivers created by AddTrack when
    // applying an incoming offer. AddTransceiver here would leave our sender
    // unassociated and create a second recvonly transceiver (inactive answer).
    auto added = pc->AddTrack(track, {"remotekit"});
    if (!added.ok()) return REMOTEKIT_SDK_INVALID_STATE;
    auto sender = added.MoveValue();
    for (auto& transceiver : pc->GetTransceivers()) {
      if (transceiver->sender() == sender && !transceiver->SetDirectionWithError(
          webrtc::RtpTransceiverDirection::kSendOnly).ok())
        return REMOTEKIT_SDK_INVALID_STATE;
    }
    auto parameters = sender->GetParameters();
    for (auto& encoding : parameters.encodings) {
      encoding.max_framerate = 60.0;
      encoding.num_temporal_layers = 1;
      if (options.max_bitrate_bps) encoding.max_bitrate_bps = options.max_bitrate_bps;
    }
    parameters.degradation_preference = webrtc::DegradationPreference::MAINTAIN_RESOLUTION;
    if (!sender->SetParameters(parameters).ok()) return REMOTEKIT_SDK_INVALID_STATE;
    webrtc::BitrateSettings bitrate;
    if (options.min_bitrate_bps) bitrate.min_bitrate_bps = options.min_bitrate_bps;
    if (options.start_bitrate_bps) bitrate.start_bitrate_bps = options.start_bitrate_bps;
    if (options.max_bitrate_bps) bitrate.max_bitrate_bps = options.max_bitrate_bps;
    auto error = pc->SetBitrate(bitrate);
    if (!error.ok()) return REMOTEKIT_SDK_INVALID_ARGUMENT;
    return REMOTEKIT_SDK_OK;
  });
}
void Peer::Offer(bool offer) {
  auto observer = webrtc::make_ref_counted<CreateDescriptionObserver>(weak_from_this(), offer);
  webrtc::PeerConnectionInterface::RTCOfferAnswerOptions opts;
  if (offer) pc->CreateOffer(observer.get(), opts);
  else pc->CreateAnswer(observer.get(), opts);
}
std::shared_ptr<Peer> FindPeer(uint64_t id) {
  auto& r = GetRegistry();
  std::lock_guard lock(r.mutex);
  auto it = r.peers.find(id);
  return it == r.peers.end() ? nullptr : it->second;
}
template <typename F> int WithPeer(uint64_t id, F fn) {
  auto p = FindPeer(id);
  if (!p) return REMOTEKIT_SDK_INVALID_STATE;
  std::lock_guard lock(p->api_mutex);
  if (p->closing.load()) return REMOTEKIT_SDK_INVALID_STATE;
  return p->signaling->BlockingCall([&] { return fn(*p); });
}
bool ValidBytes(const void* data, size_t size, size_t max = kMaxMessage) {
  return data && size && size <= max;
}
}  // namespace

int remotekit_rtc_create(const remotekit_rtc_options* options, uint64_t* id) {
  if (id) *id = 0;
  if (!id || !options || options->struct_size != sizeof(*options) ||
      options->abi_version != REMOTEKIT_RTC_ABI_VERSION || !options->event ||
      options->encoder.struct_size != sizeof(options->encoder) ||
      !options->encoder.create || !options->encoder.configure || !options->encoder.encode ||
      !options->encoder.set_rates || !options->encoder.destroy)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  if (RemoteKitSdkBeginRtc() != REMOTEKIT_SDK_OK)
    return REMOTEKIT_SDK_INVALID_STATE;
  static const bool ssl_initialized = webrtc::InitializeSSL();
  if (!ssl_initialized) { RemoteKitSdkEndRtc(); return REMOTEKIT_SDK_INVALID_STATE; }
  auto peer = std::make_shared<Peer>(NewID(), *options);
  int result = peer->Start();
  if (result != REMOTEKIT_SDK_OK) { peer->Close(); RemoteKitSdkEndRtc(); return result; }
  auto& r = GetRegistry();
  std::lock_guard lock(r.mutex);
  r.peers.emplace(peer->id, peer);
  *id = peer->id;
  return REMOTEKIT_SDK_OK;
}
int remotekit_rtc_close(uint64_t id) {
  std::shared_ptr<Peer> p;
  auto& r = GetRegistry();
  {
    std::lock_guard lock(r.mutex);
    auto it = r.peers.find(id);
    if (it == r.peers.end()) return REMOTEKIT_SDK_INVALID_STATE;
    p = std::move(it->second); r.peers.erase(it);
  }
  std::lock_guard lock(p->api_mutex);
  p->Close();
  RemoteKitSdkEndRtc();
  return REMOTEKIT_SDK_OK;
}
int remotekit_rtc_create_offer(uint64_t id) {
  return WithPeer(id, [](Peer& p) { p.Offer(true); return REMOTEKIT_SDK_OK; });
}
int remotekit_rtc_set_remote_description(uint64_t id, int offer, const char* bytes, size_t size) {
  if (!ValidBytes(bytes, size) || (offer != 0 && offer != 1)) return REMOTEKIT_SDK_INVALID_ARGUMENT;
  return WithPeer(id, [&](Peer& p) {
    webrtc::SdpParseError error;
    auto sdp = webrtc::CreateSessionDescription(offer ? webrtc::SdpType::kOffer :
        webrtc::SdpType::kAnswer, std::string(bytes, size), &error);
    if (!sdp) { p.Error(error.description); return REMOTEKIT_SDK_INVALID_ARGUMENT; }
    // This factory intentionally has no receiving video decoder and no audio
    // codecs/devices. Reject unsupported directions before WebRTC can create
    // receive streams from an authenticated but incompatible remote offer.
    for (const auto& section : sdp->description()->contents()) {
      if (section.rejected) continue;
      const auto* media = section.media_description();
      if (media->as_audio()) return REMOTEKIT_SDK_INVALID_ARGUMENT;
      if (media->as_video() &&
          (media->direction() == webrtc::RtpTransceiverDirection::kSendOnly ||
           media->direction() == webrtc::RtpTransceiverDirection::kSendRecv))
        return REMOTEKIT_SDK_INVALID_ARGUMENT;
    }
    // Level asymmetry lets our answer advertise a different receive level;
    // it does not increase the remote receiver's declared capability. Read the
    // parsed remote receiving video sections rather than trusting local fmtp.
    uint32_t remote_level = 0;
    for (const auto& section : sdp->description()->contents()) {
      const auto* media = section.media_description();
      if (section.rejected || !media->as_video() ||
          (media->direction() != webrtc::RtpTransceiverDirection::kRecvOnly &&
           media->direction() != webrtc::RtpTransceiverDirection::kSendRecv)) continue;
      for (const auto& codec : media->codecs()) {
        if (codec.name != "H264") continue;
        auto mode = codec.params.find("packetization-mode");
        auto profile = webrtc::ParseSdpForH264ProfileLevelId(codec.params);
        if (mode == codec.params.end() || mode->second != "1" || !profile ||
            profile->profile != webrtc::H264Profile::kProfileConstrainedBaseline) continue;
        const uint32_t level = static_cast<uint32_t>(profile->level);
        remote_level = remote_level ? std::min(remote_level, level) : level;
      }
    }
    p.remote_limits->h264_level.store(remote_level);
    std::fprintf(stderr, "RTC remote H264 receive level: peer=%llu level=%u\n", p.id, remote_level);
    p.pc->SetRemoteDescription(std::move(sdp),
        webrtc::make_ref_counted<RemoteDescriptionObserver>(p.weak_from_this(), offer != 0));
    return REMOTEKIT_SDK_OK;
  });
}
int remotekit_rtc_add_ice(uint64_t id, const char* mid, int32_t mline,
                         const char* bytes, size_t size) {
  if (!mid || mline < 0 || !ValidBytes(bytes, size)) return REMOTEKIT_SDK_INVALID_ARGUMENT;
  return WithPeer(id, [&](Peer& p) {
    webrtc::SdpParseError error;
    auto candidate = webrtc::IceCandidate::Create(mid, mline, std::string(bytes, size), &error);
    if (!candidate) return REMOTEKIT_SDK_INVALID_ARGUMENT;
    return p.pc->AddIceCandidate(candidate.get()) ? REMOTEKIT_SDK_OK : REMOTEKIT_SDK_INVALID_STATE;
  });
}
int remotekit_rtc_get_receive_level(uint64_t id, uint32_t* level_idc) {
  if (!level_idc) return REMOTEKIT_SDK_INVALID_ARGUMENT;
  *level_idc = 0;
  return WithPeer(id, [&](Peer& peer) {
    *level_idc = std::min(52u, peer.remote_limits->h264_level.load());
    return REMOTEKIT_SDK_OK;
  });
}
int remotekit_rtc_set_playout_delay(uint64_t id, int32_t min_ms, int32_t max_ms) {
  const bool clear = min_ms == -1 && max_ms == -1;
  if (!clear && (min_ms < 0 || max_ms < min_ms || max_ms > 40950 ||
                 min_ms % 10 != 0 || max_ms % 10 != 0))
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  const uint64_t packed = clear ? UINT64_MAX :
      (static_cast<uint64_t>(min_ms) << 32) | static_cast<uint32_t>(max_ms);
  return WithPeer(id, [&](Peer& peer) {
    // WithPeer's API lock serializes valid updates and cancellation checks.
    // RTP sender/receiver retain an earlier header limit when later images
    // omit it, so never report a successful clear after an explicit request.
    if (clear) return peer.playout_delay->packed.load() == UINT64_MAX ?
        REMOTEKIT_SDK_OK : REMOTEKIT_SDK_INVALID_STATE;
    peer.playout_delay->packed.store(packed);
    return REMOTEKIT_SDK_OK;
  });
}
int remotekit_rtc_request_stats(uint64_t id) {
  return WithPeer(id, [](Peer& peer) {
    if (peer.stats_pending.exchange(true)) return REMOTEKIT_SDK_BUSY;
    auto callback = webrtc::make_ref_counted<StatsObserver>(peer.weak_from_this());
    peer.pc->GetStats(callback.get());
    return REMOTEKIT_SDK_OK;
  });
}
int remotekit_rtc_open_data_channel(uint64_t id) {
  return WithPeer(id, [](Peer& p) {
    if (p.data) return REMOTEKIT_SDK_INVALID_STATE;
    webrtc::DataChannelInit init;
    auto result = p.pc->CreateDataChannelOrError("remotekit", &init);
    if (!result.ok()) return REMOTEKIT_SDK_INVALID_STATE;
    p.AttachData(result.MoveValue());
    return REMOTEKIT_SDK_OK;
  });
}
int remotekit_rtc_send_data(uint64_t id, const void* data, size_t size, int binary) {
  if (!ValidBytes(data, size)) return REMOTEKIT_SDK_INVALID_ARGUMENT;
  return WithPeer(id, [&](Peer& p) {
    if (!p.data || p.data->state() != webrtc::DataChannelInterface::kOpen)
      return REMOTEKIT_SDK_INVALID_STATE;
    if (p.data->buffered_amount() + size > kMaxMessage) return REMOTEKIT_SDK_BUSY;
    webrtc::DataBuffer buffer(webrtc::CopyOnWriteBuffer(static_cast<const uint8_t*>(data), size),
                              binary != 0);
    return p.data->Send(buffer) ? REMOTEKIT_SDK_OK : REMOTEKIT_SDK_BUSY;
  });
}
int remotekit_rtc_set_media_policy(uint64_t id,uint32_t target,uint32_t maximum,uint32_t fps) {
  if(target<100000 || target>50000000 || maximum<target || maximum>60000000 || fps<1 || fps>60)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  return WithPeer(id,[&](Peer& peer) {
    for(auto& sender:peer.pc->GetSenders()) {
      auto parameters=sender->GetParameters();
      for(auto& encoding:parameters.encodings) {encoding.max_bitrate_bps=maximum;encoding.max_framerate=double(fps);}
      if(!sender->SetParameters(parameters).ok())return REMOTEKIT_SDK_INVALID_STATE;
    }
    // Runtime policy must not restart the bandwidth estimator. The requested
    // target is used at peer creation; only the ceiling changes here.
    if(peer.options.max_bitrate_bps!=maximum) {
      webrtc::BitrateSettings bitrate;bitrate.max_bitrate_bps=maximum;
      bitrate.min_bitrate_bps=std::min(500000u,target);
      if(!peer.pc->SetBitrate(bitrate).ok())return REMOTEKIT_SDK_INVALID_STATE;
      peer.options.max_bitrate_bps=maximum;
    }
    return REMOTEKIT_SDK_OK;
  });
}
int remotekit_rtc_submit_texture(uint64_t id, const remotekit_rtc_frame* frame) {
  if (!frame || frame->struct_size != sizeof(*frame) || !frame->d3d11_texture ||
      !frame->retain || !frame->release || !frame->width || !frame->height ||
      frame->width > 16384 || frame->height > 16384 ||
      (frame->width & 1) || (frame->height & 1) || frame->qpc_frequency <= 0 ||
      frame->capture_qpc < 0)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  return WithPeer(id, [&](Peer& p) {
    auto input = *frame;
    D3D11_TEXTURE2D_DESC descriptor{};
    static_cast<ID3D11Texture2D*>(input.d3d11_texture)->GetDesc(&descriptor);
    if (descriptor.Width < input.width || descriptor.Height < input.height ||
        descriptor.ArraySize != 1 || descriptor.MipLevels != 1)
      return REMOTEKIT_SDK_INVALID_ARGUMENT;
    LARGE_INTEGER now{}, frequency{};
    QueryPerformanceCounter(&now);
    QueryPerformanceFrequency(&frequency);
    if (frame->qpc_frequency != frequency.QuadPart || frame->capture_qpc > now.QuadPart)
      return REMOTEKIT_SDK_INVALID_ARGUMENT;
    // An idle refresh encodes the same captured pixels again, but it is a new
    // media frame. Keep the original capture QPC for measurement and assign a
    // fresh monotonic media timestamp (>=1ms apart for a distinct 90kHz RTP ts).
    const int64_t clock_us = webrtc::TimeMicros();
    input.capture_time_us = input.capture_qpc > 0 ? clock_us - static_cast<int64_t>(
        static_cast<double>(now.QuadPart - input.capture_qpc) * 1000000.0 / frequency.QuadPart) : 0;
    const int64_t media_timestamp = std::max(clock_us, p.last_media_timestamp_us + 1000);
    p.last_media_timestamp_us = media_timestamp;
    p.trace->Add("texture_submit", 0, &input, 0, 0, REMOTEKIT_SDK_OK, media_timestamp);
    p.source->Submit(input, media_timestamp);
    return REMOTEKIT_SDK_OK;
  });
}
int remotekit_rtc_encoded(uint64_t id, const remotekit_rtc_encoded_frame* frame,
                          uint32_t* wire_rtp_timestamp) {
  if (wire_rtp_timestamp) *wire_rtp_timestamp = 0;
  if (!frame || frame->struct_size != sizeof(*frame) ||
      !ValidBytes(frame->annex_b, frame->size, kMaxAccessUnit) ||
      !frame->width || !frame->height || frame->width > 16384 || frame->height > 16384)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  std::shared_ptr<EncoderState> s;
  {
    auto& r = GetRegistry(); std::lock_guard lock(r.mutex);
    auto it = r.encoders.find(id);
    if (it != r.encoders.end()) s = it->second.lock();
  }
  if (!s) return REMOTEKIT_SDK_INVALID_STATE;
  s->trace->Add("encoded_begin", id, nullptr, frame->rtp_timestamp, 0, 0, 0, frame->capture_time_us);
  std::lock_guard lock(s->mutex);
  if (!s->active || !s->callback) return REMOTEKIT_SDK_INVALID_STATE;
  if (!s->logged_sps) {
    const std::span<const uint8_t> bytes(static_cast<const uint8_t*>(frame->annex_b), frame->size);
    for (size_t i = 0; i + 7 < bytes.size(); ++i) {
      if (bytes[i] != 0 || bytes[i + 1] != 0) continue;
      size_t nalu = 0;
      if (bytes[i + 2] == 1) nalu = i + 3;
      else if (bytes[i + 2] == 0 && bytes[i + 3] == 1) nalu = i + 4;
      if (nalu && (bytes[nalu] & 31) == 7) {
        std::fprintf(stderr, "RTC H264 SPS: encoder=%llu profile-level-id=%02x%02x%02x "
            "size=%ux%u rtp=%u\n", id, unsigned(bytes[nalu + 1]),
            unsigned(bytes[nalu + 2]), unsigned(bytes[nalu + 3]),
            frame->width, frame->height, frame->rtp_timestamp);
        s->logged_sps = true;
        break;
      }
    }
  }
  webrtc::EncodedImage image;
  image.SetEncodedData(webrtc::EncodedImageBuffer::Create(
      static_cast<const uint8_t*>(frame->annex_b), frame->size));
  image._encodedWidth = frame->width;
  image._encodedHeight = frame->height;
  image.SetRtpTimestamp(frame->rtp_timestamp);
  image.capture_time_ms_ = frame->capture_time_us / 1000;
  image._frameType = frame->keyframe ? webrtc::VideoFrameType::kVideoFrameKey :
                                     webrtc::VideoFrameType::kVideoFrameDelta;
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
      result.error == webrtc::EncodedImageCallback::Result::OK ? REMOTEKIT_SDK_OK : REMOTEKIT_SDK_INVALID_STATE,
      0, frame->capture_time_us);
  if (result.error == webrtc::EncodedImageCallback::Result::OK && wire_rtp_timestamp)
    *wire_rtp_timestamp = result.frame_id;
  return result.error == webrtc::EncodedImageCallback::Result::OK
      ? REMOTEKIT_SDK_OK : REMOTEKIT_SDK_INVALID_STATE;
}
int remotekit_rtc_encoder_drop(uint64_t id, uint32_t rtp_timestamp) {
  std::shared_ptr<EncoderState> state;
  {
    auto& registry = GetRegistry();
    std::lock_guard lock(registry.mutex);
    auto it = registry.encoders.find(id);
    if (it != registry.encoders.end()) state = it->second.lock();
  }
  if (!state) return REMOTEKIT_SDK_INVALID_STATE;
  std::lock_guard lock(state->mutex);
  if (!state->active || !state->callback) return REMOTEKIT_SDK_INVALID_STATE;
  state->trace->Add("encoder_drop", id, nullptr, rtp_timestamp);
  state->callback->OnFrameDropped(rtp_timestamp, 0, true);
  return REMOTEKIT_SDK_OK;
}
int remotekit_rtc_sample_clock(remotekit_rtc_clock_sample* sample) {
  if (!sample || sample->struct_size != sizeof(*sample))
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  if (RemoteKitSdkBeginRtc() != REMOTEKIT_SDK_OK) return REMOTEKIT_SDK_INVALID_STATE;
  remotekit_rtc_clock_sample result{};
  result.struct_size = sizeof(result);
  result.consistent_across_processes = base::TimeTicks::IsConsistentAcrossProcesses();
  result.high_resolution = base::TimeTicks::IsHighResolution();
  LARGE_INTEGER before{}, after{}, frequency{};
  QueryPerformanceFrequency(&frequency);
  QueryPerformanceCounter(&before);
  result.monotonic_us = base::TimeTicks::Now().since_origin().InMicroseconds();
  QueryPerformanceCounter(&after);
  result.qpc_before = before.QuadPart; result.qpc_after = after.QuadPart;
  result.qpc_frequency = frequency.QuadPart;
  *sample = result;
  RemoteKitSdkEndRtc();
  return REMOTEKIT_SDK_OK;
}
