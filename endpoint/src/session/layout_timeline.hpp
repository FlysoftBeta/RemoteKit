#pragma once
#include "media/gpu_device.hpp"
#include "media/layout_requirement.hpp"
#include "util/log.hpp"
#include "protocol/shared_render_slots.h"
#include <atomic>
namespace remotekit {
class LayoutTimeline {
 public:
  bool Active() const { return active_.load(); }
  void Desired(const std::string& session, const Json& document, int64_t received = 0) {
    auto geometry = Json::array();
    for (const auto& view : document.at("views")) {
      Json item;
      for (const auto* field : {"viewId", "width", "height", "visible", "device", "occludedBottom",
                                "occlusionRevision"})
        item[field] = view.at(field);
      geometry.push_back(std::move(item));
    }
    std::lock_guard lock(mutex_);
    const auto revision = std::stoull(document.at("revision").get<std::string>());
    if (revision < desired_revision_ || geometry == geometry_)
      return;
    desired_revision_ = revision;
    if (active_)
      Emit("superseded");
    geometry_ = std::move(geometry);
    start_ = received ? received : media::QpcNow();
    key_ = session + ":" + document.at("revision").get<std::string>();
    fields_ = {{"sessionId", session},      {"geometryRevision", document.at("revision")},
               {"layoutTransaction", key_}, {"views", geometry_},
               {"desiredReceivedMs", 0},    {"browserRpcs", Json::array()}};
    for (const auto* stage :
         {"convergeStartMs", "prepareSentMs", "readyReceivedMs", "planeTextureRebuildMs",
          "firstMatchingCompositorFrameMs", "firstWireRtpSentMs"})
      fields_[stage] = nullptr;
    armed_ = false;
    active_ = true;
  }
  void Arm(const std::string& key, const media::LayoutRequirement& expected) {
    std::lock_guard lock(mutex_);
    armed_ = key == key_;
    expected_ = expected;
  }
  std::string Key(uint64_t revision) const {
    std::lock_guard lock(mutex_);
    return active_ && revision >= desired_revision_ ? key_ : std::string();
  }
  void Mark(const char* stage, int64_t qpc = 0) {
    if (!active_.load())
      return;
    std::lock_guard lock(mutex_);
    if (active_ && (!fields_.contains(stage) || fields_[stage].is_null()))
      fields_[stage] = Ms(qpc ? qpc : media::QpcNow());
  }
  void Rpc(const std::string& key, const Json& reply) {
    if (!active_.load() || !reply.contains("layoutTiming"))
      return;
    std::lock_guard lock(mutex_);
    if (!active_ || key != key_)
      return;
    auto timing = reply.at("layoutTiming");
    for (const auto* field : {"lockWaitStartQpc", "lockAcquiredQpc", "dispatchQpc", "receiptQpc"}) {
      const auto name = std::string(field).substr(0, std::string(field).size() - 3) + "Ms";
      timing[name] = Ms(timing.at(field).get<int64_t>());
      timing.erase(field);
    }
    fields_["browserRpcs"].push_back(std::move(timing));
  }
  void Source(const SharedAtlasFrame& frame,
              uint64_t epoch,
              std::optional<int64_t> plane_qpc,
              std::optional<int64_t> compositor_qpc,
              double clock_uncertainty_ms) {
    if (!active_.load())
      return;
    std::lock_guard lock(mutex_);
    if (!active_ || !armed_ || fields_.contains("firstMatchingFrameMs") ||
        !expected_.Matches(frame, frame.generation))
      return;
    fields_["firstMatchingFrameMs"] = Ms(media::QpcNow());
    fields_["layoutEpoch"] = std::to_string(epoch);
    fields_["layoutRevision"] = frame.layout_revision;
    fields_["outputGeneration"] = std::to_string(frame.generation);
    fields_["planeTextureRebuildMs"] = plane_qpc ? Json(Ms(*plane_qpc)) : Json();
    fields_["firstMatchingCompositorFrameMs"] = compositor_qpc ? Json(Ms(*compositor_qpc)) : Json();
    fields_["producerClockUncertaintyMs"] = clock_uncertainty_ms;
  }
  void Published(const SharedAtlasFrame& frame, uint64_t epoch, uint32_t rtp) {
    if (!active_.load())
      return;
    std::lock_guard lock(mutex_);
    if (!active_ || !armed_ || !fields_.contains("firstMatchingFrameMs") ||
        !expected_.Matches(frame, frame.generation) ||
        fields_.value("layoutRevision", uint32_t{0}) != frame.layout_revision)
      return;
    fields_["layoutEpoch"] = std::to_string(epoch);
    fields_["firstWireRtpSentMs"] = Ms(media::QpcNow());
    fields_["rtpTimestamp"] = rtp;
    Emit("published");
    active_ = false;
  }

 private:
  double Ms(int64_t qpc) const { return 1000.0 * (qpc - start_) / media::QpcFrequency(); }
  void Emit(const char* outcome) {
    fields_["outcome"] = outcome;
    LogEvent(LogLevel::kInfo, "layout.timeline", fields_);
  }
  mutable std::mutex mutex_;
  std::atomic<bool> active_{false};
  bool armed_ = false;
  media::LayoutRequirement expected_;
  std::string key_;
  int64_t start_ = 0;
  uint64_t desired_revision_ = 0;
  Json geometry_, fields_;
};
}  // namespace remotekit
