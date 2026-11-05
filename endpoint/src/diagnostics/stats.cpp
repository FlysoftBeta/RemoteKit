#include "diagnostics/stats.hpp"
#include "diagnostics/timing.hpp"
#include "input/input.hpp"
#include "media/audio.hpp"
#include "media/encoders.hpp"
#include "media/output.hpp"
#include "media/pipeline.hpp"
#include "media/presentation.hpp"
#include "options.hpp"
#include "rtc/channel.hpp"
#include "rtc/peer.hpp"
#include "session/views.hpp"
namespace remotekit {
using ConnectionPhase = ConnectionTiming::ConnectionPhase;
using Event = RtcEvent;
Json Diagnostics::Stats() {
  auto value = registry.Snapshot();
  const auto pipeline_state = pipeline.Snapshot();
  value["mediaPolicy"] = pipeline_state.at("mediaPolicy");
  const auto slots = output.Slots().Stats();
  const auto comp = pipeline.DiagnosticsSnapshot();
  value["comp"] = {{"idle", slots.idle},
                   {"idleEntries", slots.idleEntries},
                   {"wakes", slots.wakes},
                   {"begins", slots.begins},
                   {"rejectIdle", slots.rejectIdle},
                   {"rejectNotReady", slots.rejectNotReady},
                   {"rejectStopped", slots.rejectStopped},
                   {"readyObserved", slots.readyObserved},
                   {"consumedCompleted", slots.consumedCompleted},
                   {"stopSent", slots.stopSent},
                   {"stopConfirmed", slots.stopConfirmed},
                   {"activeDepth", slots.activeDepth},
                   {"occupied", slots.occupied},
                   {"retiredOccupied", slots.retiredOccupied},
                   {"peakOccupied", slots.peakOccupied},
                   {"retiredGenerations", slots.retiredGenerations},
                   {"retiredGenerationsCompleted", slots.retiredGenerationsCompleted},
                   {"unknownGpuRetainedGenerations", slots.unknownGpuRetainedGenerations},
                   {"unknownGpuRetentions", slots.unknownGpuRetentions},
                   {"targetFps", slots.idle ? 0 : comp.targetFps},
                   {"resumeMaxFps", comp.resumeMaxFps},
                   {"officialMaxFps", comp.officialMaxFps},
                   {"codecMaxFps", comp.codecMaxFps},
                   {"adaptRequests", comp.adaptRequests},
                   {"adaptDrops", comp.adaptDrops},
                   {"adaptErrors", comp.adaptErrors},
                   {"adaptSizeChanges", comp.adaptSizeChanges},
                   {"presentationRefreshPending", comp.refresh.pending},
                   {"presentationRefreshAttempts", comp.refresh.attempts},
                   {"presentationRefreshForcedBegins", comp.refresh.forced_begins},
                   {"presentationRefreshSuccesses", comp.refresh.successes}};
  value["sourceWidth"] = comp.sourceWidth;
  value["sourceHeight"] = comp.sourceHeight;
  value["encodedWidth"] = comp.encodedWidth;
  value["encodedHeight"] = comp.encodedHeight;
  value["configuredIdleIdrMs"] = options.idle_idr_ms;
  value["connectionTimingMs"] = timing.ConnectionTimings();
  value["connectionTimingOrigin"] = "endpoint-offer-monotonic";
  value["connectionTimingConnectionId"] = peer_controller.Connection();
  value["reconciliationPending"] = views.ReconciliationPending();
  value.update(presentation.FeedbackSnapshot(QpcNow(), QpcFrequency()));
  value["audio"] = {{"submitted", audio.Snapshot().at("submitted")},
                    {"gaps", audio.Snapshot().at("gaps")},
                    {"rejected", audio.Snapshot().at("rejected")}};
  value["rtcPlayoutDelayRequested"] = {{"minMs", RuntimeOptions::kRtcPlayoutMinMs},
                                       {"maxMs", RuntimeOptions::kRtcPlayoutMaxMs}};
  value["effectiveIdleIdrMs"] = pipeline_state.at("effective_idle_ms").get<uint64_t>();
  value["tailIdrSubmissions"] = pipeline_state.at("tail_submissions").get<uint64_t>();
  value["tailIdrCompletions"] = pipeline_state.at("tail_completions").get<uint64_t>();
  const auto interval = pipeline_state.at("source_interval_ms").get<double>(),
             age = pipeline_state.at("last_tail_age_ms").get<double>();
  value["sourceFrameIntervalMs"] = interval > 0 ? Json(interval) : Json(nullptr);
  value["encoderSelection"] = options.encoder;
  value["atlasInput"] = "render-slots";
  value["atlasSharedBorrows"] = output.Slots().shared_borrows();
  value["atlasSharedHeldSlots"] = output.Slots().shared_held_slots();
  value["lastTailAfterSourceMs"] = age > 0 ? Json(age) : Json(nullptr);
  return value;
}
}  // namespace remotekit

namespace remotekit {
void Diagnostics::Publish(Json report) {
  report.update(input.Snapshot());
  channel.QueueMessage(std::move(report));
}
}  // namespace remotekit
