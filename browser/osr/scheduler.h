#pragma once
#include "remotekit/browser/osr/plane_pool.h"
#include "remotekit/browser/osr_wake_state.h"
#include <deque>
namespace remotekit::browser::osr {
class Generation;
enum class RenderRequestState { kAdmitted, kRendering, kComposing, kSignalQueued, kRejected };
struct RenderRequest {
  RenderBegin begin;
  RenderRequestState state = RenderRequestState::kAdmitted;
};
struct Work : RenderRequest {
  uint64_t revision = 0;
  size_t pending = 0;
  bool updated = false, unavailable = false, lost = false;
  std::vector<PlaneRead> reads;
};
struct Scheduler {
  explicit Scheduler(Generation& owner) : owner_(owner) {}
  void Start();
  void Begin(const RenderBegin& begin);
  void Reject(const RenderBegin& begin, RenderRejectReason reason);
  void Pump();
  bool HasFutureDemand() const;
  void MaybeWake();
  void FinishReject(RenderRejectReason reason);
  void SchedulePump();
  void Disconnected();
  void StopBarrier(uint64_t generation);
  void MaybeStopped();
  base::DictValue Status() const;
  void TraceInput(const char* stage, const InputEvent& input, int status);
  std::deque<RenderRequest> queue_;
  OsrWakeProof wake_proof_;
  std::shared_ptr<Work> work_;
  bool issuing_ = false;
  uint64_t submitted_ = 0, rejected_ = 0;

 private:
  Generation& owner_;
};
}  // namespace remotekit::browser::osr
