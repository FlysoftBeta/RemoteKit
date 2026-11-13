#pragma once
#include "media/encoder_set.hpp"
#include "media/capture_clock.hpp"
#include "media/tail_refresh.hpp"
#include "session/context.hpp"
namespace remotekit {
class PeerController;
class AuthorizationController;
class PresentationController;
class OutputController;
class MediaPipeline;
class ChannelController;
class ConnectionTiming;
class EncoderRegistry : private ControllerContext, public media::EncoderSet {
 public:
  ~EncoderRegistry() { Drain(); }
  EncoderRegistry(ControllerContext context,
                  PeerController&,
                  AuthorizationController&,
                  PresentationController&,
                  OutputController&,
                  MediaPipeline&,
                  ChannelController&,
                  ConnectionTiming&);
  Result<void> PrepareAdapter();
  void ReleaseAdapter();
  std::optional<StreamingAdapter> Adapter() const;

 private:
  PeerController& peer_controller;
  AuthorizationController& authorization;
  PresentationController& presentation;
  OutputController& output;
  MediaPipeline& pipeline;
  ChannelController& channel;
  ConnectionTiming& timing;
  mutable std::mutex adapter_mutex;
  std::optional<StreamingAdapter> streaming_adapter;
};
}  // namespace remotekit
