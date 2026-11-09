#include "browser/control_response.h"
#include "remotekit/browser/osr/generation.h"
#include "remotekit/browser/osr/cache_policy.h"
#include "base/check.h"
#include "base/containers/span.h"

namespace remotekit::browser::osr {
bool SamePixelIdentity(const SharedAtlasView& a, const SharedAtlasView& b) {
  return a.session_id == b.session_id && a.webview_id == b.webview_id &&
         a.instance_generation == b.instance_generation &&
         a.document_generation == b.document_generation && a.x_pixels == b.x_pixels &&
         a.y_pixels == b.y_pixels && a.width_pixels == b.width_pixels &&
         a.height_pixels == b.height_pixels && a.atlas_pixels_per_dip == b.atlas_pixels_per_dip &&
         a.page_device_scale_factor == b.page_device_scale_factor;
}
uint64_t HandleValue(HANDLE handle) {
  return static_cast<uint64_t>(reinterpret_cast<uintptr_t>(handle));
}
void Publish(volatile LONG64* sequence,
             SharedAtlasFrame* destination,
             const SharedAtlasFrame& frame) {
  InterlockedIncrement64(sequence);
  *destination = frame;
  InterlockedIncrement64(sequence);
}
namespace {
base::DictValue Failure(protocol::ErrorCode code, const std::string& message) {
  return ControlResult::Failure(0, code, message);
}
}  // namespace

Atlas::~Atlas() {
  if (mapping_)
    UnmapViewOfFile(mapping_.get());
}

Generation::Generation(uint32_t width, uint32_t height, uint64_t generation)
    : width_(width),
      height_(height),
      generation_(generation),
      trace_(generation),
      plane_pool_(*this),
      scheduler_(*this),
      atlas_(*this),
      retirement_(*this) {
  atlas_.Initialize();
}
void Atlas::Initialize() {
  if (gpu_fault_sealed) {
    owner_.Fatal("previous OSR GPU fault remains sealed");
    return;
  }
  if (!owner_.width_ || !owner_.height_ || owner_.width_ > 16384 || owner_.height_ > 16384 ||
      !owner_.generation_) {
    owner_.Fatal("invalid OSR dimensions/generation");
    return;
  }
  mapping_handle_.Set(CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0,
                                         sizeof(SharedRenderMapping), nullptr));
  if (mapping_handle_.is_valid())
    mapping_ = static_cast<SharedRenderMapping*>(MapViewOfFile(
        mapping_handle_.Get(), FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, sizeof(SharedRenderMapping)));
  if (!mapping_) {
    owner_.Fatal("render mapping allocation failed");
    return;
  }
  *mapping_ = SharedRenderMapping{};
  mapping_->magic = kSharedRenderMagic;
  mapping_->version = kSharedRenderVersion;
  mapping_->mapping_size = sizeof(SharedRenderMapping);
  auto error = owner_.device_.Initialize();
  if (!error.empty()) {
    owner_.Fatal(std::move(error));
    return;
  }
  for (auto& slot : slots_) {
    if (!owner_.device_.CreateTexture(gfx::Size(owner_.width_, owner_.height_), slot.texture,
                                      slot.texture_handle) ||
        FAILED(owner_.device_.device->CreateRenderTargetView(slot.texture.Get(), nullptr,
                                                             &slot.rtv)) ||
        !owner_.device_.CreateFence(slot.ready, slot.ready_handle) ||
        !owner_.device_.CreateFence(slot.consumed, slot.consumed_handle)) {
      owner_.Fatal("OSR slot resources allocation failed");
      return;
    }
  }
}

void Generation::PublishClipboardSequence(uint64_t sequence) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_);
  if (atlas_.mapping_) {
    InterlockedExchange64(reinterpret_cast<volatile LONG64*>(&atlas_.mapping_->clipboard_sequence),
                          static_cast<LONG64>(sequence));
  }
}

bool Atlas::RefreshCurrentWork(Work& work) {
  if (work.reads.size() != owner_.plane_pool_.order_.size())
    return false;
  for (size_t i = 0; i < work.reads.size(); ++i) {
    auto& read = work.reads[i];
    if (read.metadata.webview_id != owner_.plane_pool_.order_[i])
      return false;
    const auto current = owner_.plane_pool_.planes_.find(owner_.plane_pool_.order_[i]);
    if (current == owner_.plane_pool_.planes_.end() || current->second != read.plane ||
        read.plane->retired || read.enabled != read.plane->enabled ||
        !SamePixelIdentity(read.metadata, read.plane->metadata))
      return false;
  }
  // UI sequence: after the identity pass no layout can change before atlas
  // submission. Publish the latest harmless focus/caret metadata without
  // throwing away an otherwise valid rendered frame.
  for (auto& read : work.reads)
    read.metadata = read.plane->metadata;
  work.revision = owner_.plane_pool_.revision_;
  return true;
}

void Atlas::CompleteWork() {
  auto work = owner_.scheduler_.work_;
  if (work->lost) {
    owner_.Fatal("Viz OSR write completion unknown/lost");
    return;
  }
  if (owner_.failed_)
    return;
  // No atlas read/write has been submitted yet. Stale work may be rejected
  // even if roots submitted writes: each root's target remains in its pool
  // (including retired pools) until its real producer fence completes.
  if (!owner_.RefreshCurrentWork(*work)) {
    owner_.FinishReject(RenderRejectReason::kNotReady);
    return;
  }
  bool missing = false;
  for (const auto& read : work->reads)
    if (read.enabled && !read.target)
      missing = true;
  // Submitted writes must retain their target even when a sibling root has
  // no output. Cache owns those real writes; they are never guessed complete.
  if (auto reject = CachedWorkReject(missing, work->updated, work->begin.force,
                                     work->revision == published_revision_)) {
    owner_.FinishReject(*reject);
    return;
  }
  CHECK(work->state == RenderRequestState::kRendering);
  work->state = RenderRequestState::kComposing;
  auto& slot = slots_[work->begin.identity.slot];
  // A previous ready point must already be complete before any stale lease
  // storage can be removed. Consumed alone cannot release source read leases.
  if (!slot.reads.empty()) {
    auto done = slot.ready->GetCompletedValue();
    if (done == kRemoved || done < slot.read_value) {
      owner_.Fatal("slot consumed without producer ready completion");
      return;
    }
    slot.reads.clear();
  }
  owner_.trace_.Add("rend_atlas_begin", work->begin.identity);
  slot.read_value = work->begin.identity.value;
  ID3D11RenderTargetView* rtv = slot.rtv.Get();
  owner_.device_.context->OMSetRenderTargets(1, &rtv, nullptr);
  constexpr float background[] = {0, 0, 0, 1};
  owner_.device_.context->ClearRenderTargetView(rtv, background);
  owner_.device_.context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
  owner_.device_.context->VSSetShader(owner_.device_.vertex_shader.Get(), nullptr, 0);
  owner_.device_.context->PSSetShader(owner_.device_.pixel_shader.Get(), nullptr, 0);
  auto* sampler = owner_.device_.sampler.Get();
  owner_.device_.context->PSSetSamplers(0, 1, &sampler);
  SharedAtlasFrame frame{};
  frame.generation = owner_.generation_;
  if (work->updated || work->revision != published_revision_ || !frame_id_)
    ++frame_id_;
  frame.frame_id = frame_id_;
  frame.ready_fence_value = work->begin.identity.value;
  frame.slot = work->begin.identity.slot;
  frame.width_pixels = owner_.width_;
  frame.height_pixels = owner_.height_;
  frame.status = SharedAtlasStatus::kRunning;
  for (const auto& read : work->reads) {
    auto metadata = read.metadata;
    if (!read.enabled || !read.target)
      metadata.reserved |= kSharedAtlasViewStale;
    base::span(frame.views)[frame.view_count++] = metadata;
    if (!read.enabled || !read.target)
      continue;
    auto target = read.target;
    // GPU-side Wait orders atlas reads after Viz's real texture write. CPU
    // submission callback is not a completed-frame notification.
    if (FAILED(owner_.device_.context->Wait(target->ready.Get(), target->value))) {
      slot.reads.push_back(target);
      owner_.Fatal("OSR plane GPU Wait failed");
      return;
    }
    slot.reads.push_back(target);
    D3D11_VIEWPORT viewport{float(metadata.x_pixels),
                            float(metadata.y_pixels),
                            float(metadata.width_pixels),
                            float(metadata.height_pixels),
                            0.f,
                            1.f};
    owner_.device_.context->RSSetViewports(1, &viewport);
    auto* srv = target->srv.Get();
    owner_.device_.context->PSSetShaderResources(0, 1, &srv);
    owner_.device_.context->Draw(3, 0);
    // Completion latency is intentionally unmeasured (capture_time_us=0).
    // Submission callbacks and Flush must never masquerade as GPU completion.
  }
  ID3D11ShaderResourceView* empty = nullptr;
  owner_.device_.context->PSSetShaderResources(0, 1, &empty);
  // Publish before the GPU can expose this ready value. The consumer first
  // waits its fence, then reads this identity-matched snapshot; metadata alone
  // grants no GPU access. A failed Signal seals the published slot forever.
  auto& publication = base::span(mapping_->slots)[frame.slot];
  Publish(reinterpret_cast<volatile LONG64*>(&publication.publication_sequence), &publication.frame,
          frame);
  owner_.trace_.Add("rend_atlas_signal_call", work->begin.identity);
  if (FAILED(owner_.device_.context->Signal(slot.ready.Get(), work->begin.identity.value))) {
    owner_.Fatal("OSR atlas GPU Signal failed");
    return;
  }
  CHECK(work->state == RenderRequestState::kComposing);
  work->state = RenderRequestState::kSignalQueued;
  owner_.device_.context->Flush();
  owner_.trace_.Add("rend_atlas_flush_return", work->begin.identity);
  slot.last_value = work->begin.identity.value;
  slot.reserved = false;
  latest_frame_ = frame;
  published_revision_ = work->revision;
  owner_.status_ =
      owner_.retirement_.stopping_ ? SharedAtlasStatus::kStopped : SharedAtlasStatus::kRunning;
  owner_.PublishLayout();
  ++owner_.scheduler_.submitted_;
  owner_.scheduler_.work_.reset();
  owner_.MaybeStopped();
  owner_.MaybeWake();
  owner_.SchedulePump();
}

void Atlas::PublishLayout() {
  if (!mapping_)
    return;
  auto frame = latest_frame_;
  frame.generation = owner_.generation_;
  frame.width_pixels = owner_.width_;
  frame.height_pixels = owner_.height_;
  frame.status = owner_.status_;
  frame.view_count = 0;
  for (auto id : owner_.plane_pool_.order_) {
    auto& plane = *owner_.plane_pool_.planes_.at(id);
    auto v = plane.metadata;
    if (!plane.enabled || !plane.latest)
      v.reserved |= kSharedAtlasViewStale;
    base::span(frame.views)[frame.view_count++] = v;
  }
  Publish(reinterpret_cast<volatile LONG64*>(&mapping_->publication_sequence),
          &mapping_->latest_layout, frame);
}

base::DictValue Atlas::Describe(uint32_t pid) {
  if (owner_.failed_ || owner_.retirement_.stopping_)
    return Failure(protocol::ErrorCode::kUnavailable,
                   owner_.error_.empty() ? "OSR stopped" : owner_.error_);
  if (consumer_) {
    if (consumer_->pid == pid) {
      if (render_endpoint_delivered_)
        return Failure(protocol::ErrorCode::kConflict, "render endpoint already delivered");
      return owner_.Description();
    }
    return Failure(protocol::ErrorCode::kConflict, "one consumer per generation");
  }
  if (!pid)
    return Failure(protocol::ErrorCode::kInvalidRequest, "invalid consumer pid");
  auto consumer = std::make_unique<Consumer>();
  consumer->pid = pid;
  consumer->process.Set(OpenProcess(PROCESS_DUP_HANDLE | SYNCHRONIZE, FALSE, pid));
  if (!consumer->process.is_valid())
    return Failure(protocol::ErrorCode::kUnavailable, "OpenProcess consumer failed");
  std::array<HANDLE, 1 + 3 * kRenderSlotCount> handles{};
  handles[0] = mapping_handle_.Get();
  for (size_t i = 0; i < slots_.size(); ++i) {
    handles[1 + i] = slots_[i].ready_handle.Get();
    handles[1 + kRenderSlotCount + i] = slots_[i].consumed_handle.Get();
    handles[1 + 2 * kRenderSlotCount + i] = slots_[i].texture_handle.Get();
  }
  size_t copied = 0;
  for (; copied < handles.size(); ++copied) {
    HANDLE remote = nullptr;
    if (!DuplicateHandle(GetCurrentProcess(), handles[copied], consumer->process.Get(), &remote, 0,
                         FALSE, DUPLICATE_SAME_ACCESS))
      break;
    consumer->handles[copied] = HandleValue(remote);
  }
  if (copied != handles.size()) {
    for (size_t i = 0; i < copied; ++i) {
      HANDLE local = nullptr;
      if (DuplicateHandle(consumer->process.Get(),
                          reinterpret_cast<HANDLE>(static_cast<uintptr_t>(consumer->handles[i])),
                          GetCurrentProcess(), &local, 0, FALSE,
                          DUPLICATE_CLOSE_SOURCE | DUPLICATE_SAME_ACCESS))
        CloseHandle(local);
    }
    return Failure(protocol::ErrorCode::kInternal, "DuplicateHandle consumer failed");
  }
  consumer_ = std::move(consumer);
  return owner_.Description();
}

mojo::ScopedMessagePipeHandle Atlas::TakeRenderEndpoint(std::string_view token, uint32_t pid) {
  if (owner_.failed_ || owner_.retirement_.stopping_ || !consumer_ || consumer_->pid != pid ||
      token != channel_token_ || render_endpoint_delivered_ || !pending_render_endpoint_.is_valid())
    return {};
  render_endpoint_delivered_ = true;
  return std::move(pending_render_endpoint_);
}

base::DictValue Atlas::Description() const {
  base::ListValue ready, consumed, textures;
  for (size_t i = 0; i < slots_.size(); ++i) {
    ready.Append(Number(consumer_->handles[1 + i]));
    consumed.Append(Number(consumer_->handles[1 + kRenderSlotCount + i]));
    textures.Append(Number(consumer_->handles[1 + 2 * kRenderSlotCount + i]));
  }
  return base::DictValue()
      .Set("ok", true)
      .Set("generation", Number(owner_.generation_))
      .Set("width", int(owner_.width_))
      .Set("height", int(owner_.height_))
      .Set("mapping_size", int(sizeof(SharedRenderMapping)))
      .Set("mapping_handle", Number(consumer_->handles[0]))
      .Set("ready_fence_handles", std::move(ready))
      .Set("consumed_fence_handles", std::move(consumed))
      .Set("texture_handles", std::move(textures))
      .Set("render_channel", channel_token_)
      .Set("adapter_luid_low", Number(owner_.device_.luid.LowPart))
      .Set("adapter_luid_high", base::NumberToString(int32_t(owner_.device_.luid.HighPart)));
}
}  // namespace remotekit::browser::osr
