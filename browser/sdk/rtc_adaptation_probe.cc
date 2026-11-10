// CPU-only production source-adapter and in-place RTP preference regression.
// The native test frame has no GPU object: no encoding or GPU access occurs.
#include "rtc_internal.h"
using namespace remotekit::rtc;

#include "base/at_exit.h"
#include "base/check.h"
#include "base/command_line.h"

int RemoteKitSdkBeginRtc() {
  return REMOTEKIT_SDK_OK;
}
void RemoteKitSdkEndRtc() {}

namespace {
class Sink : public webrtc::VideoSinkInterface<webrtc::VideoFrame> {
 public:
  void OnFrame(const webrtc::VideoFrame& frame) override {
    ++frames;
    width = frame.width();
    height = frame.height();
  }
  void OnDiscardedFrame() override { ++drops; }
  int frames = 0, drops = 0, width = 0, height = 0;
};
void SourceAdapter() {
  auto leases = std::make_shared<LeaseTracker>();
  auto source = webrtc::make_ref_counted<TextureSource>(leases, [] {});
  // With no interested sink adaptation drops before acquiring any lease.
  CHECK(source->Adapt(1938, 1090, 0).drop);
  auto* source_interface =
      static_cast<webrtc::VideoSourceInterface<webrtc::VideoFrame>*>(source.get());
  Sink sink;
  webrtc::VideoSinkWants wants;
  wants.max_pixel_count = 1200000;
  wants.target_pixel_count = 1200000;
  wants.max_framerate_fps = 15;
  wants.resolution_alignment = 2;
  wants.is_active = true;
  source_interface->AddOrUpdateSink(&sink, wants);
  for (int i = 0; i < 10; ++i) {
    const auto restrictions = source->Restrictions();
    CHECK_EQ(restrictions.target_pixels, 1200000u);
    CHECK_EQ(restrictions.max_fps, 15u);
  }
  auto selected = source->Adapt(1938, 1090, 1000000);
  CHECK(!selected.drop);
  CHECK_EQ(selected.max_fps, 15u);
  CHECK_LT(selected.width, 1938u);
  CHECK_LT(selected.height, 1090u);
  CHECK_EQ(selected.width % 2, 0u);
  CHECK_EQ(selected.height % 2, 0u);
  CHECK_LE(selected.width * selected.height, 1200000u);
  CHECK_NE(selected.width * 1090u, selected.height * 1938u);
  // Odd scale denominator/alignment rounding is delegated to WebRTC. Our
  // native frame keeps the complete caller-selected bounds, never a crop.
  uint32_t releases = 0;
  remotekit_rtc_frame frame{};
  frame.struct_size = sizeof(frame);
  frame.width = selected.width;
  frame.height = selected.height;
  frame.release_context = &releases;
  frame.release = [](void* context, uint64_t) { ++*static_cast<uint32_t*>(context); };
  source->Submit(frame, 1000000);
  CHECK_EQ(sink.frames, 1);
  CHECK_EQ(sink.width, static_cast<int>(selected.width));
  CHECK_EQ(sink.height, static_cast<int>(selected.height));
  CHECK_EQ(releases, 1u);
  // A second admission within the 15fps budget drops without touching leases.
  const auto dropped = source->Adapt(1938, 1090, 1001000);
  CHECK(dropped.drop);
  CHECK_EQ(dropped.max_fps, 15u);
  CHECK_EQ(releases, 1u);
  CHECK_EQ(leases->active, 0u);
  CHECK_GT(sink.drops, 0);
  CHECK(!source->Adapt(1938, 1090, 1100000).drop);
  wants.max_pixel_count = std::numeric_limits<int>::max();
  wants.target_pixel_count.reset();
  wants.max_framerate_fps = 30;
  source_interface->AddOrUpdateSink(&sink, wants);
  CHECK_EQ(source->Restrictions().target_pixels, 0u);
  CHECK_EQ(source->Restrictions().max_fps, 30u);
  const auto restored = source->Adapt(1938, 1090, 1200000);
  CHECK(!restored.drop);
  CHECK_EQ(restored.width, 1938u);
  CHECK_EQ(restored.height, 1090u);
  source_interface->RemoveSink(&sink);
  CHECK(source->Adapt(1938, 1090, 1300000).drop);
}
void HardwareFrameQp() {
  // The supplied frame QP must take precedence over this sample's slice QP.
  const uint8_t au[] = {0,    0,    0,    1,    0x67, 0x42, 0x80, 0x20, 0xda, 0x01, 0x40, 0x16,
                        0xe8, 0x06, 0xd0, 0xa1, 0x35, 0,    0,    0,    1,    0x68, 0xce, 0x06,
                        0xe2, 0,    0,    0,    1,    0x65, 0xb8, 0x40, 0xf0, 0x8c, 0x03, 0xf2,
                        0x75, 0x67, 0xad, 0x41, 0x64, 0x24, 0x0e, 0xa0, 0xb2, 0x12, 0x1e, 0xf8};
  class Callback : public webrtc::EncodedImageCallback {
   public:
    Result OnEncodedImage(const webrtc::EncodedImage& image,
                          const webrtc::CodecSpecificInfo*) override {
      qp = image.qp_;
      return Result(Result::OK, image.RtpTimestamp());
    }
    void OnFrameDropped(uint32_t, int, bool) override { ++drops; }
    int qp = -1, drops = 0;
  } callback;
  const auto id = NewID();
  auto state = std::make_shared<EncoderState>();
  state->callback = &callback;
  state->trace = std::make_shared<SdkTrace>(id);
  state->playout_delay = std::make_shared<RequestedPlayoutDelay>();
  state->authorization = std::make_shared<MediaAuthorization>(true);
  {
    std::lock_guard lock(GetRegistry().mutex);
    GetRegistry().encoders.emplace(id, state);
  }
  remotekit_rtc_encoded_frame frame{};
  frame.struct_size = sizeof(frame);
  frame.annex_b = au;
  frame.size = sizeof(au);
  frame.width = 1280;
  frame.height = 720;
  frame.qp = -1;
  state->pending.emplace(frame.rtp_timestamp, 1);
  CHECK_EQ(remotekit_rtc_encoded(id, &frame, nullptr), REMOTEKIT_SDK_OK);
  CHECK_EQ(callback.qp, -1);
  frame.qp = 14;
  state->pending.emplace(frame.rtp_timestamp, 1);
  CHECK_EQ(remotekit_rtc_encoded(id, &frame, nullptr), REMOTEKIT_SDK_OK);
  CHECK_EQ(callback.qp, 14);
  frame.qp = 52;
  CHECK_EQ(remotekit_rtc_encoded(id, &frame, nullptr), REMOTEKIT_SDK_INVALID_ARGUMENT);
  frame.qp = 26;
  state->pending.emplace(frame.rtp_timestamp, 1);
  state->authorization->epoch.store(3);  // Revoked and subsequently restored.
  CHECK_EQ(remotekit_rtc_encoded(id, &frame, nullptr), REMOTEKIT_SDK_INVALID_STATE);
  CHECK_EQ(callback.drops, 1);
  CHECK_EQ(callback.qp, 14);
  state->pending.emplace(frame.rtp_timestamp, 3);
  CHECK_EQ(remotekit_rtc_encoded(id, &frame, nullptr), REMOTEKIT_SDK_OK);
  CHECK_EQ(callback.qp, 26);
  {
    std::lock_guard lock(state->mutex);
    state->active = false;
  }
  CHECK_EQ(remotekit_rtc_encoded(id, &frame, nullptr), REMOTEKIT_SDK_INVALID_STATE);
  {
    std::lock_guard lock(GetRegistry().mutex);
    GetRegistry().encoders.erase(id);
  }
}
void SenderPreference() {
  remotekit_rtc_options options{};
  options.struct_size = sizeof(options);
  options.abi_version = REMOTEKIT_RTC_ABI_VERSION;
  options.event = [](void*, uint64_t, uint32_t, const void*, size_t, const char*, int32_t) {};
  options.encoder.struct_size = sizeof(options.encoder);
  options.encoder.create = [](void*, uint64_t, uint64_t) { return 0; };
  options.encoder.configure = [](void*, uint64_t, const remotekit_rtc_encoder_config*) {
    return 0;
  };
  options.encoder.encode = [](void*, uint64_t, const remotekit_rtc_frame*, int) -> int {
    return REMOTEKIT_SDK_BUSY;
  };
  options.encoder.set_rates = [](void*, uint64_t, uint32_t, uint32_t) {};
  options.encoder.destroy = [](void*, uint64_t) {};
  options.auth_required = 1;
  uint64_t id = 0;
  CHECK_EQ(remotekit_rtc_create(&options, &id), REMOTEKIT_SDK_OK);
  auto peer = FindPeer(id);
  // Retain only identity: the sender proxy must die on its signaling thread
  // during Peer::Close(), before that thread is stopped.
  auto* sender = peer->video_sender.get();
  CHECK_EQ(peer->authorization->epoch.load(), 0u);
  // Add audio to prove runtime policy updates only the video sender.
  CHECK_EQ(WithPeer(id,
                    [](Peer& p) {
                      p.audio_source = webrtc::make_ref_counted<PageAudioSource>();
                      auto added = p.pc->AddTrack(
                          p.factory->CreateAudioTrack("probe-audio", p.audio_source.get()),
                          {"remotekit"});
                      CHECK(added.ok());
                      p.audio_sender = added.MoveValue();
                      return REMOTEKIT_SDK_OK;
                    }),
           REMOTEKIT_SDK_OK);
  auto audio_before = WithPeer(id, [](Peer& p) {
    CHECK(!p.audio_sender->GetParameters().degradation_preference);
    return REMOTEKIT_SDK_OK;
  });
  CHECK_EQ(audio_before, REMOTEKIT_SDK_OK);
  for (int allowed : {1, 0, 1}) {
    CHECK_EQ(remotekit_rtc_set_media_authorized(id, allowed), REMOTEKIT_SDK_OK);
    CHECK_EQ(WithPeer(id,
                      [&](Peer& p) {
                        CHECK_EQ(p.authorization->epoch.load() & 1, static_cast<uint64_t>(allowed));
                        for (auto* track_sender : {p.audio_sender.get(), p.video_sender.get()})
                          for (const auto& encoding : track_sender->GetParameters().encodings)
                            CHECK_EQ(encoding.active, allowed != 0);
                        return REMOTEKIT_SDK_OK;
                      }),
             REMOTEKIT_SDK_OK);
  }
  for (uint32_t preference = 0; preference != 3; ++preference) {
    CHECK_EQ(remotekit_rtc_set_degradation_preference(id, preference), REMOTEKIT_SDK_OK);
    CHECK_EQ(WithPeer(id,
                      [&](Peer& p) {
                        CHECK_EQ(p.video_sender.get(), sender);
                        CHECK(p.video_sender->GetParameters().degradation_preference ==
                              DegradationPreference(preference));
                        CHECK(!p.audio_sender->GetParameters().degradation_preference);
                        return REMOTEKIT_SDK_OK;
                      }),
             REMOTEKIT_SDK_OK);
  }
  CHECK_EQ(remotekit_rtc_set_degradation_preference(id, 3), REMOTEKIT_SDK_INVALID_ARGUMENT);
  CHECK_EQ(remotekit_rtc_set_source_max_fps(id, 120), REMOTEKIT_SDK_OK);
  CHECK_EQ(WithPeer(id,
                    [](Peer& p) {
                      for (const auto& encoding : p.video_sender->GetParameters().encodings)
                        CHECK_EQ(encoding.max_framerate.value(), 120.0);
                      for (const auto& encoding : p.audio_sender->GetParameters().encodings)
                        CHECK(!encoding.max_framerate);
                      return REMOTEKIT_SDK_OK;
                    }),
           REMOTEKIT_SDK_OK);
  remotekit_rtc_adaptation adaptation{sizeof(adaptation)};
  CHECK_EQ(remotekit_rtc_adapt_frame(id, 1936, 1088, 1000000, &adaptation), REMOTEKIT_SDK_OK);
  CHECK_EQ(remotekit_rtc_adapt_frame(id, 1936, 1088, 1000000, &adaptation),
           REMOTEKIT_SDK_INVALID_ARGUMENT);
  CHECK_EQ(remotekit_rtc_close(id), REMOTEKIT_SDK_OK);
  CHECK_EQ(remotekit_rtc_adapt_frame(id, 1936, 1088, 2000000, &adaptation),
           REMOTEKIT_SDK_INVALID_STATE);
}
void AuthMessageLimit() {
  size_t accepted = 0;
  remotekit_rtc_options options{};
  options.context = &accepted;
  options.auth_required = 1;
  options.event = [](void* context, uint64_t peer, uint32_t type, const void* bytes, size_t size,
                     const char*, int32_t value) {
    CHECK_EQ(peer, 42u);
    CHECK_EQ(type, REMOTEKIT_RTC_AUTH_DATA);
    CHECK_EQ(value, 1);
    CHECK(bytes);
    *static_cast<size_t*>(context) += size;
  };
  Peer peer(42, options);
  const std::vector<uint8_t> bytes(kMaxAuthMessage + 1);
  peer.auth_observer.OnMessage(
      webrtc::DataBuffer(webrtc::CopyOnWriteBuffer(bytes.data(), bytes.size()), true));
  CHECK_EQ(accepted, 0u);
  peer.auth_observer.OnMessage(
      webrtc::DataBuffer(webrtc::CopyOnWriteBuffer(bytes.data(), kMaxAuthMessage), true));
  CHECK_EQ(accepted, kMaxAuthMessage);
}
}  // namespace
int main(int argc, char** argv) {
  base::AtExitManager at_exit;
  base::CommandLine::Init(argc, argv);
  SourceAdapter();
  HardwareFrameQp();
  SenderPreference();
  AuthMessageLimit();
  std::puts("RTC adaptation production probe passed");
}
