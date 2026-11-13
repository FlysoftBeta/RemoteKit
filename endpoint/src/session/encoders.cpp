#include "session/encoders.hpp"
#include "diagnostics/timing.hpp"
#include "session/output.hpp"
#include "session/pipeline.hpp"
#include "session/presentation.hpp"
#include "rtc/authorization.hpp"
#include "rtc/channel.hpp"
#include "rtc/peer.hpp"
namespace remotekit {
using ConnectionPhase = ConnectionTiming::ConnectionPhase;
using Event = RtcEvent;
EncoderRegistry::EncoderRegistry(ControllerContext context,
                                 PeerController& peer_controller,
                                 AuthorizationController& authorization,
                                 PresentationController& presentation,
                                 OutputController& output,
                                 MediaPipeline& pipeline,
                                 ChannelController& channel,
                                 ConnectionTiming& timing)
    : ControllerContext(context),
      EncoderSet(
          context.sdk,
          context.options.encoding,
          context.trace,
          {.adapter = [this] { return Adapter(); },
           .completed = [this](uint64_t encoder_peer) -> Completion {
             return [self = this, encoder_peer, first_encoded = true](
                        uint32_t timestamp, uint64_t epoch, size_t encoded_bytes, bool keyframe,
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
             };
           },
           .publish = [this](uint64_t encoder_peer) -> Publish {
             return [self = this, encoder_peer](const remotekit_rtc_frame& source, bool keyframe,
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
             };
           },
           .configuring =
               [this](bool start) {
                 this->timing.MarkConnection(start ? ConnectionPhase::encoder_configure_start
                                                   : ConnectionPhase::encoder_configure_end);
               },
           .rates = [this](uint32_t bitrate,
                           uint32_t fps) { this->pipeline.Rates(bitrate, fps); }}),
      peer_controller(peer_controller),
      authorization(authorization),
      presentation(presentation),
      output(output),
      pipeline(pipeline),
      channel(channel),
      timing(timing) {}
Result<void> EncoderRegistry::PrepareAdapter() {
  auto selected = SelectStreamingAdapter(
      ControllerContext::sdk,
      {options.encoder, options.encoding, options.max_encode_width, options.max_encode_height});
  if (!selected)
    return selected.error();
  std::lock_guard lock(adapter_mutex);
  streaming_adapter = std::move(selected).value();
  return {};
}
std::optional<StreamingAdapter> EncoderRegistry::Adapter() const {
  std::lock_guard lock(adapter_mutex);
  return streaming_adapter;
}
void EncoderRegistry::ReleaseAdapter() {
  std::lock_guard lock(adapter_mutex);
  streaming_adapter.reset();
}
}  // namespace remotekit
