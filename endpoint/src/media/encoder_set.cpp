#include "media/encoder_set.hpp"
#include "media/tail_refresh.hpp"
namespace remotekit::media {
int EncoderSet::CreateEncoder(void* context, uint64_t encoder_peer, uint64_t encoder) {
  auto* self = static_cast<EncoderSet*>(context);
  std::lock_guard lock(self->encoder_mutex);
  const auto selected = self->host.adapter();
  if (!selected)
    return 1;
  const auto& adapter = *selected;
  self->encoders.emplace(
      encoder,
      std::make_unique<EncoderWorker>(
          self->sdk, encoder, adapter.device.Get(), adapter.encoder,
          SelectedEncoderSettings(self->settings, adapter.encoder), self->stats,
          self->host.completed ? self->host.completed(encoder_peer) : Completion{}, self->trace,
          encoder_peer, self->host.publish ? self->host.publish(encoder_peer) : Publish{}));
  return 0;
}
int EncoderSet::ConfigureEncoder(void* context,
                                 uint64_t encoder,
                                 const remotekit_rtc_encoder_config* config) {
  auto* self = static_cast<EncoderSet*>(context);
  std::lock_guard lock(self->encoder_mutex);
  auto found = self->encoders.find(encoder);
  if (found == self->encoders.end())
    return 1;
  auto limited = *config;
  if (self->host.configuring)
    self->host.configuring(true);
  const bool ok = found->second->Configure(limited);
  if (self->host.configuring)
    self->host.configuring(false);
  return ok ? 0 : 1;
}

int EncoderSet::Encode(void* context, uint64_t encoder, const remotekit_rtc_frame* frame, int key) {
  auto* self = static_cast<EncoderSet*>(context);
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

void EncoderSet::Rates(void* context, uint64_t encoder, uint32_t bitrate, uint32_t fps) {
  auto* self = static_cast<EncoderSet*>(context);
  if (self->host.rates)
    self->host.rates(bitrate, fps);
  std::lock_guard lock(self->encoder_mutex);
  auto found = self->encoders.find(encoder);
  if (found != self->encoders.end())
    found->second->Rates(bitrate, fps);
}

void EncoderSet::Keyframe(void* context, uint64_t encoder) {
  auto* self = static_cast<EncoderSet*>(context);
  std::lock_guard lock(self->encoder_mutex);
  auto found = self->encoders.find(encoder);
  if (found != self->encoders.end())
    found->second->Keyframe();
}

void EncoderSet::DestroyEncoder(void* context, uint64_t encoder) {
  auto* self = static_cast<EncoderSet*>(context);
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
void EncoderSet::Drain() {
  std::map<uint64_t, std::unique_ptr<EncoderWorker>> remaining;
  {
    std::lock_guard lock(encoder_mutex);
    remaining.swap(encoders);
  }
  remaining.clear();
  SenderStats(nullptr);
}
void EncoderSet::Keyframes() {
  std::lock_guard lock(encoder_mutex);
  for (auto& [id, worker] : encoders)
    worker->Keyframe();
}
void EncoderSet::SetError(const std::string& error) {
  std::lock_guard lock(stats->mutex);
  stats->error = error;
}
void EncoderSet::SenderStats(nlohmann::json value) {
  std::lock_guard lock(stats->mutex);
  stats->sender_rtc_stats = std::move(value);
}

}  // namespace remotekit::media
