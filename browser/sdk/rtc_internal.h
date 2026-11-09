#include "remotekit/protocol/errors.h"
#pragma once
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
#include "third_party/webrtc/api/field_trials_view.h"
#include "third_party/webrtc/common_video/h264/h264_bitstream_parser.h"
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

#include "remotekit/browser/sdk/rtc_audio_source.h"
#include "protocol/audio_timeline.h"
#include "third_party/webrtc/api/audio_codecs/opus/audio_encoder_opus.h"

int RemoteKitSdkBeginRtc();
void RemoteKitSdkEndRtc();

namespace remotekit::rtc {
#include "remotekit/browser/sdk/rtc_trace.h"
constexpr size_t kMaxMessage = 1024 * 1024;
constexpr size_t kMaxAuthMessage = 64 * 1024;
constexpr size_t kMaxAccessUnit = 32 * 1024 * 1024;
using webrtc::scoped_refptr;

struct LeaseTracker {
  std::mutex mutex;
  std::condition_variable done;
  size_t active = 0;
};
class TextureBuffer : public webrtc::VideoFrameBuffer {
 public:
  TextureBuffer(const remotekit_rtc_frame& frame,
                std::shared_ptr<LeaseTracker> tracker,
                uint64_t authorization);
  ~TextureBuffer() override;
  Type type() const override;
  int width() const override;
  int height() const override;
  scoped_refptr<webrtc::I420BufferInterface> ToI420() override;
  const remotekit_rtc_frame& frame() const;
  uint64_t authorization() const;

 private:
  remotekit_rtc_frame frame_;
  Microsoft::WRL::ComPtr<ID3D11Texture2D> texture_;
  std::shared_ptr<LeaseTracker> tracker_;
  uint64_t authorization_;
};
class TextureSource : public webrtc::AdaptedVideoTrackSource {
 public:
  TextureSource(std::shared_ptr<LeaseTracker> tracker, std::function<void()> refresh);
  SourceState state() const override;
  bool remote() const override;
  bool is_screencast() const override;
  std::optional<bool> needs_denoising() const override;
  void RequestRefreshFrame() override;
  remotekit_rtc_adaptation Adapt(int width, int height, int64_t timestamp_us);
  void Submit(const remotekit_rtc_frame& input,
              int64_t media_timestamp_us,
              uint64_t authorization = 1);

 private:
  std::shared_ptr<LeaseTracker> tracker_;
  std::function<void()> refresh_;
};
struct RequestedPlayoutDelay {
  // One atomic preserves min/max as a coherent pair across setter/encode.
  std::atomic<uint64_t> packed{UINT64_MAX};
};
struct MediaAuthorization {
  explicit MediaAuthorization(bool enabled) : epoch(enabled ? 1 : 0) {}
  // Odd generations authorize media. The mutex synchronizes revocation with
  // actual delivery of an encoded access unit to WebRTC.
  std::mutex completion_mutex;
  std::atomic<uint64_t> epoch;
};
struct EncoderState {
  std::mutex mutex;
  webrtc::EncodedImageCallback* callback = nullptr;
  bool active = true;
  bool logged_sps = false;
  webrtc::H264BitstreamParser qp_parser;
  std::shared_ptr<RequestedPlayoutDelay> playout_delay;
  std::shared_ptr<SdkTrace> trace;
  std::shared_ptr<MediaAuthorization> authorization;
  std::map<uint32_t, uint64_t> pending;
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

Registry& GetRegistry();
uint64_t NewID();
std::shared_ptr<Peer> FindPeer(uint64_t id);
std::optional<webrtc::DegradationPreference> DegradationPreference(uint32_t preference);
bool SetSenderActive(webrtc::RtpSenderInterface* sender, bool active);
bool ValidBytes(const void* data, size_t size, size_t max = kMaxMessage);
webrtc::scoped_refptr<webrtc::AudioEncoderFactory> MakeAudioEncoders();
webrtc::scoped_refptr<webrtc::AudioDecoderFactory> MakeAudioDecoders();
webrtc::scoped_refptr<webrtc::AudioDeviceModule> MakeAudioDevice();
std::unique_ptr<webrtc::VideoEncoderFactory> MakeVideoEncoders(
    uint64_t peer,
    const remotekit_rtc_options& options,
    std::shared_ptr<RemoteReceiveLimits> remote,
    std::shared_ptr<RequestedPlayoutDelay> playout,
    std::shared_ptr<SdkTrace> trace,
    std::shared_ptr<MediaAuthorization> authorization);
std::unique_ptr<webrtc::VideoDecoderFactory> MakeVideoDecoders();
class Peer : public webrtc::PeerConnectionObserver,
             public webrtc::DataChannelObserver,
             public std::enable_shared_from_this<Peer> {
 public:
  Peer(uint64_t id, const remotekit_rtc_options& options);
  ~Peer() override = default;
  int Start();
  void Close();
  void Event(uint32_t type,
             const void* bytes = nullptr,
             size_t size = 0,
             const char* auxiliary = nullptr,
             int32_t value = 0);
  void Error(protocol::ErrorCode code, const std::string& text);
  void Offer(bool offer);
  void AttachData(scoped_refptr<webrtc::DataChannelInterface> channel);
  void OnSignalingChange(webrtc::PeerConnectionInterface::SignalingState) override;
  void OnIceGatheringChange(webrtc::PeerConnectionInterface::IceGatheringState state) override;
  void OnIceCandidate(const webrtc::IceCandidate* candidate) override;
  void OnConnectionChange(webrtc::PeerConnectionInterface::PeerConnectionState s) override;
  void OnDataChannel(scoped_refptr<webrtc::DataChannelInterface> channel) override;
  void OnStateChange() override;
  void OnMessage(const webrtc::DataBuffer& message) override;
  const uint64_t id;
  remotekit_rtc_options options;
  std::shared_ptr<SdkTrace> trace;
  std::shared_ptr<MediaAuthorization> authorization;
  std::mutex api_mutex, event_mutex;
  std::atomic<bool> closing{false};
  std::atomic<bool> stats_pending{false};
  bool signaling_started = false;
  bool winsock_started = false;
  int64_t last_media_timestamp_us = 0, last_adaptation_timestamp_us = -1;
  std::unique_ptr<webrtc::Thread> network, signaling;
  scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory;
  scoped_refptr<webrtc::PeerConnectionInterface> pc;
  scoped_refptr<TextureSource> source;
  scoped_refptr<PageAudioSource> audio_source;
  scoped_refptr<webrtc::RtpSenderInterface> audio_sender, video_sender;
  remotekit::AudioTimeline audio_timeline;
  uint64_t audio_clock_generation = 0, audio_origin_sample = 0;
  int64_t audio_origin_capture_ms = 0;
  std::atomic<uint64_t> audio_silence_blocks{0}, audio_restarts_gap{0}, audio_restarts_epoch{0},
      audio_restarts_discontinuity{0};
  std::atomic<int> audio_last_restart{0};
  std::mutex audio_mutex;
  bool av_sync = false, remote_description_started = false;
  bool audio_enabled = true;  // Protected by audio_mutex and api_mutex.
  bool ApplySenderActivity(bool authorized);
  scoped_refptr<webrtc::DataChannelInterface> data;
  scoped_refptr<webrtc::DataChannelInterface> auth_data;
  class AuthObserver : public webrtc::DataChannelObserver {
   public:
    explicit AuthObserver(Peer& peer) : peer_(peer) {}
    void OnStateChange() override {
      peer_.Event(REMOTEKIT_RTC_AUTH_DATA_STATE, nullptr, 0, nullptr, peer_.auth_data->state());
    }
    void OnMessage(const webrtc::DataBuffer& message) override {
      if (message.data.size() <= kMaxAuthMessage)
        peer_.Event(REMOTEKIT_RTC_AUTH_DATA, message.data.data(), message.data.size(), nullptr,
                    message.binary ? 1 : 0);
    }

   private:
    Peer& peer_;
  };
  AuthObserver auth_observer{*this};
  std::shared_ptr<LeaseTracker> leases = std::make_shared<LeaseTracker>();
  std::shared_ptr<RemoteReceiveLimits> remote_limits = std::make_shared<RemoteReceiveLimits>();
  std::shared_ptr<RequestedPlayoutDelay> playout_delay = std::make_shared<RequestedPlayoutDelay>();
};
template <typename F>
int WithPeer(uint64_t id, F fn) {
  auto p = FindPeer(id);
  if (!p)
    return REMOTEKIT_SDK_INVALID_STATE;
  std::lock_guard lock(p->api_mutex);
  if (p->closing.load())
    return REMOTEKIT_SDK_INVALID_STATE;
  return p->signaling->BlockingCall([&] { return fn(*p); });
}
}  // namespace remotekit::rtc
