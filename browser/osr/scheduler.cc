#include "remotekit/browser/osr/generation.h"
#include "services/viz/privileged/mojom/compositing/remotekit_output.mojom.h"
#include "base/check.h"
#include "base/functional/bind.h"
#include "base/task/single_thread_task_runner.h"
#include "base/unguessable_token.h"
#include "ui/compositor/compositor.h"
#include "components/viz/common/frame_sinks/begin_frame_args.h"

namespace remotekit::browser::osr {

void Scheduler::Start() {
  if (owner_.failed_)
    return;
  owner_.atlas_.channel_token_ = base::UnguessableToken::Create().ToString();
  mojo::ScopedMessagePipeHandle producer;
  if (mojo::CreateMessagePipe(nullptr, &producer, &owner_.atlas_.pending_render_endpoint_) !=
      MOJO_RESULT_OK) {
    owner_.Fatal("render message pipe allocation failed");
    return;
  }
  owner_.atlas_.channel_ = std::make_unique<RenderChannel>(
      std::move(producer), base::BindRepeating(&Generation::Begin, base::Unretained(&owner_)),
      base::BindRepeating(&Generation::StopBarrier, base::Unretained(&owner_)),
      base::BindOnce(&Generation::Disconnected, base::Unretained(&owner_)));
  // Polling retires GPU leases only. It never issues a render Begin.
  owner_.retirement_.timer_.Start(
      FROM_HERE, base::Milliseconds(2),
      base::BindRepeating(&Generation::Poll, base::Unretained(&owner_)));
}

void Scheduler::Begin(const RenderBegin& begin) {
  auto protect = owner_.shared_from_this();
  DCHECK_CALLED_ON_VALID_SEQUENCE(owner_.sequence_);
  if (begin.identity.generation != owner_.generation_) {
    owner_.Reject(begin, RenderRejectReason::kStaleGeneration);
    return;
  }
  if (owner_.failed_)
    return;  // Failed resources are sealed, never falsely rejected.
  if (owner_.retirement_.stopping_) {
    owner_.Reject(begin, RenderRejectReason::kStopped);
    return;
  }
  auto& slot = owner_.atlas_.slots_[begin.identity.slot];
  auto consumed = slot.consumed->GetCompletedValue();
  if (consumed == kRemoved || slot.reserved || (slot.last_value && consumed < slot.last_value) ||
      begin.identity.value <= slot.last_value) {
    owner_.Fatal("Begin attempted reuse before its slot consumed GPU fence");
    return;
  }
  wake_proof_.ObserveBegin(begin);
  slot.reserved = true;
  queue_.push_back({begin});
  owner_.trace_.Add("rend_begin", begin.identity, 0, static_cast<int>(queue_.size()));
  if (queue_.size() + (work_ ? 1 : 0) > kRenderSlotCount) {
    owner_.Fatal("OSR Begin capacity exceeded");
    return;
  }
  owner_.Pump();
}

void Scheduler::Reject(const RenderBegin& begin, RenderRejectReason reason) {
  if (begin.identity.generation == owner_.generation_ &&
      begin.identity.slot < owner_.atlas_.slots_.size())
    owner_.atlas_.slots_[begin.identity.slot].reserved = false;
  owner_.trace_.Add("rend_reject", begin.identity, 0, static_cast<int>(reason));
  if (owner_.atlas_.channel_)
    owner_.atlas_.channel_->Reject(begin.identity, reason);
}

void Scheduler::Pump() {
  if (work_ || queue_.empty() || owner_.failed_)
    return;
  auto work = std::make_shared<Work>();
  static_cast<RenderRequest&>(*work) = queue_.front();
  CHECK(work->state == RenderRequestState::kAdmitted);
  work->state = RenderRequestState::kRendering;
  queue_.pop_front();
  work->revision = owner_.plane_pool_.revision_;
  work_ = work;
  owner_.trace_.Add("rend_pump", work->begin.identity);
  bool ready = true;
  for (auto id : owner_.plane_pool_.order_) {
    auto plane = owner_.plane_pool_.planes_.at(id);
    work->reads.push_back({plane, plane->metadata, plane->latest, plane->enabled});
    if (plane->enabled && !owner_.Configure(plane))
      ready = false;
  }
  if (owner_.failed_)
    return;
  if (!ready) {
    owner_.FinishReject(RenderRejectReason::kNotReady);
    return;
  }
  const auto interval = base::Microseconds(work->begin.interval_us);
  const auto now = base::TimeTicks::Now();
  // Establish pending count before calls: tests and disconnected pipes may
  // complete synchronously. A root receives at most one request at a time.
  for (const auto& read : work->reads)
    if (read.enabled)
      ++work->pending;
  issuing_ = true;
  for (size_t index = 0; index < work->reads.size(); ++index) {
    auto& read = work->reads[index];
    if (!read.enabled)
      continue;
    auto& plane = *read.plane;
    size_t target_index = plane.targets.size();
    for (size_t i = 0; i < plane.targets.size(); ++i)
      if (plane.targets[i].use_count() == 1 && !plane.targets[i]->writing &&
          plane.targets[i]->ready->GetCompletedValue() != kRemoved &&
          plane.targets[i]->ready->GetCompletedValue() >= plane.targets[i]->value) {
        target_index = i;
        break;
      }
    if (!plane.host || plane.retired || target_index == plane.targets.size()) {
      work->unavailable = true;
      --work->pending;
      continue;
    }
    auto target = plane.targets[target_index];
    target->writing = true;
    auto token = viz::mojom::RemoteKitFrameToken::New();
    token->generation = plane.generation;
    token->slot = work->begin.identity.slot;
    token->value = work->begin.identity.value;
    token->target_index = target_index;
    const auto args = plane.host->CreateBeginFrameArgs(now, interval);
    owner_.trace_.Add("rend_plane_issue", work->begin.identity, read.metadata.webview_id);
    plane.host->compositor()->IssueRemoteKitBeginFrame(
        args, std::move(token),
        base::BindOnce(&Generation::PlaneResult, owner_.shared_from_this(), work, index, target,
                       static_cast<uint32_t>(target_index)));
  }
  issuing_ = false;
  if (!work->pending)
    owner_.CompleteWork();
}

bool Scheduler::HasFutureDemand() const {
  for (const auto& [id, plane] : owner_.plane_pool_.planes_) {
    if (!plane->enabled || !plane->host || plane->retired)
      continue;
    if (!plane->host->begin_frame_demand_known() || plane->host->needs_begin_frames())
      return true;
  }
  return false;
}

void Scheduler::MaybeWake() {
  // A manual Begin temporarily registers Display itself as an observer.
  // Its false notification precedes the associated terminal result. Only
  // inspect the settled level after every root/request has completed.
  if (!wake_proof_.pending() || owner_.retirement_.stopping_ || owner_.failed_ || work_ ||
      !queue_.empty())
    return;
  bool wake = wake_proof_.rebind_requested();
  for (const auto& [id, plane] : owner_.plane_pool_.planes_) {
    if (plane->enabled && plane->host && !plane->retired &&
        plane->host->begin_frame_demand_known() && plane->host->needs_begin_frames())
      wake = true;
  }
  if (wake) {
    const auto identity = *wake_proof_.pending();
    if (owner_.atlas_.channel_ && owner_.atlas_.channel_->Wake(identity))
      wake_proof_.Delivered(identity);
  }
}

void Scheduler::FinishReject(RenderRejectReason reason) {
  CHECK(work_->state == RenderRequestState::kRendering);
  work_->state = RenderRequestState::kRejected;
  auto begin = work_->begin;
  if (reason == RenderRejectReason::kIdle)
    wake_proof_.RecordIdle(begin.identity);
  work_.reset();
  ++rejected_;
  owner_.Reject(begin, reason);
  owner_.MaybeStopped();
  owner_.MaybeWake();
  owner_.SchedulePump();
}

void Scheduler::SchedulePump() {
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&Generation::Pump, owner_.shared_from_this()));
}

void Scheduler::Disconnected() {
  auto protect = owner_.shared_from_this();
  owner_.retirement_.channel_disconnected_ = true;
  if (!owner_.retirement_.stopping_)
    owner_.Stop();
}

void Scheduler::StopBarrier(uint64_t generation) {
  auto protect = owner_.shared_from_this();
  if (generation != owner_.generation_) {
    owner_.Fatal("render stop generation mismatch");
    return;
  }
  owner_.retirement_.stop_barrier_seen_ = true;
  owner_.Stop();
  owner_.MaybeStopped();
}

void Scheduler::MaybeStopped() {
  if (!owner_.retirement_.stop_barrier_seen_ || owner_.retirement_.stopped_sent_ ||
      owner_.failed_ || work_ || !queue_.empty())
    return;
  // This FIFO acknowledgement proves admission has drained, never that GPU
  // writes/Endpoint reads completed. The Generation still owns every fence lease.
  owner_.retirement_.stopped_sent_ = true;
  owner_.trace_.Save();
  if (owner_.atlas_.channel_)
    owner_.atlas_.channel_->Stopped(owner_.generation_);
}

base::DictValue Scheduler::Status() const {
  return base::DictValue()
      .Set("kind", "osr-renderer")
      .Set("generation", Number(owner_.generation_))
      .Set("completionTime", "unmeasured")
      .Set("status", int(owner_.status_))
      .Set("error", owner_.error_)
      .Set("slotCount", int(kRenderSlotCount))
      .Set("submitted", Number(submitted_))
      .Set("rejected", Number(rejected_))
      .Set("pending", int(queue_.size() + (work_ ? 1 : 0)));
}

void Scheduler::TraceInput(const char* stage, const InputEvent& input, int status) {
  owner_.trace_.Add(stage, {}, 0, status, &input);
}
}  // namespace remotekit::browser::osr
