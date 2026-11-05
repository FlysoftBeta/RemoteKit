#pragma once
#include "media/encoder_worker.hpp"
#include "remotekit/capture_clock.hpp"
#include "remotekit/tail_refresh.hpp"
#include "session/context.hpp"
namespace remotekit {
class PeerController;
class AuthorizationController;
class PresentationController;
class OutputController;
class MediaPipeline;
class ChannelController;
class ConnectionTiming;
class EncoderRegistry : private ControllerContext {
 public:
  ~EncoderRegistry() { Drain(); }
  EncoderRegistry(ControllerContext context,
                  PeerController& peer_controller,
                  AuthorizationController& authorization,
                  PresentationController& presentation,
                  OutputController& output,
                  MediaPipeline& pipeline,
                  ChannelController& channel,
                  ConnectionTiming& timing)
      : ControllerContext(context),
        peer_controller(peer_controller),
        authorization(authorization),
        presentation(presentation),
        output(output),
        pipeline(pipeline),
        channel(channel),
        timing(timing) {}
  Result<void> PrepareAdapter();
  void ReleaseAdapter();
  std::optional<StreamingAdapter> Adapter() const;
  void Drain();
  void Keyframes();
  Json Snapshot() { return stats->Snapshot(); }
  uint64_t Completed() const { return stats->completed; }
  uint64_t Bytes() const { return stats->bytes; }
  uint64_t Pending() const { return stats->pending; }
  void SetError(const std::string& error);
  void SenderStats(Json value);
  static int CreateEncoder(void* context, uint64_t encoder_peer, uint64_t encoder);
  static int ConfigureEncoder(void* context,
                              uint64_t encoder,
                              const remotekit_rtc_encoder_config* config);
  static int Encode(void* context, uint64_t encoder, const remotekit_rtc_frame* frame, int key);
  static void Rates(void* context, uint64_t encoder, uint32_t bitrate, uint32_t fps);
  static void Keyframe(void* context, uint64_t encoder);
  static void DestroyEncoder(void* context, uint64_t encoder);

 private:
  PeerController& peer_controller;
  AuthorizationController& authorization;
  PresentationController& presentation;
  OutputController& output;
  MediaPipeline& pipeline;
  ChannelController& channel;
  ConnectionTiming& timing;
  std::shared_ptr<EncoderStats> stats = std::make_shared<EncoderStats>();
  mutable std::mutex encoder_mutex;
  std::map<uint64_t, std::unique_ptr<EncoderWorker>> encoders;
  std::optional<StreamingAdapter> streaming_adapter;
};
}  // namespace remotekit
