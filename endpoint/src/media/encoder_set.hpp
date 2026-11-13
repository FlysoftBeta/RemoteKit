#pragma once
#include "media/adapter.hpp"
#include "media/encoder_worker.hpp"

namespace remotekit::media {
class EncoderSet {
 public:
  using Completion =
      std::function<void(uint32_t, uint64_t, size_t, bool, const remotekit_rtc_frame&)>;
  using Publish =
      std::function<bool(const remotekit_rtc_frame&, bool, const std::function<bool()>&)>;
  struct Host {
    std::function<std::optional<StreamingAdapter>()> adapter;
    std::function<Completion(uint64_t)> completed;
    std::function<Publish(uint64_t)> publish;
    std::function<void(bool)> configuring;
    std::function<void(uint32_t, uint32_t)> rates;
  };
  EncoderSet(Sdk& sdk, EncoderSettings settings, std::shared_ptr<ServerTrace> trace, Host host)
      : sdk(sdk), settings(settings), trace(std::move(trace)), host(std::move(host)) {}
  ~EncoderSet() { Drain(); }
  void Drain();
  void Keyframes();
  nlohmann::json Snapshot() { return stats->Snapshot(); }
  uint64_t Completed() const { return stats->completed; }
  uint64_t Bytes() const { return stats->bytes; }
  uint64_t Pending() const { return stats->pending; }
  int64_t LastEncodedQpc() const { return stats->last_encoded_qpc; }
  void SetError(const std::string& error);
  void SenderStats(nlohmann::json value);

  // RTC shares one context between events and encoders. Resolve adapts that context
  // without giving the media core a dependency on its host's peer type.
  static EncoderSet* Direct(void* context) { return static_cast<EncoderSet*>(context); }
  template <auto Resolve = Direct>
  static void BindCallbacks(remotekit_rtc_encoder_callbacks& callbacks) {
    callbacks = {};
    callbacks.struct_size = sizeof(callbacks);
    callbacks.create = [](void* p, uint64_t peer, uint64_t encoder) {
      auto* self = Resolve(p);
      return self ? CreateEncoder(self, peer, encoder) : REMOTEKIT_SDK_INVALID_STATE;
    };
    callbacks.configure = [](void* p, uint64_t encoder,
                             const remotekit_rtc_encoder_config* config) {
      auto* self = Resolve(p);
      return self ? ConfigureEncoder(self, encoder, config) : REMOTEKIT_SDK_INVALID_STATE;
    };
    callbacks.encode = [](void* p, uint64_t encoder, const remotekit_rtc_frame* frame, int key) {
      auto* self = Resolve(p);
      return self ? Encode(self, encoder, frame, key) : REMOTEKIT_SDK_INVALID_STATE;
    };
    callbacks.set_rates = [](void* p, uint64_t encoder, uint32_t bitrate, uint32_t fps) {
      if (auto* self = Resolve(p))
        Rates(self, encoder, bitrate, fps);
    };
    callbacks.request_keyframe = [](void* p, uint64_t encoder) {
      if (auto* self = Resolve(p))
        Keyframe(self, encoder);
    };
    callbacks.destroy = [](void* p, uint64_t encoder) {
      if (auto* self = Resolve(p))
        DestroyEncoder(self, encoder);
    };
  }

 private:
  static int CreateEncoder(void*, uint64_t, uint64_t);
  static int ConfigureEncoder(void*, uint64_t, const remotekit_rtc_encoder_config*);
  static int Encode(void*, uint64_t, const remotekit_rtc_frame*, int);
  static void Rates(void*, uint64_t, uint32_t, uint32_t);
  static void Keyframe(void*, uint64_t);
  static void DestroyEncoder(void*, uint64_t);
  Sdk& sdk;
  EncoderSettings settings;
  std::shared_ptr<ServerTrace> trace;
  Host host;
  std::shared_ptr<EncoderStats> stats = std::make_shared<EncoderStats>();
  std::mutex encoder_mutex;
  std::map<uint64_t, std::unique_ptr<EncoderWorker>> encoders;
};
}  // namespace remotekit::media
