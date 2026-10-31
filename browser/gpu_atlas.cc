#include "remotekit/browser/gpu_atlas.h"

#include <d3d11_4.h>
#include <dxgi1_2.h>
#include <windows.h>
#include <wrl/client.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <map>
#include <string>
#include <utility>

#include "base/check.h"
#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/environment.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/json/json_writer.h"
#include "base/process/process_handle.h"
#include "base/sequence_checker.h"
#include "base/strings/string_number_conversions.h"
#include "base/task/single_thread_task_runner.h"
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
    if (auto directory = base::Environment::Create()->GetVar("REMOTEKIT_MEDIA_TRACE")) {
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
  void StopCaptures() {
    for (auto& [id, capture] : captures_)
      capture->Stop();
  }
  void Stop() {
    DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_);
    if (!stopping_)
      stop_time_ = base::TimeTicks::Now();
    stopping_ = true;
    StopCaptures();
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
    stop_time_ = base::TimeTicks::Now();
    StopCaptures();
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
    if (clear)
      ClearStage();
    else if (metadata_changed && stage_)
      dirty_ = true;
  }
  void ClearStage() {
    MarkLastStale(0);
    for (auto& [id, c] : captures_) {
      c->stale = true;
      if (c->capturer)
        c->capturer->RequestRefreshFrame();
    }
    if (context_ && stage_rtv_) {
      constexpr float white[] = {1, 1, 1, 1};
      context_->ClearRenderTargetView(stage_rtv_.Get(), white);
      dirty_ = true;
      capture_time_us_ = base::TimeTicks::Now().since_origin().InMicroseconds();
    }
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
    MarkLastStale(id);
    dirty_ = stage_ != nullptr;
  }
  void SetFps(uint32_t fps) {
    DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_);
    fps_ = std::clamp(fps, 1u, 120u);
    for (auto& [id, c] : captures_)
      if (c->capturer)
        c->capturer->SetMinCapturePeriod(base::Seconds(1) / fps_);
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
    if (!data || !info || !data->is_gpu_memory_buffer_handle() ||
        info->pixel_format != media::PIXEL_FORMAT_ARGB ||
        info->coded_size !=
            gfx::Size(capture.metadata.width_pixels, capture.metadata.height_pixels) ||
        content_rect != gfx::Rect(info->coded_size)) {
      Lost("output invalid: capture is not exact-size BGRA ARGB GPU data");
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
    if (desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM || desc.Width != capture.metadata.width_pixels ||
        desc.Height != capture.metadata.height_pixels || desc.ArraySize != 1 ||
        desc.SampleDesc.Count != 1 || !(desc.MiscFlags & D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX)) {
      Lost("output invalid: unsupported capture texture format/dimensions/keyed mutex");
      drop();
      return;
    }
    ComPtr<IDXGIKeyedMutex> mutex;
    if (FAILED(source.As(&mutex))) {
      Lost("output invalid: capture keyed mutex unavailable");
      drop();
      return;
    }
    const HRESULT acquired = mutex->AcquireSync(0, 0);
    if (acquired != S_OK) {
      ++mutex_drops_;
      if (acquired == static_cast<HRESULT>(WAIT_TIMEOUT) || acquired == DXGI_ERROR_WAIT_TIMEOUT) {
        if (capture.mutex_busy_since.is_null())
          capture.mutex_busy_since = base::TimeTicks::Now();
        if (base::TimeTicks::Now() - capture.mutex_busy_since >= base::Seconds(2)) {
          Lost("source keyed mutex remained busy for 2 seconds");
          drop();
          return;
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
      drop();
      return;
    }
    capture.mutex_busy_since = {};
    context_->CopySubresourceRegion(stage_.Get(), 0, capture.metadata.x_pixels,
                                    capture.metadata.y_pixels, 0, source.Get(), 0, nullptr);
    Lease lease;
    lease.source = source;
    lease.handle = std::move(handle);
    lease.callbacks = std::move(callbacks);
    lease.submitted = base::TimeTicks::Now();
    lease.capture_serial = capture_callbacks_;
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
  void PublishIfFree() {
    if (stopping_ || !dirty_ || !consumed_ || !stage_)
      return;
    const auto now = base::TimeTicks::Now();
    if (!last_publication_.is_null() && now - last_publication_ < base::Seconds(1) / fps_)
      return;
    const auto completed = consumed_->GetCompletedValue();
    if (completed == kRemoved) {
      Lost("consumed fence reports device removal");
      return;
    }
    size_t slot = slots_.size();
    for (size_t i = 0; i < slots_.size(); ++i)
      if (slot_values_[i] == 0 || completed >= slot_values_[i]) {
        slot = i;
        break;
      }
    if (slot == slots_.size()) {
      ++backpressure_;
      return;
    }
    context_->CopyResource(slots_[slot].Get(), stage_.Get());
    uint64_t value = Signal();
    if (!value)
      return;
    slot_values_[slot] = value;
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
    last_publication_ = now;
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
    for (auto it = leases_.begin(); it != leases_.end();) {
      if (removed || (completed != kRemoved && it->fence_value && completed >= it->fence_value)) {
        Trace("source_read_done", it->capture_serial, it->submitted.since_origin().InMicroseconds(), completed);
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
      stop_time_ = base::TimeTicks::Now();
      StopCaptures();
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
        .Set("backpressure_polls", Number(backpressure_))
        .Set("pending_source_leases", static_cast<int>(leases_.size()))
        .Set("drain_timed_out", drain_timed_out_)
        .Set("consumer_exited", consumer_exited_);
  }

 private:
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
  };
  void Trace(const char* stage, uint64_t serial, int64_t source_us, uint64_t detail,
             int source_counter = -1, double frame_rate = 0, int64_t capture_begin_us = 0) {
    if (trace_directory_.empty() || trace_events_.size() >= 64000) return;
    trace_events_.push_back({stage, base::TimeTicks::Now().since_origin().InMicroseconds(),
                             serial, source_us, detail, source_counter, frame_rate, capture_begin_us,
                             base::Time::IsHighResolutionTimerInUse()});
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
      events.Append(std::move(row));
    }
    auto report = base::DictValue().Set("kind", "browser-gpu-cadence")
        .Set("pid", static_cast<int>(base::GetCurrentProcId()))
        .Set("generation", Number(generation_)).Set("width", static_cast<int>(width_))
        .Set("height", static_cast<int>(height_)).Set("fps_limit", static_cast<int>(fps_))
        .Set("poll_timer_mode", precise_poll_ ? "precise" : "default")
        .Set("timer_high_resolution_start", trace_start_high_resolution_)
        .Set("timer_high_resolution_stop", base::Time::IsHighResolutionTimerInUse())
        .Set("capture_callbacks", Number(capture_callbacks_)).Set("captured", Number(captured_))
        .Set("published", Number(frame_id_)).Set("dropped", Number(dropped_))
        .Set("mutex_drops", Number(mutex_drops_)).Set("backpressure_polls", Number(backpressure_))
        .Set("trace_full", trace_events_.size() == 64000).Set("events", std::move(events));
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
  bool drain_timed_out_ = false;
  base::TimeTicks stop_time_;
  base::TimeTicks last_publication_;
  base::RepeatingTimer timer_;
  base::DeadlineTimer precise_timer_;
  bool precise_poll_ = false;
  std::shared_ptr<State> keepalive_;
  std::map<uint64_t, std::unique_ptr<Capture>> captures_;
  std::vector<uint64_t> order_;
  std::vector<Lease> leases_;
  ComPtr<ID3D11Device5> device_;
  ComPtr<ID3D11DeviceContext4> context_;
  ComPtr<ID3D11Texture2D> stage_;
  ComPtr<ID3D11RenderTargetView> stage_rtv_;
  std::array<ComPtr<ID3D11Texture2D>, kSharedAtlasSlotCount> slots_;
  std::array<base::win::ScopedHandle, kSharedAtlasSlotCount> slot_handles_;
  std::array<uint64_t, kSharedAtlasSlotCount> slot_values_{};
  ComPtr<ID3D11Fence> ready_, consumed_;
  base::win::ScopedHandle ready_handle_, consumed_handle_, mapping_handle_;
  raw_ptr<SharedAtlasMapping> mapping_ = nullptr;
  std::unique_ptr<Consumer> consumer_;
  LUID adapter_luid_{};
  SharedAtlasFrame last_frame_{};
  uint64_t next_fence_ = 1, frame_id_ = 0, captured_ = 0, dropped_ = 0;
  uint64_t mutex_drops_ = 0, backpressure_ = 0;
  uint64_t capture_callbacks_ = 0;
  base::FilePath trace_directory_;
  std::vector<TraceEvent> trace_events_;
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
