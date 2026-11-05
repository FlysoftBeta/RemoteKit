#include "remotekit/browser/osr/generation.h"
#include "services/viz/privileged/mojom/compositing/remotekit_output.mojom.h"
#include <algorithm>
#include "base/check.h"
#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "mojo/public/cpp/platform/platform_handle.h"
#include "ui/compositor/compositor.h"
#include "ui/gfx/gpu_memory_buffer_handle.h"
#include "content/public/browser/gpu_data_manager.h"
#include "gpu/config/gpu_info.h"

namespace remotekit::browser::osr {
namespace {
uint64_t plane_generation = 0;
}
uint64_t NextPlaneGeneration() {
  return ++plane_generation;
}
base::win::ScopedHandle Duplicate(HANDLE handle) {
  HANDLE copy = nullptr;
  if (!DuplicateHandle(GetCurrentProcess(), handle, GetCurrentProcess(), &copy, 0, FALSE,
                       DUPLICATE_SAME_ACCESS))
    return {};
  return base::win::ScopedHandle(copy);
}
namespace {
base::DictValue Failure(const std::string& error) {
  return base::DictValue().Set("ok", false).Set("error", error);
}
}  // namespace

void PlanePool::SetViews(std::vector<View> views) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(owner_.sequence_);
  if (owner_.retirement_.stopping_ || owner_.failed_)
    return;
  if (views.size() > kSharedAtlasMaxViews) {
    owner_.Fatal("too many OSR planes");
    return;
  }
  std::map<uint64_t, std::shared_ptr<Plane>> next;
  std::vector<uint64_t> order;
  bool changed = views.size() != planes_.size();
  for (const auto& view : views) {
    const auto& v = view.metadata;
    if (!v.webview_id || !v.width_pixels || !v.height_pixels || v.x_pixels < 0 || v.y_pixels < 0 ||
        uint64_t(v.x_pixels) + v.width_pixels > owner_.width_ ||
        uint64_t(v.y_pixels) + v.height_pixels > owner_.height_ || next.contains(v.webview_id)) {
      owner_.Fatal("invalid OSR plane layout");
      return;
    }
    if (view.render_enabled && !view.offscreen_host) {
      owner_.Fatal("native-window OSR output unsupported; use offscreen service host");
      return;
    }
    if (view.offscreen_host && view.offscreen_host->rebound_with_unretired_gpu_work()) {
      owner_.Fatal("Viz root rebound with unretired OSR producer work");
      return;
    }
    gfx::Size size;
    if (view.offscreen_host && view.offscreen_host->compositor())
      size = view.offscreen_host->compositor()->size();
    auto old = planes_.find(v.webview_id);
    std::shared_ptr<Plane> plane;
    if (old != planes_.end() && old->second->host.get() == view.offscreen_host &&
        !old->second->retired && old->second->size == size &&
        old->second->metadata.instance_generation == v.instance_generation &&
        old->second->metadata.document_generation == v.document_generation) {
      plane = old->second;
      changed |= base::byte_span_from_ref(base::allow_nonunique_obj, plane->metadata) !=
                     base::byte_span_from_ref(base::allow_nonunique_obj, v) ||
                 plane->enabled != view.render_enabled;
    } else {
      plane = std::make_shared<Plane>();
      plane->size = size;
      plane->generation = NextPlaneGeneration();
      if (view.offscreen_host) {
        plane->host = view.offscreen_host->GetWeakPtr();
        plane->host_identity = reinterpret_cast<uintptr_t>(view.offscreen_host.get());
        plane->binding_epoch = view.offscreen_host->begin_frame_binding_epoch();
      }
      changed = true;
    }
    if (plane->host) {
      plane->host->SetNeedsBeginFrameCallback(base::BindRepeating(
          [](std::weak_ptr<Generation> weak, base::WeakPtr<OffscreenHost> host) {
            if (auto state = weak.lock())
              state->OnDemandChanged(std::move(host));
          },
          std::weak_ptr<Generation>(owner_.shared_from_this()), plane->host));
    }
    plane->metadata = v;
    plane->enabled = view.render_enabled;
    next.emplace(v.webview_id, std::move(plane));
    order.push_back(v.webview_id);
  }
  changed |= order != order_;
  for (auto& [id, plane] : planes_)
    if (!next.contains(id) || next[id] != plane) {
      plane->retired = true;
      owner_.retirement_.retired_planes_.push_back(plane);
    }
  planes_ = std::move(next);
  order_ = std::move(order);
  if (changed)
    ++revision_;
  owner_.PublishLayout();
}

bool PlanePool::Configure(const std::shared_ptr<Plane>& plane) {
  if (plane->configured)
    return true;
  const auto now = base::TimeTicks::Now();
  if (plane->configure_deadline.is_null())
    plane->configure_deadline = now + base::Seconds(5);
  if (now >= plane->configure_deadline) {
    const auto info = content::GpuDataManager::GetInstance()->GetGPUInfo();
    owner_.Fatal("hardware ANGLE D3D11/Ganesh OSR configuration failed within 5 seconds; ANGLE=" +
                 info.gl_renderer + "; adapter=" + info.active_gpu().device_string);
    return false;
  }
  if (plane->configuring || !plane->host || plane->size.IsEmpty() ||
      now < plane->next_configure_attempt)
    return false;
  // A different pool for this Aura root may still be finishing a Viz write.
  // Its resources (including GPU-process Skia backing) must retire first.
  for (const auto& old : owner_.retirement_.retired_planes_) {
    if (old->host.get() != plane->host.get())
      continue;
    if (old->configuring) {
      plane->next_configure_attempt = now + base::Milliseconds(50);
      return false;
    }
    for (const auto& target : old->targets) {
      if (!target)
        continue;
      const auto done = target->ready->GetCompletedValue();
      if (target->writing || done == kRemoved || done < target->value) {
        plane->next_configure_attempt = now + base::Milliseconds(50);
        return false;
      }
    }
  }
  auto config = viz::mojom::RemoteKitOutputConfig::New();
  config->generation = plane->generation;
  config->adapter_luid =
      (uint64_t(uint32_t(owner_.device_.luid.HighPart)) << 32) | owner_.device_.luid.LowPart;
  config->size = plane->size;
  for (auto& target : plane->targets) {
    // A failed Configure has submitted no writes to this pool. Keep its
    // textures/fences and duplicate handles again instead of allocating five
    // more resources for every Endpoint Begin during a transient retirement.
    if (!target) {
      target = std::make_shared<Target>();
      if (!owner_.device_.CreateTexture(plane->size, target->texture, target->texture_handle) ||
          !owner_.device_.CreateFence(target->ready, target->ready_handle) ||
          FAILED(owner_.device_.device->CreateShaderResourceView(target->texture.Get(), nullptr,
                                                                 &target->srv))) {
        owner_.Fatal("OSR plane resources allocation failed");
        return false;
      }
    }
    auto texture = Duplicate(target->texture_handle.Get());
    auto fence = Duplicate(target->ready_handle.Get());
    if (!texture.is_valid() || !fence.is_valid()) {
      owner_.Fatal("OSR handle duplicate failed");
      return false;
    }
    config->targets.emplace_back(gfx::DXGIHandle(std::move(texture)));
    config->ready_fences.emplace_back(std::move(fence));
  }
  if (!plane->retirement_probe_registered) {
    plane->retirement_probe_registered = true;
    // Every pool ever imported by this host participates in its destruction
    // barrier. Replacing the latest plane never forgets old producer writes.
    plane->host->AddGpuRetirementProbe(base::BindRepeating(
        [](std::shared_ptr<Plane> retained, ComPtr<ID3D11Device5> device) {
          if (FAILED(device->GetDeviceRemovedReason()))
            return true;
          for (const auto& target : retained->targets)
            if (target && target->ready->GetCompletedValue() == kRemoved)
              return true;
          if (retained->configuring)
            return false;
          for (const auto& target : retained->targets) {
            if (!target)
              continue;
            if (target->writing || target->ready->GetCompletedValue() < target->value)
              return false;
          }
          return true;
        },
        plane, owner_.device_.device));
  }
  plane->configuring = true;
  plane->host->compositor()->ConfigureRemoteKitOutput(
      std::move(config), base::BindOnce(&Generation::Configured, owner_.shared_from_this(), plane));
  return false;
}

void PlanePool::Configured(std::shared_ptr<Plane> plane, bool ok) {
  plane->configuring = false;
  plane->configured = ok;
  if (!ok) {
    plane->next_configure_attempt = base::TimeTicks::Now() + base::Milliseconds(50);
    // Configure() supplies the terminal diagnostics at its bounded deadline.
  }
  // False can mean an old GPU-process backing is still retiring. Retry only
  // on a future Endpoint Begin; this callback never creates a render clock.
}

void PlanePool::PlaneResult(std::shared_ptr<Work> work,
                            size_t index,
                            std::shared_ptr<Target> target,
                            uint32_t target_index,
                            viz::mojom::RemoteKitFrameResultPtr result) {
  if (owner_.scheduler_.work_ != work)
    return;  // Confirmed device removal retired this work.
  auto& read = work->reads[index];
  owner_.trace_.Add("rend_plane_result", work->begin.identity, read.metadata.webview_id,
                    result ? static_cast<int>(result->status) : -1);
  if (!result || !result->token || result->token->generation != read.plane->generation ||
      result->token->slot != work->begin.identity.slot ||
      result->token->value != work->begin.identity.value ||
      result->token->target_index != target_index) {
    work->lost = true;
  } else
    switch (result->status) {
      case viz::mojom::RemoteKitFrameStatus::kSubmitted:
        target->writing = false;
        target->value = work->begin.identity.value;
        read.plane->latest = target;
        read.target = target;
        work->updated = true;
        break;
      case viz::mojom::RemoteKitFrameStatus::kIdle:
        target->writing = false;
        break;
      case viz::mojom::RemoteKitFrameStatus::kNotReady:
        target->writing = false;
        // Same-identity cached pixels remain usable. CompleteWork distinguishes
        // an empty cache from a root which simply produced no new pixels.
        break;
      case viz::mojom::RemoteKitFrameStatus::kLost:
        work->lost = true;
        break;
    }
  CHECK(work->pending);
  --work->pending;
  if (!work->pending && !owner_.scheduler_.issuing_)
    owner_.CompleteWork();
}

void PlanePool::OnDemandChanged(base::WeakPtr<OffscreenHost> notified_host) {
  if (notified_host && notified_host->rebound_with_unretired_gpu_work()) {
    owner_.Fatal("Viz root rebound with unretired OSR producer work");
    return;
  }
  if (owner_.retirement_.stopping_ || owner_.failed_)
    return;
  bool replaced = false;
  for (auto& [id, current] : planes_) {
    if (!current->host || current->retired)
      continue;
    const auto epoch = current->host->begin_frame_binding_epoch();
    if (epoch == current->binding_epoch)
      continue;
    // Epoch one is normal initial binding, including the case where output
    // was opened before its first Viz frame sink existed.
    if (epoch == 1 && !current->binding_epoch) {
      current->binding_epoch = epoch;
      continue;
    }
    const auto identity = current->host_identity;
    for (const auto& [other_id, other] : planes_)
      if (other->host_identity == identity && !owner_.ProducerRetired(*other)) {
        owner_.Fatal("Viz root rebound with unretired OSR producer work");
        return;
      }
    for (const auto& old : owner_.retirement_.retired_planes_)
      if (old->host_identity == identity && !owner_.ProducerRetired(*old)) {
        owner_.Fatal("Viz root rebound with unretired OSR producer work");
        return;
      }
    auto fresh = std::make_shared<Plane>();
    fresh->host = current->host;
    fresh->host_identity = identity;
    fresh->binding_epoch = epoch;
    fresh->size = current->host->compositor()->size();
    fresh->generation = NextPlaneGeneration();
    fresh->metadata = current->metadata;
    fresh->enabled = current->enabled;
    current->retired = true;
    owner_.retirement_.retired_planes_.push_back(current);
    current = std::move(fresh);  // No old latest/configuration crosses epochs.
    replaced = true;
  }
  if (replaced) {
    ++revision_;
    owner_.PublishLayout();
    // Idle Endpoint admission needs one wake even if this newly bound root
    // has not published its first producer observer yet.
    owner_.scheduler_.wake_proof_.RequestRebindWake();
  }
  owner_.MaybeWake();
}

void PlanePool::StopView(uint64_t id) {
  auto it = planes_.find(id);
  if (it == planes_.end())
    return;
  it->second->enabled = false;
  it->second->retired = true;
  it->second->host.reset();
  ++revision_;
  owner_.PublishLayout();
}

base::DictValue PlanePool::RenderStatus(uint64_t id) const {
  auto it = planes_.find(id);
  if (it == planes_.end())
    return Failure("unknown OSR plane");
  auto& plane = *it->second;
  return base::DictValue()
      .Set("kind", "custom-osr")
      .Set("enabled", plane.enabled)
      .Set("configured", plane.configured)
      .Set("cached", bool(plane.latest))
      .Set("width", plane.size.width())
      .Set("height", plane.size.height())
      .Set("targets", int(kPlaneTargets));
}
}  // namespace remotekit::browser::osr
