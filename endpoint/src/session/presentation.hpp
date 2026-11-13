#pragma once
#include "util/common.hpp"
#include "rtc/event.hpp"
#include "rtc/outbox.hpp"
#include "media/presentation_barrier.hpp"
#include "media/coordinate_readiness.hpp"
#include "media/media_feedback.hpp"
#include "media/sampling.hpp"
#include "protocol/shared_render_slots.h"
#include <atomic>
#include <functional>
#include <mutex>
namespace remotekit {
class PresentationController {
 public:
  using Event = RtcEvent;
  struct Hooks {
    std::function<uint64_t()> peer;
    std::function<ControlOutbox::Scope()> scope;
    std::function<bool(const Event&)> admitted;
    std::function<void()> reset_input, refresh, flush, refresh_editable;
    std::function<ControlOutbox&()> outbox;
    std::function<MediaSampling()> sampling;
  };
  explicit PresentationController(Hooks hooks) : hooks_(std::move(hooks)) {}
  void Bind(uint64_t peer);
  void QueueLayout(const Json& mode = Json());
  bool PresentationMessage(const Event& event);
  void PublishLayout(Json next, uint64_t epoch);
  void InvalidateLayout(const char* reason);
  Json Layout(const SharedAtlasFrame& frame);
  uint64_t ObserveLayout(const SharedAtlasFrame& frame);
  uint64_t Epoch() const { return layout_epoch.load(); }
  Json Snapshot() const;
  bool IsInvalid(std::string_view reason) const;
  bool Allows(const std::string& view, uint64_t epoch) const {
    return coordinate_readiness.Allows(view, epoch);
  }
  auto RefreshKey(uint64_t peer, uint64_t epoch) { return barrier_.RefreshKey(peer, epoch); }
  bool Send(uint64_t peer, uint64_t epoch, bool keyframe, const std::function<bool()>& send) {
    return barrier_.Send(peer, epoch, keyframe, send);
  }
  void ReceiveFeedback(uint64_t peer, const Json& message, int64_t now, size_t size) {
    if (media_feedback.Receive(peer, message, now, size) && first_presented_)
      for (const auto& plane : message.at("planes"))
        if (plane.value("frames", 0) > 0)
          first_presented_(plane.at("view").get<std::string>(), now);
  }
  void SetFirstPresented(std::function<void(const std::string&, int64_t)> callback) {
    first_presented_ = std::move(callback);
  }
  Json FeedbackSnapshot(int64_t now, int64_t frequency) const {
    return media_feedback.Snapshot(now, frequency);
  }

 private:
  std::string GeometryKey(const SharedAtlasFrame& frame);
  Hooks hooks_;
  mutable std::recursive_mutex mutex_;
  Json layout;
  bool video_requested_ = false;
  std::optional<PresentationBarrier::Key> layout_prepare;
  std::string current_geometry;
  std::atomic<uint64_t> layout_epoch{0};
  PresentationBarrier barrier_;
  CoordinateReadiness coordinate_readiness;
  MediaFeedback media_feedback;
  std::function<void(const std::string&, int64_t)> first_presented_;
};
}  // namespace remotekit
