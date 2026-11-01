#include "remotekit/browser/gpu_atlas.h"
#include "remotekit/capture_geometry.hpp"

#include <d3d11_4.h>
#include <dxgi1_2.h>
#include <windows.h>
#include <wrl/client.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include "base/check.h"
#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/environment.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/feature_list.h"
#include "base/json/json_writer.h"
#include "base/process/process_handle.h"
#include "base/sequence_checker.h"
#include "base/strings/string_number_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "base/task/task_features.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "base/win/scoped_handle.h"
#include "components/viz/host/client_frame_sink_video_capturer.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "media/base/video_types.h"
#include "media/capture/mojom/video_capture_buffer.mojom.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "services/viz/privileged/mojom/compositing/frame_sink_video_capture.mojom.h"
#include "ui/gfx/gpu_memory_buffer_handle.h"

namespace remotekit::browser {
namespace {
using Microsoft::WRL::ComPtr;
constexpr uint32_t kStale = kSharedAtlasViewStale;
constexpr uint64_t kRemoved = std::numeric_limits<uint64_t>::max();
BASE_FEATURE(kRemoteKitSinglePlaneDirect, "RemoteKitSinglePlaneDirect",
             base::FEATURE_DISABLED_BY_DEFAULT);
std::string Number(uint64_t value) {
  return base::NumberToString(value);
}
base::DictValue Failure(const std::string& message, bool pending = false) {
  return base::DictValue().Set("ok", false).Set("error", message).Set("pending", pending);
}
uint64_t HandleValue(HANDLE handle) {
  return static_cast<uint64_t>(reinterpret_cast<uintptr_t>(handle));
}
bool SameTextInput(const SharedAtlasTextInput& a, const SharedAtlasTextInput& b) {
  return a.type == b.type && a.flags == b.flags && a.caret_x == b.caret_x &&
         a.caret_y == b.caret_y && a.caret_width == b.caret_width &&
         a.caret_height == b.caret_height && a.selection_start == b.selection_start &&
         a.selection_end == b.selection_end && a.composition_start == b.composition_start &&
         a.composition_end == b.composition_end;
}
}  // namespace

class GpuAtlas::State : public std::enable_shared_from_this<GpuAtlas::State> {
 public:
  struct Capture final : content::WebContentsObserver, viz::mojom::FrameSinkVideoConsumer {
    explicit Capture(State* owner) : owner(owner) {}
    ~Capture() override { Stop(); }
    void Rebind(content::WebContents* contents) { Observe(contents); }
    void Stop() {
      geometry.Stop();
      geometry_error.clear();
      if (capturer)
        capturer->StopAndResetConsumer();
      capturer.reset();
      capture_count.RunAndReset();
      identity = 0;
      mutex_busy_since = {};
    }
    void OnFrameCaptured(
        media::mojom::VideoBufferHandlePtr data,
        media::mojom::VideoFrameInfoPtr info,
        const gfx::Rect& content_rect,
        mojo::PendingRemote<viz::mojom::FrameSinkVideoConsumerFrameCallbacks> callbacks) override {
      owner->CaptureFrame(*this, std::move(data), std::move(info), content_rect,
                          std::move(callbacks));
    }
    void OnNewCaptureVersion(const media::CaptureVersion&) override {}
    void OnFrameWithEmptyRegionCapture() override {}
    void OnStopped() override { restart = true; }
    void OnLog(const std::string&) override {}
    void WebContentsDestroyed() override {
      Stop();
      Observe(nullptr);
      stale = true;
      owner->MarkLastStale(metadata.webview_id);
    }
    raw_ptr<State> owner;
    SharedAtlasView metadata{};
    bool enabled = false;
    bool manually_stopped = false;
    bool stale = true;
    bool restart = false;
    uintptr_t identity = 0;
    base::TimeTicks mutex_busy_since;
    CaptureGeometryWait geometry;
    std::string geometry_error;
    base::ScopedClosureRunner capture_count;
    std::unique_ptr<viz::ClientFrameSinkVideoCapturer> capturer;
  };
  struct Lease {
    uint64_t fence_value = 0;
    ComPtr<ID3D11Texture2D> source;
    gfx::GpuMemoryBufferHandle handle;
    mojo::Remote<viz::mojom::FrameSinkVideoConsumerFrameCallbacks> callbacks;
    base::TimeTicks submitted;
    uint64_t capture_serial = 0;
    int64_t capture_time_us = 0;
  };
  struct PendingCapture {
    Lease lease;
    uint64_t webview_id = 0;
  };
  struct Consumer {
    uint32_t pid = 0;
    base::win::ScopedHandle process;
    std::array<uint64_t, 6> handles{};  // mapping, ready, consumed, textures
  };

  State(uint32_t width, uint32_t height, uint64_t generation)
      : width_(width), height_(height), generation_(generation) {
    DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_);
    precise_poll_ = base::Environment::Create()->GetVar("REMOTEKIT_GPU_POLL").value_or("") == "precise";
    auto directory = base::Environment::Create()->GetVar("REMOTEKIT_MEDIA_TRACE");
    if (!directory || directory->empty())
      directory = base::Environment::Create()->GetVar("REMOTEKIT_SERVER_TRACE");
    if (directory && !directory->empty()) {
      trace_directory_ = base::FilePath::FromUTF8Unsafe(*directory);
      trace_events_.reserve(64000);
      trace_start_high_resolution_ = base::Time::IsHighResolutionTimerInUse();
    }
    if (!width || !height || width > 16384 || height > 16384 || !generation) {
      error_ = "invalid atlas dimensions/generation";
      status_ = SharedAtlasStatus::kFailed;
      stopping_ = true;
      return;
    }
    mapping_handle_.Set(CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0,
                                           sizeof(SharedAtlasMapping), nullptr));
    if (mapping_handle_.is_valid()) {
      mapping_ = static_cast<SharedAtlasMapping*>(MapViewOfFile(
          mapping_handle_.Get(), FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, sizeof(SharedAtlasMapping)));
    }
    if (!mapping_) {
      error_ = "shared atlas mapping allocation failed";
      status_ = SharedAtlasStatus::kFailed;
      stopping_ = true;
      return;
    }
    *mapping_ = SharedAtlasMapping{};
    mapping_->magic = kSharedAtlasMagic;
    mapping_->version = kSharedAtlasVersion;
    mapping_->mapping_size = sizeof(SharedAtlasMapping);
    last_frame_.generation = generation;
    last_frame_.width_pixels = width;
    last_frame_.height_pixels = height;
    PublishStatus();
  }
  ~State() {
    DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_);
    // A submitted GPU read is never released merely because an owner stopped.
    CHECK(leases_.empty());
    if (mapping_)
      UnmapViewOfFile(mapping_.get());
  }
  void StartTimer() {
    if (precise_poll_) {
      ArmPrecisePoll();
      return;
    }
    timer_.Start(FROM_HERE, base::Milliseconds(2),
                 base::BindRepeating(&State::Poll, base::Unretained(this)));
  }
  void ArmPrecisePoll() {
    precise_timer_.Start(FROM_HERE, base::TimeTicks::Now() + base::Milliseconds(2),
                         this, &State::PrecisePoll, base::subtle::DelayPolicy::kPrecise);
  }
  void PrecisePoll() {
    auto protect = shared_from_this();
    Poll();
    if (!stopping_ || !leases_.empty())
      ArmPrecisePoll();
  }
  void ResetPublicationSchedule() {
    publication_timer_.Stop();
    publication_wake_ = {};
    next_publication_deadline_ = {};
  }
  void ArmPublicationWake(base::TimeTicks deadline) {
    if (stopping_ || !dirty_)
      return;
    const auto maximum = base::kMaxPreciseDelay.Get();
    auto policy = base::subtle::DelayPolicy::kPrecise;
    const auto remaining = deadline - base::TimeTicks::Now();
    if (maximum <= base::Microseconds(1)) {
      policy = base::subtle::DelayPolicy::kFlexibleNoSooner;
    } else {
      // Precise delays >= maximum are downgraded by the scheduler. Wake
      // coarsely first for low-fps publication, then arm the real deadline.
      const auto window = std::min(base::Milliseconds(32),
          maximum - std::max(base::Microseconds(1),
                            std::min(base::Milliseconds(4), maximum / 2)));
      if (remaining > window) {
        deadline -= window;
        policy = base::subtle::DelayPolicy::kFlexibleNoSooner;
      }
    }
    // Capture callbacks and the health poll may meet the same pending wake.
    // Keep its earlier admission instead of repeatedly pushing it back.
    if (publication_timer_.IsRunning() && publication_wake_ <= deadline)
      return;
    publication_wake_ = deadline;
    publication_timer_.Start(FROM_HERE, deadline, this,
        &State::PublicationWake, policy);
  }
  void PublicationWake() {
    auto protect = shared_from_this();
    publication_wake_ = {};
    Poll();  // Reap only truly completed source reads, then try publication.
  }
  void StopCaptures() {
    for (auto& [id, capture] : captures_)
      capture->Stop();
  }
  void Stop() {
    DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_);
    if (!stopping_)
      stop_time_ = base::TimeTicks::Now();
    stopping_ = true;
    ResetPublicationSchedule();
    StopCaptures();
    DropPendingCapture();
    dirty_ = false;
    if (status_ != SharedAtlasStatus::kDeviceLost && status_ != SharedAtlasStatus::kFailed)
      status_ = SharedAtlasStatus::kStopped;
    PublishStatus();
    if (!leases_.empty())
      keepalive_ = shared_from_this();
    Poll();
    SaveTrace();
  }
  void Lost(std::string message) {
    error_ = std::move(message);
    status_ = device_ && FAILED(device_->GetDeviceRemovedReason()) ? SharedAtlasStatus::kDeviceLost
                                                                   : SharedAtlasStatus::kFailed;
    stopping_ = true;
    ResetPublicationSchedule();
    stop_time_ = base::TimeTicks::Now();
    StopCaptures();
    DropPendingCapture();
    dirty_ = false;
    PublishStatus();
    if (!leases_.empty())
      keepalive_ = shared_from_this();
  }
  void PublishStatus() {
    if (!mapping_)
      return;
    last_frame_.status = status_;
    InterlockedIncrement64(reinterpret_cast<volatile LONG64*>(&mapping_->publication_sequence));
    mapping_->frame = last_frame_;
    MemoryBarrier();
    InterlockedIncrement64(reinterpret_cast<volatile LONG64*>(&mapping_->publication_sequence));
  }
  bool Valid(const SharedAtlasView& v) const {
    return v.webview_id && v.width_pixels && v.height_pixels && v.x_pixels >= 0 &&
           v.y_pixels >= 0 && uint64_t(v.x_pixels) + v.width_pixels <= width_ &&
           uint64_t(v.y_pixels) + v.height_pixels <= height_ &&
           std::isfinite(v.atlas_pixels_per_dip) && v.atlas_pixels_per_dip > 0 &&
           std::isfinite(v.page_device_scale_factor) && v.page_device_scale_factor > 0;
  }
  void SetViews(std::vector<View> views) {
    DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_);
    if (stopping_)
      return;
    if (views.size() > kSharedAtlasMaxViews) {
      error_ = "too many atlas views";
      return;
    }
    std::map<uint64_t, bool> seen;
    for (const auto& v : views) {
      if (!Valid(v.metadata) || !seen.emplace(v.metadata.webview_id, true).second) {
        error_ = "invalid/duplicate atlas view bounds or id";
        return;
      }
    }
    bool clear = false;
    bool metadata_changed = order_.size() != views.size();
    std::vector<uint64_t> order;
    for (const auto& v : views) {
      const auto id = v.metadata.webview_id;
      order.push_back(id);
      auto& entry = captures_[id];
      if (!entry) {
        entry = std::make_unique<Capture>(this);
        clear = true;
      }
      auto& c = *entry;
      metadata_changed = metadata_changed || c.metadata.session_id != v.metadata.session_id ||
                         c.metadata.instance_generation != v.metadata.instance_generation ||
                         c.metadata.document_generation != v.metadata.document_generation ||
                         c.metadata.focus_generation != v.metadata.focus_generation ||
                         c.metadata.atlas_pixels_per_dip != v.metadata.atlas_pixels_per_dip ||
                         c.metadata.page_device_scale_factor != v.metadata.page_device_scale_factor ||
                         c.metadata.reserved != v.metadata.reserved ||
                         !SameTextInput(c.metadata.text_input, v.metadata.text_input) ||
                         c.enabled != v.capture_enabled;
      auto* contents = v.contents.get();
      auto* view = contents ? contents->GetRenderWidgetHostView() : nullptr;
      const uintptr_t identity = reinterpret_cast<uintptr_t>(view);
      const bool changed = c.web_contents() != contents ||
                           c.metadata.instance_generation != v.metadata.instance_generation ||
                           c.metadata.document_generation != v.metadata.document_generation ||
                           c.metadata.x_pixels != v.metadata.x_pixels ||
                           c.metadata.y_pixels != v.metadata.y_pixels ||
                           c.metadata.width_pixels != v.metadata.width_pixels ||
                           c.metadata.height_pixels != v.metadata.height_pixels ||
                           (c.capturer && c.identity != identity);
      if (changed || c.restart) {
        c.Stop();
        c.Rebind(contents);
        c.restart = false;
        c.manually_stopped = false;
        c.stale = true;
        clear = true;
      }
      if (!c.enabled && v.capture_enabled)
        c.manually_stopped = false;
      c.enabled = v.capture_enabled;
      c.metadata = v.metadata;
      if (!c.enabled || c.manually_stopped || !view) {
        c.Stop();
        c.stale = true;
        MarkLastStale(id);
        continue;
      }
      if (!c.capturer) {
        c.Rebind(contents);
        c.capture_count = contents->IncrementCapturerCount(
            gfx::Size(v.metadata.width_pixels, v.metadata.height_pixels), false, false, false);
        c.capturer = view->CreateVideoCapturer();
        c.identity = identity;
        c.capturer->SetFormat(media::PIXEL_FORMAT_ARGB);
        c.capturer->SetMinCapturePeriod(base::Seconds(1) / fps_);
        c.capturer->SetMinSizeChangePeriod(base::TimeDelta());
        gfx::Size size(v.metadata.width_pixels, v.metadata.height_pixels);
        c.capturer->SetResolutionConstraints(size, size, true);
        c.capturer->SetAutoThrottlingEnabled(false);
        c.capturer->SetAnimationFpsLockIn(false, 0.0f);
        c.geometry.Bind(++next_capture_binding_);
        c.capturer->Start(&c, viz::mojom::BufferFormatPreference::kPreferMappableSharedImage);
      }
    }
    for (auto it = captures_.begin(); it != captures_.end();) {
      if (!seen.contains(it->first)) {
        it = captures_.erase(it);
        clear = true;
      } else
        ++it;
    }
    order_ = std::move(order);
    const bool direct = base::FeatureList::IsEnabled(kRemoteKitSinglePlaneDirect) &&
                        order_.size() == 1 && captures_.at(order_[0])->enabled &&
                        captures_.at(order_[0])->capturer;
    if (direct != single_plane_direct_) {
      single_plane_direct_ = direct;
      clear = true;
    }
    if (clear)
      ClearStage();
    else if (metadata_changed && stage_)
      dirty_ = true;
    PublishIfFree();
  }
  void ClearStage() {
    // A different geometry/document cannot inherit any direct pixels. Already
    // submitted source reads remain protected by leases_, independent of this.
    ResetPublicationSchedule();
    DropPendingCapture();
    direct_base_slot_.reset();
    direct_slot_initialized_.fill(false);
    MarkLastStale(0);
    for (auto& [id, c] : captures_) {
      c->stale = true;
      if (c->capturer)
        c->capturer->RequestRefreshFrame();
    }
    if (single_plane_direct_ && context_) {
      // Publish new stale geometry promptly even if no fresh capture arrives.
      dirty_ = true;
      capture_time_us_ = base::TimeTicks::Now().since_origin().InMicroseconds();
    }
    if (context_ && stage_rtv_ && !single_plane_direct_) {
      constexpr float white[] = {1, 1, 1, 1};
      context_->ClearRenderTargetView(stage_rtv_.Get(), white);
      dirty_ = true;
      capture_time_us_ = base::TimeTicks::Now().since_origin().InMicroseconds();
    }
    PublishIfFree();
  }
  void DropPendingCapture() {
    if (!pending_capture_)
      return;
    if (pending_capture_->lease.callbacks)
      pending_capture_->lease.callbacks->Done();
    pending_capture_.reset();
    ++dropped_;
  }
  void MarkLastStale(uint64_t id) {
    bool changed = false;
    for (auto& view : base::span(last_frame_.views).first(last_frame_.view_count)) {
      if ((id == 0 || view.webview_id == id) && !(view.reserved & kStale)) {
        view.reserved |= kStale;
        changed = true;
      }
    }
    if (changed)
      PublishStatus();
  }
  void StopView(uint64_t id) {
    DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_);
    auto it = captures_.find(id);
    if (it == captures_.end())
      return;
    it->second->manually_stopped = true;
    it->second->stale = true;
    it->second->Stop();
    if (pending_capture_ && pending_capture_->webview_id == id)
      DropPendingCapture();
    MarkLastStale(id);
    dirty_ = stage_ != nullptr;
    PublishIfFree();
  }
  void SetFps(uint32_t fps) {
    DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_);
    fps = std::clamp(fps, 1u, 120u);
    if (fps_ == fps)
      return;
    fps_ = fps;
    ResetPublicationSchedule();
    for (auto& [id, c] : captures_)
      if (c->capturer)
        c->capturer->SetMinCapturePeriod(base::Seconds(1) / fps_);
    PublishIfFree();
  }
  void RefreshGeometry(Capture& capture) {
    auto binding = capture.geometry.QueueRefresh();
    if (!binding) return;
    std::weak_ptr<State> weak = shared_from_this();
    const auto id = capture.metadata.webview_id;
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE, base::BindOnce([](std::weak_ptr<State> weak, uint64_t id, uint64_t binding) {
          auto owner = weak.lock();
          if (!owner || owner->stopping_) return;
          auto found = owner->captures_.find(id);
          if (found == owner->captures_.end()) return;
          auto& capture = *found->second;
          if (capture.capturer && capture.geometry.TakeRefresh(
                  binding, base::TimeTicks::Now().since_origin().InMicroseconds())) {
            ++owner->geometry_refreshes_;
            capture.capturer->RequestRefreshFrame();
          }
        }, weak, id, *binding), base::Milliseconds(16));
  }
  bool CreateOutput() {
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = width_;
    desc.Height = height_;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
    if (FAILED(device_->CreateTexture2D(&desc, nullptr, &stage_)) ||
        FAILED(device_->CreateRenderTargetView(stage_.Get(), nullptr, &stage_rtv_)))
      return false;
    desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED;
    for (size_t i = 0; i < slots_.size(); ++i) {
      if (FAILED(device_->CreateTexture2D(&desc, nullptr, &slots_[i])))
        return false;
      ComPtr<IDXGIResource1> resource;
      HANDLE handle = nullptr;
      if (FAILED(slots_[i].As(&resource)) ||
          FAILED(resource->CreateSharedHandle(
              nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, nullptr, &handle)))
        return false;
      slot_handles_[i].Set(handle);
    }
    if (FAILED(device_->CreateFence(0, D3D11_FENCE_FLAG_SHARED, IID_PPV_ARGS(&ready_))) ||
        FAILED(device_->CreateFence(0, D3D11_FENCE_FLAG_SHARED, IID_PPV_ARGS(&consumed_))))
      return false;
    HANDLE ready_handle = nullptr, consumed_handle = nullptr;
    if (FAILED(ready_->CreateSharedHandle(nullptr, GENERIC_ALL, nullptr, &ready_handle)))
      return false;
    ready_handle_.Set(ready_handle);
    if (FAILED(consumed_->CreateSharedHandle(nullptr, GENERIC_ALL, nullptr, &consumed_handle)))
      return false;
    consumed_handle_.Set(consumed_handle);
    ClearStage();
    return true;
  }
  bool Import(HANDLE handle, ComPtr<ID3D11Texture2D>& texture) {
    if (device_) {
      if (FAILED(device_->OpenSharedResource1(handle, IID_PPV_ARGS(&texture)))) {
        Lost("source texture cannot open on established adapter/device");
        return false;
      }
      return true;
    }
    ComPtr<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) {
      Lost("CreateDXGIFactory1 failed");
      return false;
    }
    for (UINT index = 0;; ++index) {
      ComPtr<IDXGIAdapter1> adapter;
      if (factory->EnumAdapters1(index, &adapter) == DXGI_ERROR_NOT_FOUND)
        break;
      if (!adapter)
        break;
      DXGI_ADAPTER_DESC1 info{};
      if (FAILED(adapter->GetDesc1(&info)) || (info.Flags & DXGI_ADAPTER_FLAG_SOFTWARE))
        continue;
      ComPtr<ID3D11Device> candidate;
      ComPtr<ID3D11DeviceContext> context;
      constexpr D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
      if (FAILED(D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                                   D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels, std::size(levels),
                                   D3D11_SDK_VERSION, &candidate, nullptr, &context)))
        continue;
      ComPtr<ID3D11Device5> device5;
      ComPtr<ID3D11DeviceContext4> context4;
      if (FAILED(candidate.As(&device5)) || FAILED(context.As(&context4)) ||
          FAILED(device5->OpenSharedResource1(handle, IID_PPV_ARGS(&texture))))
        continue;
      device_ = std::move(device5);
      context_ = std::move(context4);
      adapter_luid_ = info.AdapterLuid;
      if (!CreateOutput()) {
        Lost("shared atlas texture/fence creation failed");
        return false;
      }
      return true;
    }
    Lost("no hardware D3D11.4 adapter can open capture texture");
    return false;
  }
  uint64_t Signal() {
    if (!ready_ || next_fence_ == kRemoved) {
      Lost("ready fence unavailable/exhausted");
      return 0;
    }
    const uint64_t value = next_fence_++;
    if (FAILED(context_->Signal(ready_.Get(), value))) {
      Lost("GPU ready fence Signal failed");
      return 0;
    }
    context_->Flush();
    return value;
  }
  void CaptureFrame(Capture& capture,
                    media::mojom::VideoBufferHandlePtr data,
                    media::mojom::VideoFrameInfoPtr info,
                    const gfx::Rect& content_rect,
                    mojo::PendingRemote<viz::mojom::FrameSinkVideoConsumerFrameCallbacks> remote) {
    DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_);
    ++capture_callbacks_;
    Trace("capture_callback", capture_callbacks_,
          info && info->metadata.capture_end_time
              ? info->metadata.capture_end_time->since_origin().InMicroseconds() : 0,
          capture.metadata.webview_id,
          info ? info->metadata.capture_counter.value_or(-1) : -1,
          info ? info->metadata.frame_rate.value_or(0) : 0,
          info && info->metadata.capture_begin_time
              ? info->metadata.capture_begin_time->since_origin().InMicroseconds() : 0);
    mojo::Remote<viz::mojom::FrameSinkVideoConsumerFrameCallbacks> callbacks(std::move(remote));
    auto drop = [&] {
      ++dropped_;
      if (callbacks)
        callbacks->Done();
    };
    if (stopping_ || !capture.enabled || capture.manually_stopped) {
      drop();
      return;
    }
    const auto geometry_now = base::TimeTicks::Now().since_origin().InMicroseconds();
    if (capture.geometry.TimedOut(geometry_now)) {
      Lost("capture geometry transition exceeded 2000ms: " + capture.geometry_error);
      drop();
      return;
    }
    if (!data || !info || !data->is_gpu_memory_buffer_handle() ||
        info->pixel_format != media::PIXEL_FORMAT_ARGB ||
        info->coded_size !=
            gfx::Size(capture.metadata.width_pixels, capture.metadata.height_pixels) ||
        content_rect != gfx::Rect(info->coded_size)) {
      const char* bucket = !data ? "missing-buffer" : !info ? "missing-info" :
          !data->is_gpu_memory_buffer_handle() ? "buffer-kind" :
          info->pixel_format != media::PIXEL_FORMAT_ARGB ? "pixel-format" :
          info->coded_size != gfx::Size(capture.metadata.width_pixels,
                                       capture.metadata.height_pixels) ? "coded-size" : "content-rect";
      const auto detail = std::string("output invalid: capture is not exact-size BGRA ARGB GPU data bucket=") +
           bucket + " view=" + Number(capture.metadata.webview_id) +
           " requested=" + gfx::Size(capture.metadata.width_pixels,
                                     capture.metadata.height_pixels).ToString() +
           " coded=" + (info ? info->coded_size.ToString() : "none") +
           " visible=" + (info ? info->visible_rect.ToString() : "none") +
           " natural=" + (info ? info->natural_size.ToString() : "none") +
           " content=" + content_rect.ToString() +
           " pixel_format=" + (info ? media::VideoPixelFormatToString(info->pixel_format) : "none") +
           " buffer_tag=" + (data ? base::NumberToString(static_cast<int>(data->which())) : "none") +
           " gpu_handle_type=" + (data && data->is_gpu_memory_buffer_handle() ?
               base::NumberToString(static_cast<int>(data->get_gpu_memory_buffer_handle().type)) : "none");
      const bool geometry_only = data && info && data->is_gpu_memory_buffer_handle() &&
          info->pixel_format == media::PIXEL_FORMAT_ARGB &&
          data->get_gpu_memory_buffer_handle().type == gfx::DXGI_SHARED_HANDLE;
      if (geometry_only && capture.geometry.Defer(geometry_now)) {
        // Validate the real resource before granting any geometric grace. An
        // import is not a GPU read; no mismatched pixels enter the new atlas.
        ComPtr<ID3D11Texture2D> candidate;
        if (!Import(data->get_gpu_memory_buffer_handle().dxgi_handle().buffer_handle(), candidate)) {
          drop(); return;
        }
        D3D11_TEXTURE2D_DESC desc{}; candidate->GetDesc(&desc);
        ComPtr<IDXGIKeyedMutex> mutex;
        if (desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM ||
            desc.Width != static_cast<UINT>(info->coded_size.width()) ||
            desc.Height != static_cast<UINT>(info->coded_size.height()) ||
            desc.ArraySize != 1 || desc.SampleDesc.Count != 1 ||
            !(desc.MiscFlags & D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX) || FAILED(candidate.As(&mutex))) {
          Lost("output invalid: transition resource format/dimensions/keyed mutex; " + detail);
          drop(); return;
        }
        capture.geometry_error = detail;
        ++geometry_drops_;
        RefreshGeometry(capture);
        drop();
        return;
      }
      Lost(detail);
      drop();
      return;
    }
    auto handle = std::move(data->get_gpu_memory_buffer_handle());
    if (handle.type != gfx::DXGI_SHARED_HANDLE) {
      Lost("output invalid: capture is not DXGI_SHARED_HANDLE");
      drop();
      return;
    }
    ComPtr<ID3D11Texture2D> source;
    if (!Import(handle.dxgi_handle().buffer_handle(), source)) {
      drop();
      return;
    }
    D3D11_TEXTURE2D_DESC desc{};
    source->GetDesc(&desc);
    if (!trace_directory_.empty()) {
      TraceGeometry geometry{gfx::Size(capture.metadata.width_pixels, capture.metadata.height_pixels),
          info->coded_size, info->natural_size, info->visible_rect, content_rect,
          desc.Width, desc.Height, static_cast<uint32_t>(desc.Format)};
      const uint64_t view_id = capture.metadata.webview_id;
      auto previous = trace_geometry_.find(view_id);
      if (previous == trace_geometry_.end() || previous->second != geometry) {
        trace_geometry_[view_id] = geometry;
        if (trace_geometry_samples_.size() < 256) {
          trace_geometry_samples_.Append(base::DictValue()
              .Set("at_us", static_cast<double>(base::TimeTicks::Now().since_origin().InMicroseconds()))
              .Set("webview_id", Number(view_id))
              .Set("requested_width", geometry.requested.width()).Set("requested_height", geometry.requested.height())
              .Set("coded_width", geometry.coded.width()).Set("coded_height", geometry.coded.height())
              .Set("natural_width", geometry.natural.width()).Set("natural_height", geometry.natural.height())
              .Set("visible_x", geometry.visible.x()).Set("visible_y", geometry.visible.y())
              .Set("visible_width", geometry.visible.width()).Set("visible_height", geometry.visible.height())
              .Set("content_width", geometry.content.width()).Set("content_height", geometry.content.height())
              .Set("texture_width", static_cast<int>(geometry.texture_width))
              .Set("texture_height", static_cast<int>(geometry.texture_height))
              .Set("texture_format", static_cast<int>(geometry.texture_format)));
        }
      }
    }
    if (desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM || desc.Width != capture.metadata.width_pixels ||
        desc.Height != capture.metadata.height_pixels || desc.ArraySize != 1 ||
        desc.SampleDesc.Count != 1 || !(desc.MiscFlags & D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX)) {
      Lost("output invalid: unsupported capture texture format/dimensions/keyed mutex");
      drop();
      return;
    }
    if (!capture.geometry.Match(base::TimeTicks::Now().since_origin().InMicroseconds())) {
      Lost("capture geometry transition exceeded 2000ms: " + capture.geometry_error);
      drop(); return;
    }
    capture.geometry_error.clear();
    if (single_plane_direct_) {
      if (pending_capture_)
        ++direct_pending_replaced_;
      DropPendingCapture();
      PendingCapture pending;
      pending.webview_id = capture.metadata.webview_id;
      pending.lease.source = std::move(source);
      pending.lease.handle = std::move(handle);
      pending.lease.callbacks = std::move(callbacks);
      pending.lease.capture_serial = capture_callbacks_;
      pending.lease.capture_time_us = info->metadata.capture_end_time
          .value_or(base::TimeTicks::Now()).since_origin().InMicroseconds();
      pending_capture_ = std::move(pending);
      dirty_ = true;
      PublishIfFree();
      return;
    }
    ComPtr<IDXGIKeyedMutex> mutex;
    if (!LockSource(capture, source.Get(), mutex)) {
      drop();
      return;
    }
    context_->CopySubresourceRegion(stage_.Get(), 0, capture.metadata.x_pixels,
                                    capture.metadata.y_pixels, 0, source.Get(), 0, nullptr);
    ++source_stage_copies_;
    Lease lease;
    lease.source = source;
    lease.handle = std::move(handle);
    lease.callbacks = std::move(callbacks);
    lease.submitted = base::TimeTicks::Now();
    lease.capture_serial = capture_callbacks_;
    lease.capture_time_us = info->metadata.capture_end_time.value_or(lease.submitted)
                                .since_origin().InMicroseconds();
    // The source remains leased even if Signal/Release fails after the copy.
    lease.fence_value = Signal();
    leases_.push_back(std::move(lease));
    if (FAILED(mutex->ReleaseSync(0)))
      Lost("source keyed mutex ReleaseSync failed");
    if (!stopping_) {
      capture.stale = false;
      capture_time_us_ = info->metadata.capture_end_time.value_or(base::TimeTicks::Now())
                             .since_origin()
                             .InMicroseconds();
      dirty_ = true;
      ++captured_;
      PublishIfFree();
    }
    if (stopping_)
      keepalive_ = shared_from_this();
  }
  bool LockSource(Capture& capture, ID3D11Texture2D* source,
                  ComPtr<IDXGIKeyedMutex>& mutex) {
    if (FAILED(source->QueryInterface(IID_PPV_ARGS(&mutex)))) {
      Lost("output invalid: capture keyed mutex unavailable");
      return false;
    }
    const HRESULT acquired = mutex->AcquireSync(0, 0);
    if (acquired != S_OK) {
      ++mutex_drops_;
      if (acquired == static_cast<HRESULT>(WAIT_TIMEOUT) || acquired == DXGI_ERROR_WAIT_TIMEOUT) {
        if (capture.mutex_busy_since.is_null())
          capture.mutex_busy_since = base::TimeTicks::Now();
        if (base::TimeTicks::Now() - capture.mutex_busy_since >= base::Seconds(2)) {
          Lost("source keyed mutex remained busy for 2 seconds");
          return false;
        }
        // A static page may not damage again after a temporary source lock.
        std::weak_ptr<State> weak = shared_from_this();
        const auto id = capture.metadata.webview_id;
        base::SingleThreadTaskRunner::GetCurrentDefault()->PostDelayedTask(
            FROM_HERE,
            base::BindOnce(
                [](std::weak_ptr<State> weak, uint64_t id) {
                  if (auto state = weak.lock(); state && !state->stopping_) {
                    auto found = state->captures_.find(id);
                    if (found != state->captures_.end() && found->second->capturer)
                      found->second->capturer->RequestRefreshFrame();
                  }
                },
                weak, id),
            base::Milliseconds(10));
      } else {
        Lost("output invalid: source keyed mutex abandoned or failed");
      }
      return false;
    }
    capture.mutex_busy_since = {};
    return true;
  }
  void PublishIfFree() {
    if (stopping_ || !dirty_ || !consumed_ || !stage_) {
      publication_timer_.Stop();
      publication_wake_ = {};
      return;
    }
    const auto now = base::TimeTicks::Now();
    if (!next_publication_deadline_.is_null() && now < next_publication_deadline_) {
      ArmPublicationWake(next_publication_deadline_);
      return;
    }
    const auto completed = consumed_->GetCompletedValue();
    if (completed == kRemoved) {
      Lost("consumed fence reports device removal");
      return;
    }
    size_t slot = slots_.size();
    for (size_t i = 0; i < slots_.size(); ++i)
      if ((!single_plane_direct_ || direct_base_slot_ != i) &&
          (slot_values_[i] == 0 || completed >= slot_values_[i])) {
        slot = i;
        break;
      }
    if (slot == slots_.size()) {
      ++backpressure_;
      ArmPublicationWake(now + base::Milliseconds(2));
      return;
    }
    std::optional<Lease> submitted_source;
    ComPtr<IDXGIKeyedMutex> source_mutex;
    if (single_plane_direct_) {
      if (pending_capture_) {
        // Remove the unsubmitted owner before LockSource/Signal can enter Lost.
        auto pending = std::move(*pending_capture_);
        pending_capture_.reset();
        auto found = captures_.find(pending.webview_id);
        if (found == captures_.end() || !found->second->capturer ||
            !found->second->enabled || found->second->manually_stopped) {
          if (pending.lease.callbacks)
            pending.lease.callbacks->Done();
          ++dropped_;
          ArmPublicationWake(base::TimeTicks::Now() + base::Milliseconds(2));
          return;
        }
        if (!LockSource(*found->second, pending.lease.source.Get(), source_mutex)) {
          if (!stopping_) {
            // No GPU read was submitted. Keep the newest source owner until
            // retry or replacement; no ready/consumed fence is advanced.
            pending_capture_ = std::move(pending);
            ArmPublicationWake(base::TimeTicks::Now() + base::Milliseconds(2));
          } else {
            if (pending.lease.callbacks)
              pending.lease.callbacks->Done();
            ++dropped_;
          }
          return;
        }
        if (!InitializeDirectSlot(slot)) {
          if (FAILED(source_mutex->ReleaseSync(0)))
            Lost("source keyed mutex ReleaseSync failed");
          if (pending.lease.callbacks)
            pending.lease.callbacks->Done();
          ++dropped_;
          return;
        }
        auto& capture = *found->second;
        context_->CopySubresourceRegion(slots_[slot].Get(), 0,
            capture.metadata.x_pixels, capture.metadata.y_pixels, 0,
            pending.lease.source.Get(), 0, nullptr);
        ++source_slot_copies_;
        Trace("direct_source_copy", pending.lease.capture_serial,
              pending.lease.capture_time_us, slot);
        pending.lease.submitted = base::TimeTicks::Now();
        capture_time_us_ = pending.lease.capture_time_us;
        capture.stale = false;
        ++captured_;
        submitted_source = std::move(pending.lease);
      } else if (direct_base_slot_) {
        context_->CopyResource(slots_[slot].Get(), slots_[*direct_base_slot_].Get());
        direct_slot_initialized_[slot] = true;
        ++direct_metadata_copies_;
      } else if (!InitializeDirectSlot(slot)) {
        return;
      }
    } else {
      context_->CopyResource(slots_[slot].Get(), stage_.Get());
      ++stage_slot_copies_;
    }
    uint64_t value = Signal();
    if (submitted_source) {
      submitted_source->fence_value = value;
      leases_.push_back(std::move(*submitted_source));
      if (FAILED(source_mutex->ReleaseSync(0)))
        Lost("source keyed mutex ReleaseSync failed");
      if (stopping_)
        keepalive_ = shared_from_this();
    }
    if (!value || stopping_)
      return;
    slot_values_[slot] = value;
    if (single_plane_direct_)
      direct_base_slot_ = slot;
    SharedAtlasFrame frame{};
    frame.generation = generation_;
    frame.frame_id = ++frame_id_;
    Trace("atlas_publish", frame_id_, capture_time_us_, captured_);
    frame.ready_fence_value = value;
    frame.capture_time_us = capture_time_us_;
    frame.slot = static_cast<uint32_t>(slot);
    frame.width_pixels = width_;
    frame.height_pixels = height_;
    frame.status = SharedAtlasStatus::kRunning;
    std::vector<SharedAtlasView> metadata;
    for (uint64_t id : order_) {
      const auto& c = *captures_.at(id);
      auto v = c.metadata;
      if (c.stale || !c.enabled || c.manually_stopped)
        v.reserved |= kStale;
      metadata.push_back(v);
    }
    frame.view_count = static_cast<uint32_t>(metadata.size());
    base::span(frame.views).first(metadata.size()).copy_from(metadata);
    last_frame_ = frame;
    status_ = SharedAtlasStatus::kRunning;
    PublishStatus();
    dirty_ = false;
    publication_timer_.Stop();
    publication_wake_ = {};
    const auto period = base::Seconds(1) / fps_;
    const auto published_at = base::TimeTicks::Now();
    if (next_publication_deadline_.is_null())
      next_publication_deadline_ = published_at + period;
    else
      // Consume only one current frame and skip all expired phase slots,
      // including after long static periods. Never replay an accumulated debt.
      next_publication_deadline_ += period *
          ((published_at - next_publication_deadline_).IntDiv(period) + 1);
  }
  bool InitializeDirectSlot(size_t slot) {
    if (direct_slot_initialized_[slot])
      return true;
    ComPtr<ID3D11RenderTargetView> target;
    if (FAILED(device_->CreateRenderTargetView(slots_[slot].Get(), nullptr, &target))) {
      Lost("direct slot render target creation failed");
      return false;
    }
    constexpr float white[] = {1, 1, 1, 1};
    context_->ClearRenderTargetView(target.Get(), white);
    direct_slot_initialized_[slot] = true;
    ++direct_slot_clears_;
    return true;
  }
  void Poll() {
    Trace("poll", frame_id_, capture_time_us_, captured_);
    DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_);
    auto protect = shared_from_this();
    bool removed = device_ && FAILED(device_->GetDeviceRemovedReason());
    uint64_t completed = ready_ ? ready_->GetCompletedValue() : 0;
    if (completed == kRemoved && !stopping_)
      Lost("ready fence reports device removal");
    if (removed && status_ != SharedAtlasStatus::kDeviceLost)
      Lost("D3D device removed");
    if (!stopping_) {
      const auto now = base::TimeTicks::Now().since_origin().InMicroseconds();
      for (const auto& [id, capture] : captures_) {
        if (capture->geometry.TimedOut(now)) {
          Lost("capture geometry transition exceeded 2000ms: " + capture->geometry_error);
          break;
        }
      }
    }
    for (auto it = leases_.begin(); it != leases_.end();) {
      if (removed || (completed != kRemoved && it->fence_value && completed >= it->fence_value)) {
        Trace("source_read_done", it->capture_serial, it->submitted.since_origin().InMicroseconds(),
              completed, -1, 0, 0, it->capture_time_us);
        if (it->callbacks)
          it->callbacks->Done();
        it = leases_.erase(it);
      } else
        ++it;
    }
    if (consumer_ && WaitForSingleObject(consumer_->process.Get(), 0) == WAIT_OBJECT_0 &&
        !stopping_) {
      consumer_exited_ = true;
      stopping_ = true;
      ResetPublicationSchedule();
      stop_time_ = base::TimeTicks::Now();
      StopCaptures();
      DropPendingCapture();
      dirty_ = false;
      status_ = SharedAtlasStatus::kStopped;
      error_ = "consumer exited; recreate output generation";
      PublishStatus();
    }
    if (!stopping_)
      PublishIfFree();
    if (stopping_) {
      drain_timed_out_ =
          !leases_.empty() && base::TimeTicks::Now() - stop_time_ >= base::Milliseconds(250);
      if (leases_.empty()) {
        timer_.Stop();
        precise_timer_.Stop();
        keepalive_.reset();
      }
    }
  }
  base::DictValue Describe(uint32_t pid) {
    DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_);
    if (consumer_ && WaitForSingleObject(consumer_->process.Get(), 0) == WAIT_OBJECT_0)
      consumer_exited_ = true;
    if (status_ == SharedAtlasStatus::kDeviceLost || status_ == SharedAtlasStatus::kFailed ||
        stopping_)
      return Failure(error_.empty() ? "output stopped" : error_);
    if (consumer_ && consumer_->pid == pid && !consumer_exited_)
      return Description();
    if (!device_ || !ready_)
      return Failure("waiting for first GPU capture", true);
    if (!pid || consumer_)
      return Failure("one consumer per generation");
    auto consumer = std::make_unique<Consumer>();
    consumer->pid = pid;
    consumer->process.Set(OpenProcess(PROCESS_DUP_HANDLE | SYNCHRONIZE, FALSE, pid));
    if (!consumer->process.is_valid())
      return Failure("OpenProcess consumer failed");
    const std::array<HANDLE, 6> handles = {mapping_handle_.Get(),  ready_handle_.Get(),
                                           consumed_handle_.Get(), slot_handles_[0].Get(),
                                           slot_handles_[1].Get(), slot_handles_[2].Get()};
    size_t copied = 0;
    for (; copied < handles.size(); ++copied) {
      HANDLE remote = nullptr;
      if (!DuplicateHandle(GetCurrentProcess(), handles[copied], consumer->process.Get(), &remote,
                           0, FALSE, DUPLICATE_SAME_ACCESS))
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
      return Failure("DuplicateHandle consumer failed");
    }
    consumer_ = std::move(consumer);
    return Description();
  }
  base::DictValue Description() const {
    base::ListValue textures;
    for (size_t i = 3; i < consumer_->handles.size(); ++i)
      textures.Append(Number(consumer_->handles[i]));
    return base::DictValue()
        .Set("ok", true)
        .Set("generation", Number(generation_))
        .Set("width", static_cast<int>(width_))
        .Set("height", static_cast<int>(height_))
        .Set("mapping_size", static_cast<int>(sizeof(SharedAtlasMapping)))
        .Set("mapping_handle", Number(consumer_->handles[0]))
        .Set("ready_fence_handle", Number(consumer_->handles[1]))
        .Set("consumed_fence_handle", Number(consumer_->handles[2]))
        .Set("texture_handles", std::move(textures))
        .Set("adapter_luid_low", Number(adapter_luid_.LowPart))
        .Set("adapter_luid_high",
             base::NumberToString(static_cast<int32_t>(adapter_luid_.HighPart)));
  }
  base::DictValue Status() const {
    DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_);
    return base::DictValue()
        .Set("generation", Number(generation_))
        .Set("status", static_cast<int>(status_))
        .Set("fps_limit", static_cast<int>(fps_))
        .Set("error", error_)
        .Set("frame_id", Number(frame_id_))
        .Set("captured", Number(captured_))
        .Set("capture_callbacks", Number(capture_callbacks_))
        .Set("dropped", Number(dropped_))
        .Set("mutex_drops", Number(mutex_drops_))
        .Set("geometry_transition_drops", Number(geometry_drops_))
        .Set("geometry_refreshes", Number(geometry_refreshes_))
        .Set("backpressure_polls", Number(backpressure_))
        .Set("single_plane_direct_enabled", base::FeatureList::IsEnabled(kRemoteKitSinglePlaneDirect))
        .Set("single_plane_direct_active", single_plane_direct_)
        .Set("pending_direct_capture", pending_capture_.has_value())
        .Set("source_stage_copies", Number(source_stage_copies_))
        .Set("stage_slot_copies", Number(stage_slot_copies_))
        .Set("source_slot_copies", Number(source_slot_copies_))
        .Set("direct_metadata_copies", Number(direct_metadata_copies_))
        .Set("direct_slot_clears", Number(direct_slot_clears_))
        .Set("direct_pending_replaced", Number(direct_pending_replaced_))
        .Set("pending_source_leases", static_cast<int>(leases_.size()))
        .Set("drain_timed_out", drain_timed_out_)
        .Set("consumer_exited", consumer_exited_);
  }

 private:
  struct TraceGeometry {
    gfx::Size requested, coded, natural;
    gfx::Rect visible, content;
    uint32_t texture_width, texture_height, texture_format;
    bool operator==(const TraceGeometry&) const = default;
  };
  struct TraceEvent {
    const char* stage;
    int64_t at_us;
    uint64_t serial;
    int64_t source_us;
    uint64_t detail;
    int source_counter;
    double frame_rate;
    int64_t capture_begin_us;
    bool high_resolution_timer;
    int64_t qpc, capture_time_us;
  };
  void Trace(const char* stage, uint64_t serial, int64_t source_us, uint64_t detail,
             int source_counter = -1, double frame_rate = 0, int64_t capture_begin_us = 0,
             int64_t capture_time_us = 0) {
    if (trace_directory_.empty() || trace_events_.size() >= 64000) return;
    LARGE_INTEGER qpc{}; QueryPerformanceCounter(&qpc);
    if (!capture_time_us && (std::string_view(stage) == "capture_callback" ||
                             std::string_view(stage) == "atlas_publish"))
      capture_time_us = source_us;
    trace_events_.push_back({stage, base::TimeTicks::Now().since_origin().InMicroseconds(),
                             serial, source_us, detail, source_counter, frame_rate, capture_begin_us,
                             base::Time::IsHighResolutionTimerInUse(), qpc.QuadPart, capture_time_us});
  }
  void SaveTrace() {
    if (trace_directory_.empty() || trace_saved_) return;
    trace_saved_ = true;
    base::ListValue events;
    for (const auto& event : trace_events_) {
      auto row = base::DictValue().Set("stage", event.stage)
          .Set("at_us", static_cast<double>(event.at_us)).Set("serial", Number(event.serial))
          .Set("source_us", static_cast<double>(event.source_us)).Set("detail", Number(event.detail));
      if (event.source_counter >= 0) row.Set("source_counter", event.source_counter);
      if (event.frame_rate > 0) row.Set("source_frame_rate", event.frame_rate);
      if (event.capture_begin_us) row.Set("capture_begin_us", static_cast<double>(event.capture_begin_us));
      row.Set("high_resolution_timer", event.high_resolution_timer);
      row.Set("qpc", Number(event.qpc));
      if (event.capture_time_us)
        row.Set("capture_time_us", static_cast<double>(event.capture_time_us));
      if (std::string_view(event.stage) == "atlas_publish")
        row.Set("source_frame_id", Number(event.serial));
      events.Append(std::move(row));
    }
    LARGE_INTEGER frequency{}; QueryPerformanceFrequency(&frequency);
    auto report = base::DictValue().Set("kind", "browser-gpu-cadence")
        .Set("schema", "remotekit-media-trace-v1").Set("scope", "browser")
        .Set("qpc_frequency", Number(frequency.QuadPart))
        .Set("pid", static_cast<int>(base::GetCurrentProcId()))
        .Set("generation", Number(generation_)).Set("width", static_cast<int>(width_))
        .Set("height", static_cast<int>(height_)).Set("fps_limit", static_cast<int>(fps_))
        .Set("poll_timer_mode", precise_poll_ ? "precise" : "default")
        .Set("timer_high_resolution_start", trace_start_high_resolution_)
        .Set("timer_high_resolution_stop", base::Time::IsHighResolutionTimerInUse())
        .Set("capture_callbacks", Number(capture_callbacks_)).Set("captured", Number(captured_))
        .Set("published", Number(frame_id_)).Set("dropped", Number(dropped_))
        .Set("mutex_drops", Number(mutex_drops_)).Set("backpressure_polls", Number(backpressure_))
        .Set("single_plane_direct_enabled", base::FeatureList::IsEnabled(kRemoteKitSinglePlaneDirect))
        .Set("single_plane_direct_active", single_plane_direct_)
        .Set("source_stage_copies", Number(source_stage_copies_))
        .Set("stage_slot_copies", Number(stage_slot_copies_))
        .Set("source_slot_copies", Number(source_slot_copies_))
        .Set("direct_metadata_copies", Number(direct_metadata_copies_))
        .Set("direct_slot_clears", Number(direct_slot_clears_))
        .Set("direct_pending_replaced", Number(direct_pending_replaced_))
        .Set("trace_full", trace_events_.size() == 64000).Set("events", std::move(events))
        .Set("capture_geometry", std::move(trace_geometry_samples_));
    auto json = base::WriteJson(report);
    if (!json) return;
    auto path = trace_directory_.AppendASCII("browser-" + Number(base::GetCurrentProcId()) +
        "-atlas-" + Number(generation_) + ".json");
    base::ThreadPool::PostTask(FROM_HERE, {base::MayBlock(), base::TaskShutdownBehavior::BLOCK_SHUTDOWN},
        base::BindOnce([](base::FilePath path, std::string bytes) {
          base::CreateDirectory(path.DirName());
          base::WriteFile(path, bytes);
        }, std::move(path), std::move(*json)));
  }
  SEQUENCE_CHECKER(sequence_);
  const uint32_t width_, height_;
  const uint64_t generation_;
  uint32_t fps_ = 30;
  SharedAtlasStatus status_ = SharedAtlasStatus::kStarting;
  std::string error_;
  bool stopping_ = false, dirty_ = false, consumer_exited_ = false;
  bool single_plane_direct_ = false;
  bool drain_timed_out_ = false;
  base::TimeTicks stop_time_;
  base::TimeTicks next_publication_deadline_, publication_wake_;
  base::RepeatingTimer timer_;
  base::DeadlineTimer precise_timer_;
  base::DeadlineTimer publication_timer_;
  bool precise_poll_ = false;
  std::shared_ptr<State> keepalive_;
  std::map<uint64_t, std::unique_ptr<Capture>> captures_;
  std::vector<uint64_t> order_;
  std::vector<Lease> leases_;
  // This source has not been read by our GPU. Replacing it can call Done
  // immediately; once submitted it must move to the fence-protected leases_.
  std::optional<PendingCapture> pending_capture_;
  ComPtr<ID3D11Device5> device_;
  ComPtr<ID3D11DeviceContext4> context_;
  ComPtr<ID3D11Texture2D> stage_;
  ComPtr<ID3D11RenderTargetView> stage_rtv_;
  std::array<ComPtr<ID3D11Texture2D>, kSharedAtlasSlotCount> slots_;
  std::array<base::win::ScopedHandle, kSharedAtlasSlotCount> slot_handles_;
  std::array<uint64_t, kSharedAtlasSlotCount> slot_values_{};
  // Producer-only pixel base. Never select it for writing, even if consumed.
  // All access is on context_, so a submitted clone precedes later reuse.
  std::optional<size_t> direct_base_slot_;
  std::array<bool, kSharedAtlasSlotCount> direct_slot_initialized_{};
  ComPtr<ID3D11Fence> ready_, consumed_;
  base::win::ScopedHandle ready_handle_, consumed_handle_, mapping_handle_;
  raw_ptr<SharedAtlasMapping> mapping_ = nullptr;
  std::unique_ptr<Consumer> consumer_;
  LUID adapter_luid_{};
  SharedAtlasFrame last_frame_{};
  uint64_t next_fence_ = 1, frame_id_ = 0, captured_ = 0, dropped_ = 0;
  uint64_t mutex_drops_ = 0, backpressure_ = 0;
  uint64_t source_stage_copies_ = 0, stage_slot_copies_ = 0, source_slot_copies_ = 0;
  uint64_t direct_metadata_copies_ = 0, direct_slot_clears_ = 0, direct_pending_replaced_ = 0;
  uint64_t capture_callbacks_ = 0;
  uint64_t next_capture_binding_ = 0, geometry_drops_ = 0, geometry_refreshes_ = 0;
  base::FilePath trace_directory_;
  std::vector<TraceEvent> trace_events_;
  std::map<uint64_t, TraceGeometry> trace_geometry_;
  base::ListValue trace_geometry_samples_;
  bool trace_saved_ = false, trace_start_high_resolution_ = false;
  int64_t capture_time_us_ = 0;
};

GpuAtlas::GpuAtlas(uint32_t width, uint32_t height, uint64_t generation)
    : state_(std::make_shared<State>(width, height, generation)) {
  state_->StartTimer();
}
GpuAtlas::~GpuAtlas() {
  state_->Stop();
}
void GpuAtlas::SetViews(std::vector<View> views) {
  state_->SetViews(std::move(views));
}
void GpuAtlas::SetFps(uint32_t fps) {
  state_->SetFps(fps);
}
void GpuAtlas::StopView(uint64_t id) {
  state_->StopView(id);
}
base::DictValue GpuAtlas::DescribeForConsumer(uint32_t pid) {
  return state_->Describe(pid);
}
base::DictValue GpuAtlas::Status() const {
  return state_->Status();
}
void GpuAtlas::Stop() {
  state_->Stop();
}
}  // namespace remotekit::browser
