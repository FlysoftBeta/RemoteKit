#include "remotekit/browser/audio_target.h"
#include <algorithm>
#include <cmath>
#include <vector>
#include "base/functional/bind.h"
#include "base/containers/span.h"
#include "base/location.h"
#include "base/timer/timer.h"
#include "media/audio/audio_manager_base.h"
#include "media/audio/audio_io.h"
#include "media/audio/audio_thread_impl.h"
#include "media/base/audio_bus.h"
#include "media/base/audio_converter.h"
#include "media/base/audio_parameters.h"
#include "remotekit/shared_audio.h"

namespace remotekit::browser {
namespace {
media::AudioParameters OutputParams() {
  return {media::AudioParameters::AUDIO_PCM_LOW_LATENCY, media::ChannelLayoutConfig::Stereo(),
          48000, 480};
}
struct Mapping {
  HANDLE handle = nullptr;
  SharedAudio* ring = nullptr;
  ~Mapping() {
    if (ring)
      UnmapViewOfFile(ring);
    if (handle)
      CloseHandle(handle);
  }
};
class TargetManager;
TargetManager* manager = nullptr;  // Browser main lifetime; tasks stop in Shutdown.
class TargetStream final : public media::AudioOutputStream,
                           public media::AudioConverter::InputCallback {
 public:
  TargetStream(TargetManager* owner, const media::AudioParameters& params);
  bool Open() override { return true; }
  void Start(AudioSourceCallback* callback) override;
  void Stop() override;
  void Close() override;
  void Flush() override { converter_.Reset(); }
  void SetVolume(double value) override {
    volume_ = std::isfinite(value) ? std::clamp(value, 0.0, 1.0) : 0;
  }
  void GetVolume(double* value) override { *value = volume_; }
  double ProvideInput(media::AudioBus* bus,
                      uint32_t delayed,
                      const media::AudioGlitchInfo& glitch) override {
    bus->Zero();
    const auto frames = callback_->OnMoreData(
        base::Microseconds(static_cast<int64_t>(delayed) * 1000000 / sample_rate_), now_, glitch,
        bus);
    if (frames < bus->frames())
      bus->ZeroFramesPartial(std::max(0, frames), bus->frames() - std::max(0, frames));
    for (int channel = 0; channel < bus->channels(); ++channel)
      for (float& sample : bus->channel(channel))
        if (!std::isfinite(sample))
          sample = 0;
    return volume_;
  }
  void Render(media::AudioBus* bus, base::TimeTicks now) {
    now_ = now;
    converter_.Convert(bus);
  }

 private:
  TargetManager* owner_;
  media::AudioConverter converter_;
  int sample_rate_;
  AudioSourceCallback* callback_ = nullptr;
  double volume_ = 1;
  base::TimeTicks now_;
};
class TargetManager final : public media::AudioManagerBase {
 public:
  explicit TargetManager(media::AudioLogFactory* log)
      : AudioManagerBase(std::make_unique<media::AudioThreadImpl>(), log),
        bus_(media::AudioBus::Create(2, 480)),
        mix_(media::AudioBus::Create(2, 480)) {
    manager = this;
  }
  ~TargetManager() override { manager = nullptr; }
  bool HasAudioOutputDevices() override { return true; }
  bool HasAudioInputDevices() override { return false; }
  const std::string_view GetName() override { return "RemoteKit"; }
  media::AudioOutputStream* MakeLinearOutputStream(const media::AudioParameters& p,
                                                   const LogCallback&) override {
    return new TargetStream(this, p);
  }
  media::AudioOutputStream* MakeLowLatencyOutputStream(const media::AudioParameters& p,
                                                       const std::string&,
                                                       const LogCallback&) override {
    return new TargetStream(this, p);
  }
  media::AudioInputStream* MakeLinearInputStream(const media::AudioParameters&,
                                                 const std::string&,
                                                 const LogCallback&) override {
    return nullptr;
  }
  media::AudioInputStream* MakeLowLatencyInputStream(const media::AudioParameters&,
                                                     const std::string&,
                                                     const LogCallback&) override {
    return nullptr;
  }
  void Activate(TargetStream* stream) {
    if (std::ranges::find(active_, stream) == active_.end())
      active_.push_back(stream);
    Wake();
  }
  void Deactivate(TargetStream* stream) { std::erase(active_, stream); }
  void Attach(std::shared_ptr<Mapping> map) {
    mapping_ = std::move(map);
    sequence_ = 0;
    sample_index_ = 0;
    qpc_origin_ = 0;
    discontinuity_ = true;
    Wake();
  }

 protected:
  media::AudioParameters GetPreferredOutputStreamParameters(
      const std::string&,
      const media::AudioParameters&) override {
    return OutputParams();
  }
  bool GetAudioOutputDeviceNames(media::AudioDeviceNames* names) override {
    names->emplace_back("RemoteKit playback", "default");
    return true;
  }
  void ShutdownOnAudioThread() override {
    timer_.Stop();
    mapping_.reset();
    AudioManagerBase::ShutdownOnAudioThread();
  }

 private:
  void Wake() {
    if (!timer_.IsRunning()) {
      next_ = base::TimeTicks::Now() + base::Milliseconds(10);
      Schedule();
    }
  }
  void Schedule() {
    timer_.Start(FROM_HERE, next_, this, &TargetManager::Tick, base::subtle::DelayPolicy::kPrecise);
  }
  void Tick() {
    if (active_.empty() && !mapping_)
      return;
    const auto now = base::TimeTicks::Now();
    LARGE_INTEGER stamp;
    QueryPerformanceCounter(&stamp);
    if (now - next_ >= base::Milliseconds(10)) {
      const int64_t missed = (now - next_).InMicroseconds() / 10000;
      next_ += base::Microseconds(missed * 10000);
      sample_index_ += static_cast<uint64_t>(missed) * 480;
      discontinuity_ = true;
    }
    const auto current_deadline = next_;
    const uint64_t current_sample = sample_index_;
    sample_index_ += 480;
    const bool current_discontinuity = discontinuity_;
    discontinuity_ = false;
    mix_->Zero();
    for (auto* stream : active_) {
      stream->Render(bus_.get(), now);
      for (int channel = 0; channel < 2; ++channel)
        for (int frame = 0; frame < 480; ++frame)
          mix_->channel(channel)[frame] += bus_->channel(channel)[frame];
    }
    next_ += base::Milliseconds(10);
    // Skip expired device periods rather than bursting stale audio after a
    // scheduling stall. Sample positions preserve the logical clock gap.
    const auto after_render = base::TimeTicks::Now();
    if (next_ <= after_render) {
      const int64_t missed = (after_render - next_).InMicroseconds() / 10000 + 1;
      next_ += base::Microseconds(missed * 10000);
      sample_index_ += static_cast<uint64_t>(missed) * 480;
      discontinuity_ = true;
    }
    Schedule();
    if (!mapping_)
      return;
    AudioPacket packet{};
    packet.sequence = ++sequence_;
    packet.sample_index = current_sample;
    LARGE_INTEGER frequency;
    QueryPerformanceFrequency(&frequency);
    if (!qpc_origin_)
      qpc_origin_ =
          stamp.QuadPart -
          static_cast<int64_t>(static_cast<long double>((now - current_deadline).InMicroseconds()) *
                               frequency.QuadPart / 1000000) -
          static_cast<int64_t>(static_cast<long double>(current_sample) * frequency.QuadPart /
                               48000);
    packet.first_sample_qpc =
        qpc_origin_ +
        static_cast<int64_t>(static_cast<long double>(current_sample) * frequency.QuadPart / 48000);
    packet.discontinuity = current_discontinuity;
    auto pcm = base::span(packet.pcm);
    for (int frame = 0; frame < 480; ++frame)
      for (int channel = 0; channel < 2; ++channel) {
        const float sample = mix_->channel(channel)[frame];
        pcm[frame * 2 + channel] =
            std::isfinite(sample)
                ? static_cast<int16_t>(std::clamp(sample, -1.0f, 32767.0f / 32768) * 32768)
                : 0;
      }
    PublishAudio(mapping_->ring, packet);
  }
  std::vector<TargetStream*> active_;
  std::unique_ptr<media::AudioBus> bus_, mix_;
  base::DeadlineTimer timer_;
  base::TimeTicks next_;
  std::shared_ptr<Mapping> mapping_;
  uint64_t sequence_ = 0, sample_index_ = 0;
  int64_t qpc_origin_ = 0;
  bool discontinuity_ = true;
};
TargetStream::TargetStream(TargetManager* owner, const media::AudioParameters& params)
    : owner_(owner), converter_(params, OutputParams(), false), sample_rate_(params.sample_rate()) {
  converter_.AddInput(this);
}
void TargetStream::Start(AudioSourceCallback* callback) {
  callback_ = callback;
  owner_->Activate(this);
}
void TargetStream::Stop() {
  owner_->Deactivate(this);
  callback_ = nullptr;
  converter_.Reset();
}
void TargetStream::Close() {
  Stop();
  converter_.RemoveInput(this);
  owner_->ReleaseOutputStream(this);
}
}  // namespace
std::unique_ptr<media::AudioManager> CreateAudioTarget(media::AudioLogFactory* log) {
  return std::make_unique<TargetManager>(log);
}
bool OpenAudioTarget(const std::string& name, uint64_t generation, uint64_t session) {
  if (!manager || name.empty() || name.size() > 200)
    return false;
  auto map = std::make_shared<Mapping>();
  map->handle = OpenFileMappingA(FILE_MAP_ALL_ACCESS, FALSE, name.c_str());
  if (!map->handle)
    return false;
  map->ring = static_cast<SharedAudio*>(
      MapViewOfFile(map->handle, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(SharedAudio)));
  LARGE_INTEGER frequency;
  QueryPerformanceFrequency(&frequency);
  if (!map->ring || map->ring->magic != kAudioMagic || map->ring->version != 1 ||
      map->ring->size != sizeof(SharedAudio) || map->ring->sample_rate != 48000 ||
      map->ring->generation != generation || map->ring->session_id != session ||
      map->ring->qpc_frequency != frequency.QuadPart)
    return false;
  manager->GetTaskRunner()->PostTask(
      FROM_HERE, base::BindOnce(&TargetManager::Attach, base::Unretained(manager), std::move(map)));
  return true;
}
void CloseAudioTarget() {
  if (manager)
    manager->GetTaskRunner()->PostTask(
        FROM_HERE, base::BindOnce(&TargetManager::Attach, base::Unretained(manager),
                                  std::shared_ptr<Mapping>()));
}
}  // namespace remotekit::browser
