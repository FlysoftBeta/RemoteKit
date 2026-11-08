#pragma once

#include <limits>
#include <memory>
#include <string>
#include "base/sequence_checker.h"
#include "services/viz/privileged/mojom/compositing/remotekit_output.mojom.h"
#include "remotekit/browser/osr_renderer.h"
#include "remotekit/browser/osr/device.h"
#include "remotekit/browser/osr/plane_pool.h"
#include "remotekit/browser/osr/scheduler.h"
#include "remotekit/browser/osr/atlas.h"
#include "remotekit/browser/osr/retirement.h"
#include "remotekit/browser/osr/trace.h"
namespace remotekit::browser::osr {
inline constexpr uint64_t kRemoved = std::numeric_limits<uint64_t>::max();
// UI sequence and generation lifetime cover all producer callbacks and GPU leases.
class Generation : public std::enable_shared_from_this<Generation> {
 public:
  using View = OsrRenderer::View;
  Generation(uint32_t width, uint32_t height, uint64_t generation);
  ~Generation();
  void Start() { scheduler_.Start(); }
  void SetViews(std::vector<View> views) { plane_pool_.SetViews(std::move(views)); }
  bool Configure(const std::shared_ptr<Plane>& plane) { return plane_pool_.Configure(plane); }
  void Configured(std::shared_ptr<Plane> plane, bool ok) {
    plane_pool_.Configured(std::move(plane), ok);
  }
  void Begin(const RenderBegin& begin) { scheduler_.Begin(begin); }
  void Reject(const RenderBegin& begin, RenderRejectReason reason) {
    scheduler_.Reject(begin, reason);
  }
  void Pump() { scheduler_.Pump(); }
  void PlaneResult(std::shared_ptr<Work> work,
                   size_t index,
                   std::shared_ptr<Target> target,
                   uint32_t target_index,
                   viz::mojom::RemoteKitFrameResultPtr result) {
    plane_pool_.PlaneResult(std::move(work), index, std::move(target), target_index,
                            std::move(result));
  }
  bool RefreshCurrentWork(Work& work) { return atlas_.RefreshCurrentWork(work); }
  void CompleteWork() { atlas_.CompleteWork(); }
  bool ProducerRetired(const Plane& plane) const { return retirement_.ProducerRetired(plane); }
  void OnDemandChanged(base::WeakPtr<OffscreenHost> notified_host) {
    plane_pool_.OnDemandChanged(std::move(notified_host));
  }
  void MaybeWake() { scheduler_.MaybeWake(); }
  void FinishReject(RenderRejectReason reason) { scheduler_.FinishReject(reason); }
  void SchedulePump() { scheduler_.SchedulePump(); }
  void PublishLayout() { atlas_.PublishLayout(); }
  void PublishClipboardSequence(uint64_t sequence);
  void StopView(uint64_t id) { plane_pool_.StopView(id); }
  void Fatal(std::string error) { retirement_.Fatal(std::move(error)); }
  void Disconnected() { scheduler_.Disconnected(); }
  void StopBarrier(uint64_t generation) { scheduler_.StopBarrier(generation); }
  void MaybeStopped() { scheduler_.MaybeStopped(); }
  void Stop() { retirement_.Stop(); }
  void Poll() { retirement_.Poll(); }
  base::DictValue Describe(uint32_t pid) { return atlas_.Describe(pid); }
  mojo::ScopedMessagePipeHandle TakeRenderEndpoint(std::string_view token, uint32_t pid) {
    return atlas_.TakeRenderEndpoint(token, pid);
  }
  base::DictValue Description() const { return atlas_.Description(); }
  base::DictValue Status() const { return scheduler_.Status(); }
  void TraceInput(const char* stage, const InputEvent& input, int status) {
    scheduler_.TraceInput(stage, input, status);
  }
  base::DictValue RenderStatus(uint64_t id) const { return plane_pool_.RenderStatus(id); }

 private:
  friend struct PlanePool;
  friend struct Scheduler;
  friend struct Atlas;
  friend struct Retirement;
  const uint32_t width_, height_;
  const uint64_t generation_;
  OsrTrace trace_;
  bool failed_ = false;
  SharedAtlasStatus status_ = SharedAtlasStatus::kStarting;
  std::string error_;
  Device device_;
  PlanePool plane_pool_;
  Scheduler scheduler_;
  Atlas atlas_;
  Retirement retirement_;
  SEQUENCE_CHECKER(sequence_);
};
}  // namespace remotekit::browser::osr
