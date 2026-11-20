#pragma once
#include "media/render_slots.hpp"
#include "media/layout_requirement.hpp"
#include "rtc/authorization.hpp"
#include "rtc/peer.hpp"
#include "session/presentation.hpp"
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
        timing(timing),
        pool(context.frame_admission) {}
  RenderSlots& Slots() { return pool; }
  bool Suspended() const { return output_suspended; }
  bool Visible() const { return has_visible_output; }
  void Suspend() { output_suspended = true; }
  void SetVisible(bool visible) { has_visible_output = visible; }
  double ClockUncertaintyMs() const { return capture_clock_uncertainty_ms; }
  Result<void> Configure(int width, int height, float scale, Json views, bool visible);
  void SetLayoutTransaction(std::string key) { layout_transaction = std::move(key); }
  Result<void> Close();
  bool Matches(const SharedAtlasFrame& frame) const {
    const auto current = requirement.load();
    return current && current->Matches(frame, pool.Generation());
  }
  bool CanPublish(const SharedAtlasFrame& frame) const {
    const auto current = requirement.load();
    return current && current->Matches(frame, pool.Generation(), false);
  }
  uint64_t PendingLayout() const {
    const auto current = requirement.load();
    const auto serial = layout_serial.load();
    return current && current->revision != UINT32_MAX && completed_layout.load() < serial ? serial
                                                                                          : 0;
  }
  void Published(const SharedAtlasFrame& frame) {
    const auto serial = layout_serial.load();
    if (!Matches(frame))
      return;
    auto completed = completed_layout.load();
    while (completed < serial && !completed_layout.compare_exchange_weak(completed, serial)) {
    }
  }
  Result<void> OpenOutput();
  Result<bool> PauseOutput(bool reconfiguring = false);
  Result<void> ResumeOutput(bool active);
  void SetClipboardPoll(std::function<Result<void>(bool)> poll) {
    clipboard_poll = std::move(poll);
  }
  Result<void> PollClipboard(bool force = false) {
    return clipboard_poll ? clipboard_poll(force) : Result<void>{};
  }

 private:
  friend class NativeErrorStateProbe;
  PeerController& peer_controller;
  AuthorizationController& authorization;
  PresentationController& presentation;
  EncoderRegistry& registry;
  MediaPipeline& pipeline;
  ConnectionTiming& timing;
  RenderSlots pool;
  std::atomic<std::shared_ptr<const media::LayoutRequirement>> requirement;
  std::atomic<uint64_t> completed_layout{0};
  std::string layout_transaction;
  std::atomic<uint64_t> layout_serial{0};
  uint32_t layout_revision = 0;
  bool extent_initialized = false;
  void RequireFrame(const Json& configuration);
  void RequestFrame();
  void BlockFrames();
  Result<void> ConfigureForGeneration(int width,
                                      int height,
                                      float scale,
                                      Json views,
                                      bool visible,
                                      uint64_t generation);
  Json configuration;
  std::string configuration_incarnation;
  std::function<Result<void>(bool)> clipboard_poll;
  std::atomic<bool> output_suspended{false}, has_visible_output{false};
  std::atomic<double> capture_clock_uncertainty_ms{0};
};
}  // namespace remotekit
