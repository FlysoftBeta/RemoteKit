#ifndef REMOTEKIT_RTC_H_
#define REMOTEKIT_RTC_H_
#include <stddef.h>
#include <stdint.h>
#include "remotekit_sdk.h"
#ifdef __cplusplus
extern "C" {
#endif

#define REMOTEKIT_RTC_ABI_VERSION 7u
enum remotekit_rtc_event_type {
  REMOTEKIT_RTC_SDP_OFFER = 1,
  REMOTEKIT_RTC_SDP_ANSWER = 2,
  REMOTEKIT_RTC_ICE = 3,
  REMOTEKIT_RTC_STATE = 4,
  REMOTEKIT_RTC_DATA = 5,
  REMOTEKIT_RTC_ERROR = 6, /* bytes: diagnosis; auxiliary: shared handling code name. */
  REMOTEKIT_RTC_DATA_STATE = 7,
  REMOTEKIT_RTC_ICE_COMPLETE = 8,
  REMOTEKIT_RTC_REFRESH_REQUEST = 9,
  REMOTEKIT_RTC_STATS = 10,
  REMOTEKIT_RTC_AUTH_DATA = 11,
  REMOTEKIT_RTC_AUTH_DATA_STATE = 12
};
/* Event bytes are borrowed until return. SDP is UTF-8; ICE text is the
 * candidate with mid in auxiliary and mline in value. DATA and AUTH_DATA are
 * binary when value=1. STATE is PeerConnectionState (0=new..5=closed).
 * DATA_STATE and AUTH_DATA_STATE are DataChannelState (0=connecting..3=closed).
 * ICE_COMPLETE carries the complete local SDP with gathered candidates;
 * value=1 for offer and 0 for answer. Use this event for non-trickle signaling.
 * REFRESH_REQUEST has no payload: enqueue one latest-cache refresh/IDR. It is
 * WebRTC source demand, not a callback from Encode(keyframe).
 * STATS carries compact sender-side JSON. Optional WebRTC stats are omitted
 * when unavailable; availableOutgoingBitrate is the sender's video direction.
 * sampleTimeUs is RTCStatsReport's native timestamp; callbackMonotonicUs is
 * SDK TimeTicks at delivery, so cached stats are not labeled freshly sampled.
 * Callbacks run on SDK threads: enqueue work and return promptly. Do not call
 * peer APIs from callbacks. encoded() alone may be called from encoder callbacks.
 * close() is a barrier: no callback occurs after it returns. */
typedef void (*remotekit_rtc_event_fn)(void* context,
                                       uint64_t peer,
                                       uint32_t type,
                                       const void* bytes,
                                       size_t size,
                                       const char* auxiliary,
                                       int32_t value);

struct remotekit_rtc_encoder_config {
  uint32_t struct_size, width, height, fps, bitrate_bps, max_bitrate_bps;
  uint32_t max_payload_size, h264_level_idc;
};
struct remotekit_rtc_frame {
  /* width/height are encoded media dimensions, <= source texture dimensions.
   * The endpoint encoder performs source-rect to media-rect GPU scaling. */
  uint32_t struct_size, width, height;
  void* d3d11_texture; /* ID3D11Texture2D*, subresource 0, immutable until release */
  uint64_t frame_id;
  uint64_t layout_epoch;
  int64_t capture_qpc, qpc_frequency;
  uint32_t rtp_timestamp;
  int64_t capture_time_us; /* original capture QPC mapped to SDK monotonic clock;
                            * media/RTP time is separate and fresh on refresh */
  void* release_context;
  void (*retain)(void* release_context, uint64_t frame_id);
  void (*release)(void* release_context, uint64_t frame_id);
};
/* All callbacks except encoded completion are serialized by WebRTC's encoder
 * queue. create/configure/encode return zero on success. encode may return
 * REMOTEKIT_SDK_BUSY to drop this frame without failing/restarting the encoder;
 * other nonzero values report encoder failure. encode must retain its
 * own COM reference and call retain() for a GPU lease until hardware completion,
 * then call release() exactly once for that retained lease; borrowed frame
 * and texture access end on return. destroy must drain/cancel endpoint jobs.
 * Encoder IDs are never reused. Completions after destroy return INVALID_STATE.
 * H264 Annex B access units, no B frames, constrained baseline, packetization=1.
 * The endpoint must obey keyframe requests and the latest bitrate/framerate. */
struct remotekit_rtc_encoder_callbacks {
  uint32_t struct_size;
  int (*create)(void* context, uint64_t peer, uint64_t encoder);
  int (*configure)(void* context,
                   uint64_t encoder,
                   const struct remotekit_rtc_encoder_config* config);
  int (*encode)(void* context,
                uint64_t encoder,
                const struct remotekit_rtc_frame* frame,
                int keyframe);
  void (*set_rates)(void* context, uint64_t encoder, uint32_t bitrate_bps, uint32_t fps);
  void (*request_keyframe)(void* context, uint64_t encoder);
  void (*destroy)(void* context, uint64_t encoder);
};
struct remotekit_rtc_options {
  uint32_t struct_size, abi_version;
  void* context;
  remotekit_rtc_event_fn event;
  struct remotekit_rtc_encoder_callbacks encoder;
  /* Local UDP ports for ICE candidates; both zero lets the OS choose. Otherwise
   * 1024 <= port_min <= port_max. */
  uint32_t port_min, port_max;
  uint32_t min_bitrate_bps, start_bitrate_bps, max_bitrate_bps;
  uint32_t auth_required; /* 1 starts with product media disabled */
};
struct remotekit_rtc_encoded_frame {
  uint32_t struct_size;
  const void* annex_b;
  size_t size;
  uint32_t width, height, rtp_timestamp;
  int64_t capture_time_us;
  uint32_t keyframe;
  int32_t qp; /* frame luma QP, 0..51; -1 if unavailable */
};
struct remotekit_rtc_clock_sample {
  uint32_t struct_size, consistent_across_processes, high_resolution;
  int64_t monotonic_us, qpc_before, qpc_after, qpc_frequency;
};
/* TimeTicks is sampled between qpc_before/after; their span bounds sampling
 * error. Compare browser TimeTicks only when consistent_across_processes=1.
 * QPC and monotonic epochs need not be equal; use this measured sample. */
REMOTEKIT_SDK_API int remotekit_rtc_sample_clock(struct remotekit_rtc_clock_sample* sample);
/* Initialize SDK first. Close every peer before SDK shutdown/DLL unload.
 * Calls may come from different host threads and are serialized per peer.
 * Handles and callback contexts remain local to the calling process. */
REMOTEKIT_SDK_API int remotekit_rtc_create(const struct remotekit_rtc_options*, uint64_t* peer);
REMOTEKIT_SDK_API int remotekit_rtc_close(uint64_t peer);
/* Gates outgoing product video, audio and data. The authentication data
 * channel remains available. Old video completions are discarded. */
REMOTEKIT_SDK_API int remotekit_rtc_set_media_authorized(uint64_t peer, int authorized);
/* Creation-time, before set_remote_description; later calls return INVALID_STATE.
 * synced must be 0 or 1. Default 0. Selects a shared audio/video stream id. */
REMOTEKIT_SDK_API int remotekit_rtc_set_av_sync(uint64_t peer, int synced);
/* Runtime; enabled must be 0 or 1. Default 1. Audio is active only when media
 * is authorized and audio is enabled. Disabled submit_audio blocks are accepted
 * and discarded without feeding PCM to the encoder. */
REMOTEKIT_SDK_API int remotekit_rtc_set_audio_enabled(uint64_t peer, int enabled);
enum remotekit_rtc_degradation_preference {
  REMOTEKIT_RTC_MAINTAIN_RESOLUTION = 0,
  REMOTEKIT_RTC_BALANCED = 1,
  REMOTEKIT_RTC_MAINTAIN_FRAMERATE = 2
};
/* Updates only the video sender in place. GCC owns the encoded bitrate. */
REMOTEKIT_SDK_API int remotekit_rtc_set_degradation_preference(uint64_t peer, uint32_t preference);
/* Client display/capture capability ceiling, 1..240fps, independent of quality. */
REMOTEKIT_SDK_API int remotekit_rtc_set_source_max_fps(uint64_t peer, uint32_t fps);
struct remotekit_rtc_adaptation {
  uint32_t struct_size, width, height, drop;
  uint32_t max_fps; /* official source restriction, 0 = unlimited; also on drop */
};
struct remotekit_rtc_source_restrictions {
  uint32_t struct_size;
  uint32_t target_pixels; /* sink pixel target, 0 = unlimited */
  uint32_t max_fps;       /* source framerate limit, 0 = unlimited */
};
/* Reads current WebRTC sink wants without admitting or dropping a frame.
 * The source can request recovery samples while its pixels are restricted. */
REMOTEKIT_SDK_API int remotekit_rtc_get_source_restrictions(
    uint64_t peer,
    struct remotekit_rtc_source_restrictions* restrictions);
/* Calls WebRTC's source adapter exactly once before selecting a native frame.
 * Always pass the original full atlas dimensions, never an adapted size.
 * timestamp_us is an increasing SDK monotonic media time, including refreshes.
 * drop=1 sets width/height=0 and transfers no texture/lease obligation.
 * Otherwise scale the full atlas to exactly width/height (alignment rounding
 * may slightly change its aspect), install the matching layout barrier, then
 * submit that selected texture. No arbitrary crop is supported. Submit does
 * not run adaptation a second time. */
REMOTEKIT_SDK_API int remotekit_rtc_adapt_frame(uint64_t peer,
                                                uint32_t source_width,
                                                uint32_t source_height,
                                                int64_t timestamp_us,
                                                struct remotekit_rtc_adaptation* adaptation);
REMOTEKIT_SDK_API int remotekit_rtc_create_offer(uint64_t peer);
/* offer=1 applies remote offer and emits local answer; offer=0 applies answer.
 * Remote product media must be recvonly/inactive. Audio requires
 * Opus/48000/2 with stereo=1. Video-only offers remain supported. */
REMOTEKIT_SDK_API int remotekit_rtc_set_remote_description(uint64_t peer,
                                                           int offer,
                                                           const char* sdp,
                                                           size_t size);
REMOTEKIT_SDK_API int remotekit_rtc_add_ice(uint64_t peer,
                                            const char* mid,
                                            int32_t mline,
                                            const char* candidate,
                                            size_t size);
/* Effective H264 constrained-baseline/mode1 sending limit: minimum of parsed
 * remote receive level and this SDK's local level52, or zero if no receiving
 * format is present. Read after ICE_COMPLETE for this offer. */
REMOTEKIT_SDK_API int remotekit_rtc_get_receive_level(uint64_t peer, uint32_t* level_idc);
/* Thread-safe request applied to subsequent encoded completions, including
 * after encoder recreation. -1,-1 is a no-op while still unset (the default).
 * Once explicitly configured, cancellation returns INVALID_STATE and retains
 * the request: close/recreate the peer to return to default receiver behavior.
 * Updating to another valid explicit pair remains supported. Otherwise
 * require 0<=min_ms<=max_ms<=40950 and both values in multiples of 10ms.
 * Uses the negotiated RTP playout-delay extension when available; success
 * records a sender request, not a measured receiver buffering guarantee. */
REMOTEKIT_SDK_API int remotekit_rtc_set_playout_delay(uint64_t peer,
                                                      int32_t min_ms,
                                                      int32_t max_ms);
/* Asynchronous compact GetStats; at most one request per peer in flight.
 * Returns BUSY until completion; request at 1Hz. Close discards late reports. */
REMOTEKIT_SDK_API int remotekit_rtc_request_stats(uint64_t peer);
/* Creates one reliable, ordered channel named "remotekit". The remote
 * peer can also create it. Send returns BUSY when queued bytes exceed 1 MiB. */
REMOTEKIT_SDK_API int remotekit_rtc_open_data_channel(uint64_t peer);
REMOTEKIT_SDK_API int remotekit_rtc_send_data(uint64_t peer,
                                              const void* data,
                                              size_t size,
                                              int binary);
/* The remote peer creates the reliable ordered "remotekit-auth" channel.
 * Available for auth_required peers independent of product authorization.
 * Authentication messages are limited to 64 KiB each. */
REMOTEKIT_SDK_API int remotekit_rtc_send_auth_data(uint64_t peer,
                                                   const void* data,
                                                   size_t size,
                                                   int binary);
/* Success transfers one release callback obligation to the SDK, plus an SDK
 * COM reference. Failure retains ownership in the caller. GPU readiness is
 * the caller's responsibility before submission. No CPU pixel readback. */
REMOTEKIT_SDK_API int remotekit_rtc_submit_texture(uint64_t peer,
                                                   const struct remotekit_rtc_frame* frame);
/* Synchronous consumption; no caller pointer retained. Exactly 480 frames of
 * interleaved S16 stereo at 48kHz. sequence and first_sample_qpc must increase
 * within a source generation. sample_index is the first sample's position in
 * that generation (multiple of 480); it includes dropped source periods.
 * New generations restart the sender timeline. Short gaps up to 80ms are
 * filled with bounded silence; longer gaps restart the sender. QPC uses
 * QueryPerformanceCounter in the local machine domain and always increases.
 * Success is accepted PCM, not remote playback. An unnegotiated audio source
 * returns INVALID_STATE. Call on a dedicated audio thread, outside video locks. */
REMOTEKIT_SDK_API int remotekit_rtc_submit_audio(uint64_t peer,
                                                 const int16_t* pcm,
                                                 uint32_t frames,
                                                 uint64_t generation,
                                                 uint64_t sequence,
                                                 uint64_t sample_index,
                                                 int64_t first_sample_qpc,
                                                 uint32_t discontinuity);
/* Thread-safe; input bytes are copied before return. Late completions safely
 * return INVALID_STATE. Success means accepted by WebRTC, not delivered.
 * Optional wire_rtp_timestamp is zeroed on entry and set only on success to
 * WebRTC's actual outgoing timestamp (including the sender's random offset).
 * Use this output to correlate receiver rVFC frames, never the input timestamp. */
REMOTEKIT_SDK_API int remotekit_rtc_encoded(uint64_t encoder,
                                            const struct remotekit_rtc_encoded_frame* frame,
                                            uint32_t* wire_rtp_timestamp);
/* Complete a previously accepted encode by dropping it (e.g. latest-frame
 * queue replacement). Call exactly one of encoded/drop per accepted timestamp. */
REMOTEKIT_SDK_API int remotekit_rtc_encoder_drop(uint64_t encoder, uint32_t rtp_timestamp);
#ifdef __cplusplus
}
#endif
#endif
