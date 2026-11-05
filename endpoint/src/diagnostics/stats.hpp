#pragma once
#include "session/context.hpp"
namespace remotekit {
class PeerController;
class PresentationController;
class OutputController;
class EncoderRegistry;
class MediaPipeline;
class AudioOutput;
class ViewController;
class InputController;
class ConnectionTiming;
class ChannelController;
class FaceController;
class Diagnostics : private ControllerContext {
 public:
  Diagnostics(ControllerContext context,
              PeerController& peer_controller,
              PresentationController& presentation,
              OutputController& output,
              EncoderRegistry& registry,
              MediaPipeline& pipeline,
              AudioOutput& audio,
              ViewController& views,
              InputController& input,
              ConnectionTiming& timing,
              ChannelController& channel,
              FaceController& face)
      : ControllerContext(context),
        peer_controller(peer_controller),
        presentation(presentation),
        output(output),
        registry(registry),
        pipeline(pipeline),
        audio(audio),
        views(views),
        input(input),
        timing(timing),
        channel(channel),
        face(face) {}

  void Publish(Json report);
  Json Stats();

 private:
  PeerController& peer_controller;
  PresentationController& presentation;
  OutputController& output;
  EncoderRegistry& registry;
  MediaPipeline& pipeline;
  AudioOutput& audio;
  ViewController& views;
  InputController& input;
  ConnectionTiming& timing;
  ChannelController& channel;
  FaceController& face;
};
}  // namespace remotekit
