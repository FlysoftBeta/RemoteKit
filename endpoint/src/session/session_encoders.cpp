#include "session/session.hpp"
namespace remotekit {
int Session::CreateEncoder(void* context, uint64_t encoder_peer, uint64_t encoder) {
  auto* self = static_cast<Session*>(context);
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
                self->MarkConnection(ConnectionPhase::encoded);
              first_encoded = false;
            }
            // Enqueue only: signaling-thread destroy joins this encoder worker.
            Json message = {{"type", "frame"},
                            {"rtpTimestamp", timestamp},
                            {"layoutEpoch", std::to_string(epoch)},
                            {"encodedBytes", encoded_bytes},
                            {"keyframe", keyframe}};
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
                    self->capture_clock_uncertainty_ms.load())) {
              message["captureWallTimeMs"] = clock->wall_ms;
              message["captureMonotonicMs"] = clock->monotonic_ms;
              message["captureClockUncertaintyMs"] = clock->uncertainty_ms;
              message["sourceCaptureId"] = std::to_string(source.capture_qpc);
            }
            std::lock_guard event_lock(self->event_mutex);
            if (self->events.size() < 1024)
              self->events.push_back(Event{0x10000, message.dump(), "", 0, encoder_peer, stamp});
            self->event_wake.notify_one();
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

int Session::ConfigureEncoder(void* context,
                              uint64_t encoder,
                              const remotekit_rtc_encoder_config* config) {
  auto* self = static_cast<Session*>(context);
  std::lock_guard lock(self->encoder_mutex);
  auto found = self->encoders.find(encoder);
  if (found == self->encoders.end())
    return 1;
  auto limited = *config;
  self->MarkConnection(ConnectionPhase::encoder_configure_start);
  const bool ok = found->second->Configure(limited);
  self->MarkConnection(ConnectionPhase::encoder_configure_end);
  return ok ? 0 : 1;
}

int Session::Encode(void* context, uint64_t encoder, const remotekit_rtc_frame* frame, int key) {
  auto* self = static_cast<Session*>(context);
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

void Session::Rates(void* context, uint64_t encoder, uint32_t bitrate, uint32_t fps) {
  auto* self = static_cast<Session*>(context);
  self->comp_bitrate = bitrate;
  self->comp_fps = fps;
  self->event_wake.notify_one();
  std::lock_guard lock(self->encoder_mutex);
  auto found = self->encoders.find(encoder);
  if (found != self->encoders.end())
    found->second->Rates(bitrate, fps);
}

void Session::Keyframe(void* context, uint64_t encoder) {
  auto* self = static_cast<Session*>(context);
  std::lock_guard lock(self->encoder_mutex);
  auto found = self->encoders.find(encoder);
  if (found != self->encoders.end())
    found->second->Keyframe();
}

void Session::DestroyEncoder(void* context, uint64_t encoder) {
  auto* self = static_cast<Session*>(context);
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
