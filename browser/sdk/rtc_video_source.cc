#include "remotekit/browser/sdk/rtc_internal.h"
using namespace remotekit::rtc;
namespace remotekit::rtc {
TextureBuffer::TextureBuffer(const remotekit_rtc_frame& frame,
                             std::shared_ptr<LeaseTracker> tracker,
                             uint64_t authorization)
    : frame_(frame), tracker_(std::move(tracker)), authorization_(authorization) {
  {
    std::lock_guard lock(tracker_->mutex);
    ++tracker_->active;
  }
  texture_ = static_cast<ID3D11Texture2D*>(frame.d3d11_texture);
}

TextureBuffer::~TextureBuffer() {
  texture_.Reset();
  frame_.release(frame_.release_context, frame_.frame_id);
  {
    std::lock_guard lock(tracker_->mutex);
    --tracker_->active;
  }
  tracker_->done.notify_all();
}

TextureBuffer::Type TextureBuffer::type() const {
  return Type::kNative;
}

int TextureBuffer::width() const {
  return static_cast<int>(frame_.width);
}

int TextureBuffer::height() const {
  return static_cast<int>(frame_.height);
}

scoped_refptr<webrtc::I420BufferInterface> TextureBuffer::ToI420() {
  return nullptr;
}

const remotekit_rtc_frame& TextureBuffer::frame() const {
  return frame_;
}

uint64_t TextureBuffer::authorization() const {
  return authorization_;
}
TextureSource::TextureSource(std::shared_ptr<LeaseTracker> tracker, std::function<void()> refresh)
    : webrtc::AdaptedVideoTrackSource(2),
      tracker_(std::move(tracker)),
      refresh_(std::move(refresh)) {}

TextureSource::SourceState TextureSource::state() const {
  return kLive;
}

bool TextureSource::remote() const {
  return false;
}

bool TextureSource::is_screencast() const {
  return true;
}

std::optional<bool> TextureSource::needs_denoising() const {
  return false;
}

void TextureSource::RequestRefreshFrame() {
  refresh_();
}

remotekit_rtc_source_restrictions TextureSource::Restrictions() {
  remotekit_rtc_source_restrictions result{sizeof(result), 0, 0};
  const int pixels = video_adapter()->GetTargetPixels();
  if (pixels < std::numeric_limits<int>::max())
    result.target_pixels = static_cast<uint32_t>(std::max(0, pixels));
  const float max_fps = video_adapter()->GetMaxFramerate();
  if (std::isfinite(max_fps) &&
      static_cast<double>(max_fps) < static_cast<double>(std::numeric_limits<int>::max()))
    result.max_fps = static_cast<uint32_t>(std::max(1.0f, std::floor(max_fps)));
  return result;
}

remotekit_rtc_adaptation TextureSource::Adapt(int width, int height, int64_t timestamp_us) {
  remotekit_rtc_adaptation result{sizeof(result), 0, 0, 1, Restrictions().max_fps};
  int out_width = 0, out_height = 0, crop_width = 0, crop_height = 0;
  int crop_x = 0, crop_y = 0;
  if (AdaptFrame(width, height, timestamp_us, &out_width, &out_height, &crop_width, &crop_height,
                 &crop_x, &crop_y)) {
    // Atlas coordinates describe every pixel. The adapter's alignment-only
    // crop is not applied to the atlas: scale its full bounds to the selected
    // dimensions, preserving every plane including the right/bottom edge.
    result.width = out_width;
    result.height = out_height;
    result.drop = 0;
  }
  return result;
}

void TextureSource::Submit(const remotekit_rtc_frame& input,
                           int64_t media_timestamp_us,
                           uint64_t authorization) {
  OnFrame(webrtc::VideoFrame::Builder()
              .set_video_frame_buffer(
                  webrtc::make_ref_counted<TextureBuffer>(input, tracker_, authorization))
              .set_timestamp_us(media_timestamp_us)
              .set_rotation(webrtc::kVideoRotation_0)
              .build());
}
}  // namespace remotekit::rtc
std::optional<webrtc::DegradationPreference> remotekit::rtc::DegradationPreference(
    uint32_t preference) {
  switch (preference) {
    case REMOTEKIT_RTC_MAINTAIN_RESOLUTION:
      return webrtc::DegradationPreference::MAINTAIN_RESOLUTION;
    case REMOTEKIT_RTC_BALANCED:
      return webrtc::DegradationPreference::BALANCED;
    case REMOTEKIT_RTC_MAINTAIN_FRAMERATE:
      return webrtc::DegradationPreference::MAINTAIN_FRAMERATE;
    default:
      return std::nullopt;
  }
}
int remotekit_rtc_get_source_restrictions(uint64_t id,
                                          remotekit_rtc_source_restrictions* restrictions) {
  if (!restrictions || restrictions->struct_size != sizeof(*restrictions))
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  *restrictions = {sizeof(*restrictions), 0, 0};
  return WithPeer(id, [&](Peer& peer) {
    if (!peer.source)
      return REMOTEKIT_SDK_INVALID_STATE;
    *restrictions = peer.source->Restrictions();
    return REMOTEKIT_SDK_OK;
  });
}

int remotekit_rtc_adapt_frame(uint64_t id,
                              uint32_t width,
                              uint32_t height,
                              int64_t timestamp_us,
                              remotekit_rtc_adaptation* adaptation) {
  if (!adaptation || adaptation->struct_size != sizeof(*adaptation) || !width || !height ||
      width > 16384 || height > 16384 || (width & 1) || (height & 1) || timestamp_us < 0 ||
      timestamp_us > std::numeric_limits<int64_t>::max() / 1000)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  *adaptation = {sizeof(*adaptation), 0, 0, 1, 0};
  return WithPeer(id, [&](Peer& peer) {
    if (!peer.source)
      return REMOTEKIT_SDK_INVALID_STATE;
    if (timestamp_us <= peer.last_adaptation_timestamp_us)
      return REMOTEKIT_SDK_INVALID_ARGUMENT;
    peer.last_adaptation_timestamp_us = timestamp_us;
    *adaptation = peer.source->Adapt(width, height, timestamp_us);
    return REMOTEKIT_SDK_OK;
  });
}
int remotekit_rtc_submit_texture(uint64_t id, const remotekit_rtc_frame* frame) {
  if (!frame || frame->struct_size != sizeof(*frame) || !frame->d3d11_texture || !frame->retain ||
      !frame->release || !frame->width || !frame->height || frame->width > 16384 ||
      frame->height > 16384 || (frame->width & 1) || (frame->height & 1) ||
      frame->qpc_frequency <= 0 || frame->capture_qpc < 0)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  auto peer = FindPeer(id);
  if (!peer)
    return REMOTEKIT_SDK_INVALID_STATE;
  const auto authorization = peer->authorization->epoch.load();
  if (!(authorization & 1))
    return REMOTEKIT_SDK_INVALID_STATE;
  return WithPeer(id, [&](Peer& p) {
    if (p.authorization->epoch.load() != authorization)
      return REMOTEKIT_SDK_INVALID_STATE;
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
    input.capture_time_us =
        input.capture_qpc > 0
            ? clock_us -
                  static_cast<int64_t>(static_cast<double>(now.QuadPart - input.capture_qpc) *
                                       1000000.0 / frequency.QuadPart)
            : 0;
    const int64_t media_timestamp = std::max(clock_us, p.last_media_timestamp_us + 1000);
    p.last_media_timestamp_us = media_timestamp;
    p.trace->Add("texture_submit", 0, &input, 0, 0, REMOTEKIT_SDK_OK, media_timestamp);
    p.source->Submit(input, media_timestamp, authorization);
    return REMOTEKIT_SDK_OK;
  });
}
int remotekit_rtc_set_source_max_fps(uint64_t id, uint32_t fps) {
  if (fps < 1 || fps > 240)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  return WithPeer(id, [&](Peer& peer) {
    if (!peer.video_sender)
      return REMOTEKIT_SDK_INVALID_STATE;
    auto parameters = peer.video_sender->GetParameters();
    for (auto& encoding : parameters.encodings)
      encoding.max_framerate = double(fps);
    return peer.video_sender->SetParameters(parameters).ok() ? REMOTEKIT_SDK_OK
                                                             : REMOTEKIT_SDK_INVALID_STATE;
  });
}
int remotekit_rtc_set_degradation_preference(uint64_t id, uint32_t preference) {
  const auto value = DegradationPreference(preference);
  if (!value)
    return REMOTEKIT_SDK_INVALID_ARGUMENT;
  return WithPeer(id, [&](Peer& peer) {
    if (!peer.video_sender)
      return REMOTEKIT_SDK_INVALID_STATE;
    auto parameters = peer.video_sender->GetParameters();
    parameters.degradation_preference = *value;
    return peer.video_sender->SetParameters(parameters).ok() ? REMOTEKIT_SDK_OK
                                                             : REMOTEKIT_SDK_INVALID_STATE;
  });
}
