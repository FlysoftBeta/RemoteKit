#pragma once
#include "media/render_slots.hpp"
#include "rtc/authorization.hpp"
#include "rtc/peer.hpp"
#include "media/presentation.hpp"
#include "session/context.hpp"
namespace remotekit {
class PeerController;
class AuthorizationController;
class PresentationController;
class EncoderRegistry;
class MediaPipeline;
class ConnectionTiming;
class OutputController : private ControllerContext {
 public:
  OutputController(ControllerContext context,
                   PeerController& peer_controller,
                   AuthorizationController& authorization,
                   PresentationController& presentation,
                   EncoderRegistry& registry,
                   MediaPipeline& pipeline,
                   ConnectionTiming& timing)
      : ControllerContext(context),
        peer_controller(peer_controller),
        authorization(authorization),
        presentation(presentation),
        registry(registry),
        pipeline(pipeline),
        timing(timing) {}
  RenderSlots& Slots() { return pool; }
  bool Suspended() const { return output_suspended; }
  bool Visible() const { return has_visible_output; }
  void Suspend() { output_suspended = true; }
  void SetVisible(bool visible) { has_visible_output = visible; }
  double ClockUncertaintyMs() const { return capture_clock_uncertainty_ms; }
  Result<void> Configure(int width, int height, float scale, Json views, bool visible);
  Result<void> Close();
  Result<void> OpenOutput(bool preserve_visibility = false);
  Result<bool> PauseOutput(bool reconfiguring = false);
  Result<void> ResumeOutput(bool active);

 private:
  PeerController& peer_controller;
  AuthorizationController& authorization;
  PresentationController& presentation;
  EncoderRegistry& registry;
  MediaPipeline& pipeline;
  ConnectionTiming& timing;
  RenderSlots pool;
  std::atomic<bool> output_suspended{false}, has_visible_output{false};
  std::atomic<double> capture_clock_uncertainty_ms{0};
};
}  // namespace remotekit
