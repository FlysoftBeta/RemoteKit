#include "media/encoders.hpp"
#include "diagnostics/timing.hpp"
#include "media/output.hpp"
#include "media/pipeline.hpp"
#include "media/presentation.hpp"
#include "rtc/authorization.hpp"
#include "rtc/channel.hpp"
#include "rtc/peer.hpp"
namespace remotekit {
using ConnectionPhase = ConnectionTiming::ConnectionPhase;
using Event = RtcEvent;
int EncoderRegistry::CreateEncoder(void* context, uint64_t encoder_peer, uint64_t encoder) {
  auto* self = static_cast<EncoderRegistry*>(context);
  std::lock_guard lock(self->encoder_mutex);
  if (!self->streaming_adapter)
    return 1;
  const auto& adapter = *self->streaming_adapter;
  self->encoders.emplace(
      encoder,
      std::make_unique<EncoderWorker>(
          self->sdk, encoder, adapter.device.Get(), adapter.encoder, self->options.encoding,
          self->stats,
          [self, encoder_peer, first_encoded = true](uint32_t timestamp, uint64_t epoch,
                                                     size_t encoded_bytes, bool keyframe,
                                                     const remotekit_rtc_frame& source) mutable {
            const auto stamp = self->authorization.Frame();
            if (!self->authorization.Current(stamp) || epoch != self->presentation.Epoch())
              return;
            if (first_encoded) {
              if (encoder_peer == self->peer_controller.Handle())
                self->timing.MarkConnection(ConnectionPhase::encoded);
              first_encoded = false;
            }
            // Enqueue only: signaling-thread destroy joins this encoder worker.
            Json message = {{"type", "frame"},
                            {"rtpTimestamp", timestamp},
                            {"layoutEpoch", std::to_string(epoch)},
                            {"encodedBytes", encoded_bytes},
                            {"keyframe", keyframe}};
            const auto metadata = media::RenderSlots::Metadata(source);
            message["viewports"] = Json::array();
            for (uint32_t i = 0; i < metadata.view_count; ++i) {
              const auto& view = metadata.views[i];
              message["viewports"].push_back(
                  {{"viewId", std::to_string(view.webview_id)},
                   {"pageHeight", view.page_height_dip},
                   {"occlusionRevision", std::to_string(view.occlusion_revision)}});
            }
            LARGE_INTEGER before{}, after{};
            FILETIME utc{};
            QueryPerformanceCounter(&before);
            GetSystemTimePreciseAsFileTime(&utc);
            QueryPerformanceCounter(&after);
            ULARGE_INTEGER ticks{};
            ticks.LowPart = utc.dwLowDateTime;
            ticks.HighPart = utc.dwHighDateTime;
            if (auto clock = remotekit::MapCaptureClock(
                    source.capture_qpc, source.qpc_frequency, before.QuadPart, after.QuadPart,
                    double(ticks.QuadPart - 116444736000000000ULL) / 10000.0,
                    self->output.ClockUncertaintyMs())) {
              message["captureWallTimeMs"] = clock->wall_ms;
              message["captureMonotonicMs"] = clock->monotonic_ms;
              message["captureClockUncertaintyMs"] = clock->uncertainty_ms;
              message["sourceCaptureId"] = std::to_string(source.capture_qpc);
            }
            self->channel.Queue(Event{0x10000, message.dump(), "", 0, encoder_peer, stamp});
          },
          self->trace, encoder_peer,
          [self, encoder_peer](const remotekit_rtc_frame& source, bool keyframe,
                               const std::function<bool()>& send) {
            const auto stamp = self->authorization.Frame();
            if (!self->authorization.Current(stamp) ||
                source.layout_epoch != self->presentation.Epoch())
              return false;
            return self->presentation.Send(encoder_peer, source.layout_epoch, keyframe, [&] {
              if (!self->authorization.Current(stamp))
                return false;
              const bool sent = send();
              if (sent && keyframe)
                self->authorization.SetInput(stamp);
              return sent;
            });
          }));
  return 0;
}

int EncoderRegistry::ConfigureEncoder(void* context,
                                      uint64_t encoder,
                                      const remotekit_rtc_encoder_config* config) {
  auto* self = static_cast<EncoderRegistry*>(context);
  std::lock_guard lock(self->encoder_mutex);
  auto found = self->encoders.find(encoder);
  if (found == self->encoders.end())
    return 1;
  auto limited = *config;
  self->timing.MarkConnection(ConnectionPhase::encoder_configure_start);
  const bool ok = found->second->Configure(limited);
  self->timing.MarkConnection(ConnectionPhase::encoder_configure_end);
  return ok ? 0 : 1;
}

int EncoderRegistry::Encode(void* context,
                            uint64_t encoder,
                            const remotekit_rtc_frame* frame,
                            int key) {
  auto* self = static_cast<EncoderRegistry*>(context);
  std::lock_guard lock(self->encoder_mutex);
  // A source-queue timeout/new source can supersede a tail before Encode runs.
  // Reject that old tag before GPU work; independent PLI requests already went
  // through Keyframe() and remain pending on the worker.
  if (!remotekit::TailRefreshLease::BeginEncoding(*frame))
    return REMOTEKIT_SDK_BUSY;
  auto found = self->encoders.find(encoder);
  if (found != self->encoders.end() &&
      found->second->Enqueue(*frame, key != 0 || remotekit::TailRefreshLease::From(*frame)))
    return 0;
  remotekit::TailRefreshLease::Finish(*frame, false);
  return REMOTEKIT_SDK_BUSY;
}

void EncoderRegistry::Rates(void* context, uint64_t encoder, uint32_t bitrate, uint32_t fps) {
  auto* self = static_cast<EncoderRegistry*>(context);
  self->pipeline.Rates(bitrate, fps);
  std::lock_guard lock(self->encoder_mutex);
  auto found = self->encoders.find(encoder);
  if (found != self->encoders.end())
    found->second->Rates(bitrate, fps);
}

void EncoderRegistry::Keyframe(void* context, uint64_t encoder) {
  auto* self = static_cast<EncoderRegistry*>(context);
  std::lock_guard lock(self->encoder_mutex);
  auto found = self->encoders.find(encoder);
  if (found != self->encoders.end())
    found->second->Keyframe();
}

void EncoderRegistry::DestroyEncoder(void* context, uint64_t encoder) {
  auto* self = static_cast<EncoderRegistry*>(context);
  std::unique_ptr<EncoderWorker> worker;
  {
    std::lock_guard lock(self->encoder_mutex);
    auto found = self->encoders.find(encoder);
    if (found != self->encoders.end()) {
      worker = std::move(found->second);
      self->encoders.erase(found);
    }
  }
  if (worker)
    worker->Stop();
}
}  // namespace remotekit

namespace remotekit {

Result<void> EncoderRegistry::PrepareAdapter() {
  auto selected = SelectStreamingAdapter(sdk, options);
  if (!selected)
    return selected.error();
  std::lock_guard lock(encoder_mutex);
  streaming_adapter = std::move(selected).value();
  return {};
}
std::optional<StreamingAdapter> EncoderRegistry::Adapter() const {
  std::lock_guard lock(encoder_mutex);
  return streaming_adapter;
}
void EncoderRegistry::ReleaseAdapter() {
  std::lock_guard lock(encoder_mutex);
  streaming_adapter.reset();
}
void EncoderRegistry::Drain() {
  std::map<uint64_t, std::unique_ptr<EncoderWorker>> remaining;
  {
    std::lock_guard lock(encoder_mutex);
    remaining.swap(encoders);
  }
  remaining.clear();
  SenderStats(nullptr);
}
void EncoderRegistry::Keyframes() {
  std::lock_guard lock(encoder_mutex);
  for (auto& [id, worker] : encoders)
    worker->Keyframe();
}
void EncoderRegistry::SetError(const std::string& error) {
  std::lock_guard lock(stats->mutex);
  stats->error = error;
}
void EncoderRegistry::SenderStats(Json value) {
  std::lock_guard lock(stats->mutex);
  stats->sender_rtc_stats = std::move(value);
}

}  // namespace remotekit
