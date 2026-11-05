#include "remotekit/browser/osr/generation.h"
#include <algorithm>
#include "base/check.h"
#include "base/logging.h"

namespace remotekit::browser::osr {
bool gpu_fault_sealed = false;

Generation::~Generation() {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_);
  trace_.Save();
}

bool Retirement::ProducerRetired(const Plane& plane) const {
  if (plane.configuring)
    return false;
  for (const auto& target : plane.targets) {
    if (!target)
      continue;
    const auto done = target->ready->GetCompletedValue();
    if (target->writing || done == kRemoved || done < target->value)
      return false;
  }
  return true;
}

void Retirement::Fatal(std::string error) {
  if (owner_.failed_)
    return;
  owner_.failed_ = true;
  owner_.error_ = std::move(error);
  LOG(ERROR) << "RemoteKit OSR generation " << owner_.generation_ << ": " << owner_.error_;
  if (owner_.scheduler_.work_)
    owner_.trace_.Add("rend_fatal", owner_.scheduler_.work_->begin.identity);
  owner_.trace_.Save();
  gpu_fault_sealed = true;
  owner_.status_ = SharedAtlasStatus::kFailed;
  owner_.PublishLayout();
  // Do not emit Reject after an uncertain GPU submission. Resources remain
  // sealed until device removal; Stop/Poll retains ownership independently.
  if (owner_.atlas_.channel_)
    owner_.atlas_.channel_->Close();
}

void Retirement::Stop() {
  auto protect = owner_.shared_from_this();
  if (stopping_)
    return;
  stopping_ = true;
  owner_.scheduler_.wake_proof_.Stop();
  keepalive_ = owner_.shared_from_this();
  if (!owner_.failed_)
    owner_.status_ = SharedAtlasStatus::kStopped;
  for (auto& request : owner_.scheduler_.queue_) {
    CHECK(request.state == RenderRequestState::kAdmitted);
    request.state = RenderRequestState::kRejected;
    owner_.Reject(request.begin, RenderRejectReason::kStopped);
  }
  owner_.scheduler_.queue_.clear();
  for (auto& [id, plane] : owner_.plane_pool_.planes_) {
    plane->retired = true;
    plane->host.reset();
  }
  owner_.PublishLayout();
  if (!owner_.atlas_.channel_)
    channel_disconnected_ = true;
  if (!owner_.atlas_.render_endpoint_delivered_) {
    owner_.atlas_.pending_render_endpoint_.reset();
    if (owner_.atlas_.channel_)
      owner_.atlas_.channel_->Close();
  }
  // output.close travels on Control, while Begin travels on the render FIFO.
  // Keep receiving/rejecting Begin until its ordered Stop barrier arrives.
  owner_.MaybeStopped();
  owner_.Poll();
}

void Retirement::Poll() {
  auto protect = owner_.shared_from_this();
  bool removed = owner_.device_.device && FAILED(owner_.device_.device->GetDeviceRemovedReason());
  bool pending = false;
  for (auto& slot : owner_.atlas_.slots_) {
    if (!slot.ready || !slot.consumed)
      continue;
    const auto ready = slot.ready->GetCompletedValue();
    const auto consumed = slot.consumed->GetCompletedValue();
    removed |= ready == kRemoved || consumed == kRemoved;
    if (removed || (slot.read_value && ready >= slot.read_value))
      slot.reads.clear();
    if (slot.last_value && consumed < slot.last_value)
      pending = true;
    if (!slot.reads.empty())
      pending = true;
  }
  auto check_plane = [&](const std::shared_ptr<Plane>& plane) {
    if (plane->configuring)
      pending = true;
    for (const auto& target : plane->targets) {
      if (!target)
        continue;
      if (target->writing || (target->value && target->ready->GetCompletedValue() < target->value))
        pending = true;
    }
  };
  for (auto& [id, plane] : owner_.plane_pool_.planes_)
    check_plane(plane);
  for (auto& plane : retired_planes_)
    check_plane(plane);
  std::erase_if(retired_planes_, [&](const std::shared_ptr<Plane>& plane) {
    if (removed)
      return true;
    if (plane->configuring)
      return false;
    for (auto& target : plane->targets) {
      if (!target)
        continue;
      const auto done = target->ready->GetCompletedValue();
      if (target->writing || done == kRemoved || done < target->value)
        return false;
    }
    return true;
  });
  if (owner_.scheduler_.work_)
    for (auto& read : owner_.scheduler_.work_->reads)
      check_plane(read.plane);
  if (removed && !owner_.failed_)
    owner_.Fatal("OSR D3D device removed");
  // Admission drain is separate from GPU retirement. Every known Endpoint
  // read retains its slot until that exact consumed fence value completes.
  if (stopping_ && (channel_disconnected_ || stopped_sent_) &&
      (removed || (!pending && !owner_.scheduler_.work_))) {
    timer_.Stop();
    owner_.plane_pool_.planes_.clear();
    retired_planes_.clear();
    owner_.scheduler_.work_.reset();
    keepalive_.reset();
  }
}
}  // namespace remotekit::browser::osr
