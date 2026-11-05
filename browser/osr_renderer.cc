#include "remotekit/browser/osr_renderer.h"
#include "remotekit/browser/offscreen_host.h"
#include "remotekit/browser/render_channel.h"
#include "remotekit/browser/osr_wake_state.h"
#include "remotekit/core.hpp"

#include <d3d11_4.h>
#include <d3dcompiler.h>
#include <dxgi1_2.h>
#include <windows.h>
#include <wrl/client.h>

#include <algorithm>
#include <array>
#include <deque>
#include <limits>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include "base/check.h"
#include "base/command_line.h"
#include "base/environment.h"
#include "base/files/file_util.h"
#include "base/json/json_writer.h"
#include "base/logging.h"
#include "base/process/process_handle.h"
#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/sequence_checker.h"
#include "base/strings/string_number_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "base/unguessable_token.h"
#include "base/win/scoped_handle.h"
#include "components/viz/common/frame_sinks/begin_frame_args.h"
#include "components/viz/common/frame_sinks/begin_frame_source.h"
#include "services/viz/privileged/mojom/compositing/remotekit_output.mojom.h"
#include "ui/compositor/compositor.h"
#include "ui/gfx/gpu_memory_buffer_handle.h"
#include "mojo/public/cpp/platform/platform_handle.h"

namespace remotekit::browser {
namespace {
using Microsoft::WRL::ComPtr;
constexpr uint64_t kRemoved = std::numeric_limits<uint64_t>::max();
constexpr size_t kPlaneTargets = kRenderSlotCount + 1;
// Chromium forwards this same switch to ANGLE in the GPU process.
constexpr char kUseAdapterLuid[] = "use-adapter-luid";
bool g_osr_fault_sealed = false;  // Unknown GPU work forbids later generations.
uint64_t g_plane_generation = 0;  // UI sequence, survives output generation replacement.
std::string Number(uint64_t value) {
  return base::NumberToString(value);
}
// The writer owns only diagnostic samples, never State or GPU resources.
class OsrTrace {
 public:
  explicit OsrTrace(uint64_t generation) : generation_(generation) {
    auto path = base::Environment::Create()->GetVar("REMOTEKIT_MEDIA_TRACE");
    if (!path || path->empty())
      return;
    LARGE_INTEGER frequency{};
    if (!QueryPerformanceFrequency(&frequency))
      return;
    frequency_ = frequency.QuadPart;
    directory_ = base::FilePath::FromUTF8Unsafe(*path);
    events_.reserve(kCapacity);
  }

  void Add(const char* stage,
           const RenderIdentity& id,
           uint64_t view = 0,
           int detail = 0,
           const InputEvent* input = nullptr) {
    if (directory_.empty())
      return;
    LARGE_INTEGER now{};
    QueryPerformanceCounter(&now);
    Event event{stage, now.QuadPart, id.value, id.slot, view, detail};
    if (input) {
      event.browser_sequence = input->sequence;
      event.token = input->token;
    }
    if (written_ < kCapacity) {
      events_.push_back(event);
    } else {
      events_[written_ % kCapacity] = event;
    }
    ++written_;
  }

  void Save() {
    if (directory_.empty() || !written_)
      return;
    base::ThreadPool::PostTask(
        FROM_HERE, {base::MayBlock(), base::TaskShutdownBehavior::BLOCK_SHUTDOWN},
        base::BindOnce(&Write, std::exchange(directory_, base::FilePath()), std::move(events_),
                       written_, generation_, frequency_));
  }

 private:
  static constexpr size_t kCapacity = 32768;
  struct Event {
    const char* stage;
    int64_t qpc;
    uint64_t value;
    uint32_t slot;
    uint64_t view;
    int detail;
    uint64_t browser_sequence = 0;
    InputToken token{};
  };

  static void Write(base::FilePath directory,
                    std::vector<Event> events,
                    uint64_t written,
                    uint64_t generation,
                    int64_t frequency) {
    const auto pid = base::GetCurrentProcId();
    base::ListValue rows;
    for (uint64_t index = written - events.size(); index < written; ++index) {
      const auto& event = events[index % kCapacity];
      auto row = base::DictValue()
                     .Set("stage", event.stage)
                     .Set("qpc", base::NumberToString(event.qpc))
                     .Set("fence", Number(event.value))
                     .Set("slot", static_cast<int>(event.slot))
                     .Set("view", Number(event.view))
                     .Set("detail", event.detail);
      if (event.browser_sequence) {
        row.Set("browser_sequence", Number(event.browser_sequence));
        row.Set("view", Number(event.token.view));
        row.Set("instance", Number(event.token.instance));
        row.Set("document", Number(event.token.document));
        row.Set("focus", Number(event.token.focus));
      }
      rows.Append(std::move(row));
    }
    auto document = base::DictValue()
                        .Set("schema", "remotekit-osr-trace-v1")
                        .Set("pid", static_cast<int>(pid))
                        .Set("generation", Number(generation))
                        .Set("qpc_frequency", base::NumberToString(frequency))
                        .Set("records_overwritten", Number(written - events.size()))
                        .Set("events", std::move(rows));
    auto bytes = base::WriteJson(document);
    if (!bytes || !base::CreateDirectory(directory) ||
        !base::WriteFile(
            directory.AppendASCII("osr-" + Number(pid) + "-" + Number(generation) + ".json"),
            *bytes)) {
      LOG(ERROR) << "Cannot save RemoteKit OSR trace";
    }
  }

  const uint64_t generation_;
  base::FilePath directory_;
  int64_t frequency_ = 0;
  uint64_t written_ = 0;
  std::vector<Event> events_;
};

std::optional<LUID> ParseAdapterLuid(std::string_view value) {
  const size_t comma = value.find(',');
  if (comma == std::string::npos)
    return std::nullopt;

  const auto high_part = value.substr(0, comma);
  const auto low_part = value.substr(comma + 1);
  int32_t high = 0;
  uint32_t low = 0;
  if (high_part.starts_with('+') || low_part.starts_with('+') ||
      !base::StringToInt(high_part, &high) || !base::StringToUint(low_part, &low)) {
    return std::nullopt;
  }
  return LUID{low, high};
}
base::DictValue Failure(const std::string& error) {
  return base::DictValue().Set("ok", false).Set("error", error);
}
// Caret/selection and focus may change while a Begin is pending. They can be
// refreshed at publication, whereas these fields define the pixels' identity
// and coordinate space and must match the snapshot used for root rendering.
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
base::win::ScopedHandle Duplicate(HANDLE handle) {
  HANDLE copy = nullptr;
  if (!DuplicateHandle(GetCurrentProcess(), handle, GetCurrentProcess(), &copy, 0, FALSE,
                       DUPLICATE_SAME_ACCESS))
    return {};
  return base::win::ScopedHandle(copy);
}
void Publish(volatile LONG64* sequence,
             SharedAtlasFrame* destination,
             const SharedAtlasFrame& frame) {
  InterlockedIncrement64(sequence);
  *destination = frame;
  InterlockedIncrement64(sequence);
}
}  // namespace

// Every accepted Begin owns its Endpoint-chosen slot. The UI sequence serializes
// root submissions; GPU plane writes, atlas reads and Endpoint reads may overlap.
class OsrRenderer::State : public std::enable_shared_from_this<OsrRenderer::State> {
 public:
  struct Target {
    ComPtr<ID3D11Texture2D> texture;
    ComPtr<ID3D11ShaderResourceView> srv;
    ComPtr<ID3D11Fence> ready;
    base::win::ScopedHandle texture_handle, ready_handle;
    uint64_t value = 0;
    bool writing = false;
  };
  struct Plane {
    SharedAtlasView metadata{};
    base::WeakPtr<OffscreenHost> host;
    gfx::Size size;
    uint64_t generation = 0, binding_epoch = 0;
    uintptr_t host_identity = 0;
    bool enabled = false, configuring = false, configured = false, retired = false;
    bool retirement_probe_registered = false;
    base::TimeTicks configure_deadline, next_configure_attempt;
    std::array<std::shared_ptr<Target>, kPlaneTargets> targets;
    std::shared_ptr<Target> latest;
  };
  struct PlaneRead {
    std::shared_ptr<Plane> plane;
    SharedAtlasView metadata{};
    std::shared_ptr<Target> target;
    bool enabled = false;
  };
  struct Work {
    RenderBegin begin;
    uint64_t revision = 0;
    size_t pending = 0;
    bool updated = false, unavailable = false, lost = false;
    std::vector<PlaneRead> reads;
  };
  struct Slot {
    ComPtr<ID3D11Texture2D> texture;
    ComPtr<ID3D11RenderTargetView> rtv;
    ComPtr<ID3D11Fence> ready, consumed;
    base::win::ScopedHandle texture_handle, ready_handle, consumed_handle;
    uint64_t last_value = 0, read_value = 0;
    bool reserved = false;
    // These are released only after this slot's real ready GPU fence completes.
    std::vector<std::shared_ptr<Target>> reads;
  };
  struct Consumer {
    uint32_t pid = 0;
    base::win::ScopedHandle process;
    std::array<uint64_t, 1 + 3 * kRenderSlotCount> handles{};
  };

  State(uint32_t width, uint32_t height, uint64_t generation)
      : width_(width), height_(height), generation_(generation), trace_(generation) {
    if (g_osr_fault_sealed) {
      Fatal("previous OSR GPU fault remains sealed");
      return;
    }
    if (!width || !height || width > 16384 || height > 16384 || !generation) {
      Fatal("invalid OSR dimensions/generation");
      return;
    }
    mapping_handle_.Set(CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0,
                                           sizeof(SharedRenderMapping), nullptr));
    if (mapping_handle_.is_valid())
      mapping_ = static_cast<SharedRenderMapping*>(MapViewOfFile(mapping_handle_.Get(),
                                                                 FILE_MAP_READ | FILE_MAP_WRITE, 0,
                                                                 0, sizeof(SharedRenderMapping)));
    if (!mapping_) {
      Fatal("render mapping allocation failed");
      return;
    }
    *mapping_ = SharedRenderMapping{};
    mapping_->magic = kSharedRenderMagic;
    mapping_->version = kSharedRenderVersion;
    mapping_->mapping_size = sizeof(SharedRenderMapping);
    const auto* command_line = base::CommandLine::ForCurrentProcess();
    std::optional<LUID> requested_adapter;
    if (command_line->HasSwitch(kUseAdapterLuid)) {
      requested_adapter = ParseAdapterLuid(command_line->GetSwitchValueASCII(kUseAdapterLuid));
      if (!requested_adapter) {
        Fatal("invalid OSR adapter LUID");
        return;
      }
    }
    if (!InitializeDevice(requested_adapter)) {
      Fatal(requested_adapter
                ? "OSR hardware D3D11.4 initialization failed for requested adapter LUID"
                : "OSR hardware D3D11.4 initialization failed");
      return;
    }
    if (!InitializeShaders()) {
      Fatal("OSR hardware D3D11.4/shader initialization failed");
      return;
    }
    for (auto& slot : slots_) {
      if (!CreateTexture(gfx::Size(width_, height_), slot.texture, slot.texture_handle) ||
          FAILED(device_->CreateRenderTargetView(slot.texture.Get(), nullptr, &slot.rtv)) ||
          !CreateFence(slot.ready, slot.ready_handle) ||
          !CreateFence(slot.consumed, slot.consumed_handle)) {
        Fatal("OSR slot resources allocation failed");
        return;
      }
    }
  }
  ~State() {
    DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_);
    trace_.Save();
    if (mapping_)
      UnmapViewOfFile(mapping_.get());
  }
  void Start() {
    if (failed_)
      return;
    channel_token_ = base::UnguessableToken::Create().ToString();
    mojo::ScopedMessagePipeHandle producer;
    if (mojo::CreateMessagePipe(nullptr, &producer, &pending_render_endpoint_) != MOJO_RESULT_OK) {
      Fatal("render message pipe allocation failed");
      return;
    }
    channel_ = std::make_unique<RenderChannel>(
        std::move(producer), base::BindRepeating(&State::Begin, base::Unretained(this)),
        base::BindRepeating(&State::StopBarrier, base::Unretained(this)),
        base::BindOnce(&State::Disconnected, base::Unretained(this)));
    // Polling retires GPU leases only. It never issues a render Begin.
    timer_.Start(FROM_HERE, base::Milliseconds(2),
                 base::BindRepeating(&State::Poll, base::Unretained(this)));
  }
  bool InitializeDevice(const std::optional<LUID>& requested_adapter) {
    ComPtr<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory))))
      return false;
    for (UINT i = 0;; ++i) {
      ComPtr<IDXGIAdapter1> adapter;
      if (factory->EnumAdapters1(i, &adapter) == DXGI_ERROR_NOT_FOUND)
        break;
      if (!adapter)
        break;
      DXGI_ADAPTER_DESC1 desc{};
      if (FAILED(adapter->GetDesc1(&desc)) || (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE))
        continue;
      if (requested_adapter && (desc.AdapterLuid.HighPart != requested_adapter->HighPart ||
                                desc.AdapterLuid.LowPart != requested_adapter->LowPart)) {
        continue;
      }
      ComPtr<ID3D11Device> device;
      ComPtr<ID3D11DeviceContext> context;
      constexpr D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
      if (FAILED(D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                                   D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels, std::size(levels),
                                   D3D11_SDK_VERSION, &device, nullptr, &context)))
        continue;
      if (FAILED(device.As(&device_)) || FAILED(context.As(&context_)))
        continue;
      luid_ = desc.AdapterLuid;
      return true;
    }
    return false;
  }
  bool CreateTexture(const gfx::Size& size,
                     ComPtr<ID3D11Texture2D>& texture,
                     base::win::ScopedHandle& handle) {
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = size.width();
    desc.Height = size.height();
    desc.MipLevels = desc.ArraySize = desc.SampleDesc.Count = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
    desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED;
    if (FAILED(device_->CreateTexture2D(&desc, nullptr, &texture)))
      return false;
    ComPtr<IDXGIResource1> resource;
    HANDLE shared = nullptr;
    if (FAILED(texture.As(&resource)) ||
        FAILED(resource->CreateSharedHandle(
            nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, nullptr, &shared)))
      return false;
    handle.Set(shared);
    return true;
  }
  bool CreateFence(ComPtr<ID3D11Fence>& fence, base::win::ScopedHandle& handle) {
    if (FAILED(device_->CreateFence(0, D3D11_FENCE_FLAG_SHARED, IID_PPV_ARGS(&fence))))
      return false;
    HANDLE shared = nullptr;
    if (FAILED(fence->CreateSharedHandle(nullptr, GENERIC_ALL, nullptr, &shared)))
      return false;
    handle.Set(shared);
    return true;
  }
  bool InitializeShaders() {
    constexpr char shader[] =
        "struct V{float4 p:SV_Position;float2 uv:TEXCOORD0;};"
        "V vs(uint id:SV_VertexID){V o;float2 uv=float2((id<<1)&2,id&2);"
        "o.p=float4(uv*float2(2,-2)+float2(-1,1),0,1);o.uv=uv;return o;}"
        "Texture2D image:register(t0);SamplerState linearSampler:register(s0);"
        "float4 ps(V i):SV_Target{return image.Sample(linearSampler,i.uv);}";
    ComPtr<ID3DBlob> vs, ps, errors;
    if (FAILED(D3DCompile(shader, sizeof(shader) - 1, nullptr, nullptr, nullptr, "vs", "vs_5_0",
                          D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &vs, &errors)) ||
        FAILED(D3DCompile(shader, sizeof(shader) - 1, nullptr, nullptr, nullptr, "ps", "ps_5_0",
                          D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &ps, &errors)) ||
        FAILED(device_->CreateVertexShader(vs->GetBufferPointer(), vs->GetBufferSize(), nullptr,
                                           &vertex_shader_)) ||
        FAILED(device_->CreatePixelShader(ps->GetBufferPointer(), ps->GetBufferSize(), nullptr,
                                          &pixel_shader_)))
      return false;
    D3D11_SAMPLER_DESC sampler{};
    sampler.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
    sampler.AddressU = sampler.AddressV = sampler.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
    sampler.MaxLOD = D3D11_FLOAT32_MAX;
    return SUCCEEDED(device_->CreateSamplerState(&sampler, &sampler_));
  }
  void SetViews(std::vector<View> views) {
    DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_);
    if (stopping_ || failed_)
      return;
    if (views.size() > kSharedAtlasMaxViews) {
      Fatal("too many OSR planes");
      return;
    }
    std::map<uint64_t, std::shared_ptr<Plane>> next;
    std::vector<uint64_t> order;
    bool changed = views.size() != planes_.size();
    for (const auto& view : views) {
      const auto& v = view.metadata;
      if (!v.webview_id || !v.width_pixels || !v.height_pixels || v.x_pixels < 0 ||
          v.y_pixels < 0 || uint64_t(v.x_pixels) + v.width_pixels > width_ ||
          uint64_t(v.y_pixels) + v.height_pixels > height_ || next.contains(v.webview_id)) {
        Fatal("invalid OSR plane layout");
        return;
      }
      if (view.render_enabled && !view.offscreen_host) {
        Fatal("native-window OSR output unsupported; use offscreen service host");
        return;
      }
      if (view.offscreen_host && view.offscreen_host->rebound_with_unretired_gpu_work()) {
        Fatal("Viz root rebound with unretired OSR producer work");
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
        plane->generation = ++g_plane_generation;
        if (view.offscreen_host) {
          plane->host = view.offscreen_host->GetWeakPtr();
          plane->host_identity = reinterpret_cast<uintptr_t>(view.offscreen_host.get());
          plane->binding_epoch = view.offscreen_host->begin_frame_binding_epoch();
        }
        changed = true;
      }
      if (plane->host) {
        plane->host->SetNeedsBeginFrameCallback(base::BindRepeating(
            [](std::weak_ptr<State> weak, base::WeakPtr<OffscreenHost> host) {
              if (auto state = weak.lock())
                state->OnDemandChanged(std::move(host));
            },
            std::weak_ptr<State>(shared_from_this()), plane->host));
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
        retired_planes_.push_back(plane);
      }
    planes_ = std::move(next);
    order_ = std::move(order);
    if (changed)
      ++revision_;
    PublishLayout();
  }
  bool Configure(const std::shared_ptr<Plane>& plane) {
    if (plane->configured)
      return true;
    const auto now = base::TimeTicks::Now();
    if (plane->configure_deadline.is_null())
      plane->configure_deadline = now + base::Seconds(5);
    if (now >= plane->configure_deadline) {
      Fatal("OSR output configuration did not succeed within 5 seconds");
      return false;
    }
    if (plane->configuring || !plane->host || plane->size.IsEmpty() ||
        now < plane->next_configure_attempt)
      return false;
    // A different pool for this Aura root may still be finishing a Viz write.
    // Its resources (including GPU-process Skia backing) must retire first.
    for (const auto& old : retired_planes_) {
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
    config->adapter_luid = (uint64_t(uint32_t(luid_.HighPart)) << 32) | luid_.LowPart;
    config->size = plane->size;
    for (auto& target : plane->targets) {
      // A failed Configure has submitted no writes to this pool. Keep its
      // textures/fences and duplicate handles again instead of allocating five
      // more resources for every Endpoint Begin during a transient retirement.
      if (!target) {
        target = std::make_shared<Target>();
        if (!CreateTexture(plane->size, target->texture, target->texture_handle) ||
            !CreateFence(target->ready, target->ready_handle) ||
            FAILED(
                device_->CreateShaderResourceView(target->texture.Get(), nullptr, &target->srv))) {
          Fatal("OSR plane resources allocation failed");
          return false;
        }
      }
      auto texture = Duplicate(target->texture_handle.Get());
      auto fence = Duplicate(target->ready_handle.Get());
      if (!texture.is_valid() || !fence.is_valid()) {
        Fatal("OSR handle duplicate failed");
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
          plane, device_));
    }
    plane->configuring = true;
    plane->host->compositor()->ConfigureRemoteKitOutput(
        std::move(config), base::BindOnce(&State::Configured, shared_from_this(), plane));
    return false;
  }
  void Configured(std::shared_ptr<Plane> plane, bool ok) {
    plane->configuring = false;
    plane->configured = ok;
    if (!ok) {
      plane->next_configure_attempt = base::TimeTicks::Now() + base::Milliseconds(50);
      if (!stopping_ && !plane->retired && base::TimeTicks::Now() >= plane->configure_deadline)
        Fatal("OSR output configuration did not succeed within 5 seconds");
    }
    // False can mean an old GPU-process backing is still retiring. Retry only
    // on a future Endpoint Begin; this callback never creates a render clock.
  }
  void Begin(const RenderBegin& begin) {
    auto protect = shared_from_this();
    DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_);
    if (begin.identity.generation != generation_) {
      Reject(begin, RenderRejectReason::kStaleGeneration);
      return;
    }
    if (failed_)
      return;  // Failed resources are sealed, never falsely rejected.
    if (stopping_) {
      Reject(begin, RenderRejectReason::kStopped);
      return;
    }
    auto& slot = slots_[begin.identity.slot];
    auto consumed = slot.consumed->GetCompletedValue();
    if (consumed == kRemoved || slot.reserved || (slot.last_value && consumed < slot.last_value) ||
        begin.identity.value <= slot.last_value) {
      Fatal("Begin attempted reuse before its slot consumed GPU fence");
      return;
    }
    wake_proof_.ObserveBegin(begin);
    slot.reserved = true;
    queue_.push_back(begin);
    trace_.Add("rend_begin", begin.identity, 0, static_cast<int>(queue_.size()));
    if (queue_.size() + (work_ ? 1 : 0) > kRenderSlotCount) {
      Fatal("OSR Begin capacity exceeded");
      return;
    }
    Pump();
  }
  void Reject(const RenderBegin& begin, RenderRejectReason reason) {
    if (begin.identity.generation == generation_ && begin.identity.slot < slots_.size())
      slots_[begin.identity.slot].reserved = false;
    trace_.Add("rend_reject", begin.identity, 0, static_cast<int>(reason));
    if (channel_)
      channel_->Reject(begin.identity, reason);
  }
  void Pump() {
    if (work_ || queue_.empty() || failed_)
      return;
    auto work = std::make_shared<Work>();
    work->begin = queue_.front();
    queue_.pop_front();
    work->revision = revision_;
    work_ = work;
    trace_.Add("rend_pump", work->begin.identity);
    bool ready = true;
    for (auto id : order_) {
      auto plane = planes_.at(id);
      work->reads.push_back({plane, plane->metadata, plane->latest, plane->enabled});
      if (plane->enabled && !Configure(plane))
        ready = false;
    }
    if (failed_)
      return;
    if (!ready) {
      FinishReject(RenderRejectReason::kNotReady);
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
      trace_.Add("rend_plane_issue", work->begin.identity, read.metadata.webview_id);
      plane.host->compositor()->IssueRemoteKitBeginFrame(
          args, std::move(token),
          base::BindOnce(&State::PlaneResult, shared_from_this(), work, index, target,
                         static_cast<uint32_t>(target_index)));
    }
    issuing_ = false;
    if (!work->pending)
      CompleteWork();
  }
  void PlaneResult(std::shared_ptr<Work> work,
                   size_t index,
                   std::shared_ptr<Target> target,
                   uint32_t target_index,
                   viz::mojom::RemoteKitFrameResultPtr result) {
    if (work_ != work)
      return;  // Confirmed device removal retired this work.
    auto& read = work->reads[index];
    trace_.Add("rend_plane_result", work->begin.identity, read.metadata.webview_id,
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
          work->unavailable = true;
          break;
        case viz::mojom::RemoteKitFrameStatus::kLost:
          work->lost = true;
          break;
      }
    CHECK(work->pending);
    --work->pending;
    if (!work->pending && !issuing_)
      CompleteWork();
  }
  bool RefreshCurrentWork(Work& work) {
    if (work.reads.size() != order_.size())
      return false;
    for (size_t i = 0; i < work.reads.size(); ++i) {
      auto& read = work.reads[i];
      if (read.metadata.webview_id != order_[i])
        return false;
      const auto current = planes_.find(order_[i]);
      if (current == planes_.end() || current->second != read.plane || read.plane->retired ||
          read.enabled != read.plane->enabled ||
          !SamePixelIdentity(read.metadata, read.plane->metadata))
        return false;
    }
    // UI sequence: after the identity pass no layout can change before atlas
    // submission. Publish the latest harmless focus/caret metadata without
    // throwing away an otherwise valid rendered frame.
    for (auto& read : work.reads)
      read.metadata = read.plane->metadata;
    work.revision = revision_;
    return true;
  }
  void CompleteWork() {
    auto work = work_;
    if (work->lost) {
      Fatal("Viz OSR write completion unknown/lost");
      return;
    }
    if (failed_)
      return;
    // No atlas read/write has been submitted yet. Stale work may be rejected
    // even if roots submitted writes: each root's target remains in its pool
    // (including retired pools) until its real producer fence completes.
    if (!RefreshCurrentWork(*work)) {
      FinishReject(RenderRejectReason::kNotReady);
      return;
    }
    bool missing = false;
    for (const auto& read : work->reads)
      if (read.enabled && !read.target)
        missing = true;
    // Submitted writes must retain their target even when a sibling root has
    // no output. Cache owns those real writes; they are never guessed complete.
    if (missing && !work->updated) {
      FinishReject(RenderRejectReason::kNotReady);
      return;
    }
    if (!work->updated && !work->begin.force && work->revision == published_revision_) {
      FinishReject(work->unavailable || HasFutureDemand() ? RenderRejectReason::kNotReady
                                                          : RenderRejectReason::kIdle);
      return;
    }
    auto& slot = slots_[work->begin.identity.slot];
    // A previous ready point must already be complete before any stale lease
    // storage can be removed. Consumed alone cannot release source read leases.
    if (!slot.reads.empty()) {
      auto done = slot.ready->GetCompletedValue();
      if (done == kRemoved || done < slot.read_value) {
        Fatal("slot consumed without producer ready completion");
        return;
      }
      slot.reads.clear();
    }
    trace_.Add("rend_atlas_begin", work->begin.identity);
    slot.read_value = work->begin.identity.value;
    ID3D11RenderTargetView* rtv = slot.rtv.Get();
    context_->OMSetRenderTargets(1, &rtv, nullptr);
    constexpr float background[] = {0, 0, 0, 1};
    context_->ClearRenderTargetView(rtv, background);
    context_->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    context_->VSSetShader(vertex_shader_.Get(), nullptr, 0);
    context_->PSSetShader(pixel_shader_.Get(), nullptr, 0);
    auto* sampler = sampler_.Get();
    context_->PSSetSamplers(0, 1, &sampler);
    SharedAtlasFrame frame{};
    frame.generation = generation_;
    if (work->updated || work->revision != published_revision_ || !frame_id_)
      ++frame_id_;
    frame.frame_id = frame_id_;
    frame.ready_fence_value = work->begin.identity.value;
    frame.slot = work->begin.identity.slot;
    frame.width_pixels = width_;
    frame.height_pixels = height_;
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
      if (FAILED(context_->Wait(target->ready.Get(), target->value))) {
        slot.reads.push_back(target);
        Fatal("OSR plane GPU Wait failed");
        return;
      }
      slot.reads.push_back(target);
      D3D11_VIEWPORT viewport{float(metadata.x_pixels),
                              float(metadata.y_pixels),
                              float(metadata.width_pixels),
                              float(metadata.height_pixels),
                              0.f,
                              1.f};
      context_->RSSetViewports(1, &viewport);
      auto* srv = target->srv.Get();
      context_->PSSetShaderResources(0, 1, &srv);
      context_->Draw(3, 0);
      // Completion latency is intentionally unmeasured (capture_time_us=0).
      // Submission callbacks and Flush must never masquerade as GPU completion.
    }
    ID3D11ShaderResourceView* empty = nullptr;
    context_->PSSetShaderResources(0, 1, &empty);
    // Publish before the GPU can expose this ready value. The consumer first
    // waits its fence, then reads this identity-matched snapshot; metadata alone
    // grants no GPU access. A failed Signal seals the published slot forever.
    auto& publication = base::span(mapping_->slots)[frame.slot];
    Publish(reinterpret_cast<volatile LONG64*>(&publication.publication_sequence),
            &publication.frame, frame);
    trace_.Add("rend_atlas_signal_call", work->begin.identity);
    if (FAILED(context_->Signal(slot.ready.Get(), work->begin.identity.value))) {
      Fatal("OSR atlas GPU Signal failed");
      return;
    }
    context_->Flush();
    trace_.Add("rend_atlas_flush_return", work->begin.identity);
    slot.last_value = work->begin.identity.value;
    slot.reserved = false;
    latest_frame_ = frame;
    published_revision_ = work->revision;
    status_ = stopping_ ? SharedAtlasStatus::kStopped : SharedAtlasStatus::kRunning;
    PublishLayout();
    ++submitted_;
    work_.reset();
    MaybeStopped();
    MaybeWake();
    SchedulePump();
  }
  bool ProducerRetired(const Plane& plane) const {
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
  void OnDemandChanged(base::WeakPtr<OffscreenHost> notified_host) {
    if (notified_host && notified_host->rebound_with_unretired_gpu_work()) {
      Fatal("Viz root rebound with unretired OSR producer work");
      return;
    }
    if (stopping_ || failed_)
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
        if (other->host_identity == identity && !ProducerRetired(*other)) {
          Fatal("Viz root rebound with unretired OSR producer work");
          return;
        }
      for (const auto& old : retired_planes_)
        if (old->host_identity == identity && !ProducerRetired(*old)) {
          Fatal("Viz root rebound with unretired OSR producer work");
          return;
        }
      auto fresh = std::make_shared<Plane>();
      fresh->host = current->host;
      fresh->host_identity = identity;
      fresh->binding_epoch = epoch;
      fresh->size = current->host->compositor()->size();
      fresh->generation = ++g_plane_generation;
      fresh->metadata = current->metadata;
      fresh->enabled = current->enabled;
      current->retired = true;
      retired_planes_.push_back(current);
      current = std::move(fresh);  // No old latest/configuration crosses epochs.
      replaced = true;
    }
    if (replaced) {
      ++revision_;
      PublishLayout();
      // Idle Endpoint admission needs one wake even if this newly bound root
      // has not published its first producer observer yet.
      wake_proof_.RequestRebindWake();
    }
    MaybeWake();
  }
  bool HasFutureDemand() const {
    for (const auto& [id, plane] : planes_) {
      if (!plane->enabled || !plane->host || plane->retired)
        continue;
      if (!plane->host->begin_frame_demand_known() || plane->host->needs_begin_frames())
        return true;
    }
    return false;
  }
  void MaybeWake() {
    // A manual Begin temporarily registers Display itself as an observer.
    // Its false notification precedes the associated terminal result. Only
    // inspect the settled level after every root/request has completed.
    if (!wake_proof_.pending() || stopping_ || failed_ || work_ || !queue_.empty())
      return;
    bool wake = wake_proof_.rebind_requested();
    for (const auto& [id, plane] : planes_) {
      if (plane->enabled && plane->host && !plane->retired &&
          plane->host->begin_frame_demand_known() && plane->host->needs_begin_frames())
        wake = true;
    }
    if (wake) {
      const auto identity = *wake_proof_.pending();
      if (channel_ && channel_->Wake(identity))
        wake_proof_.Delivered(identity);
    }
  }
  void FinishReject(RenderRejectReason reason) {
    auto begin = work_->begin;
    if (reason == RenderRejectReason::kIdle)
      wake_proof_.RecordIdle(begin.identity);
    work_.reset();
    ++rejected_;
    Reject(begin, reason);
    MaybeStopped();
    MaybeWake();
    SchedulePump();
  }
  void SchedulePump() {
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&State::Pump, shared_from_this()));
  }
  void PublishLayout() {
    if (!mapping_)
      return;
    auto frame = latest_frame_;
    frame.generation = generation_;
    frame.width_pixels = width_;
    frame.height_pixels = height_;
    frame.status = status_;
    frame.view_count = 0;
    for (auto id : order_) {
      auto& plane = *planes_.at(id);
      auto v = plane.metadata;
      if (!plane.enabled || !plane.latest)
        v.reserved |= kSharedAtlasViewStale;
      base::span(frame.views)[frame.view_count++] = v;
    }
    Publish(reinterpret_cast<volatile LONG64*>(&mapping_->publication_sequence),
            &mapping_->latest_layout, frame);
  }
  void StopView(uint64_t id) {
    auto it = planes_.find(id);
    if (it == planes_.end())
      return;
    it->second->enabled = false;
    it->second->retired = true;
    it->second->host.reset();
    ++revision_;
    PublishLayout();
  }
  void Fatal(std::string error) {
    if (failed_)
      return;
    failed_ = true;
    error_ = std::move(error);
    LOG(ERROR) << "RemoteKit OSR generation " << generation_ << ": " << error_;
    if (work_)
      trace_.Add("rend_fatal", work_->begin.identity);
    trace_.Save();
    g_osr_fault_sealed = true;
    status_ = SharedAtlasStatus::kFailed;
    PublishLayout();
    // Do not emit Reject after an uncertain GPU submission. Resources remain
    // sealed until device removal; Stop/Poll retains ownership independently.
    if (channel_)
      channel_->Close();
  }
  void Disconnected() {
    auto protect = shared_from_this();
    channel_disconnected_ = true;
    if (!stopping_)
      Stop();
  }
  void StopBarrier(uint64_t generation) {
    auto protect = shared_from_this();
    if (generation != generation_) {
      Fatal("render stop generation mismatch");
      return;
    }
    stop_barrier_seen_ = true;
    Stop();
    MaybeStopped();
  }
  void MaybeStopped() {
    if (!stop_barrier_seen_ || stopped_sent_ || failed_ || work_ || !queue_.empty())
      return;
    // This FIFO acknowledgement proves admission has drained, never that GPU
    // writes/Endpoint reads completed. The State still owns every fence lease.
    stopped_sent_ = true;
    trace_.Save();
    if (channel_)
      channel_->Stopped(generation_);
  }
  void Stop() {
    auto protect = shared_from_this();
    if (stopping_)
      return;
    stopping_ = true;
    wake_proof_.Stop();
    keepalive_ = shared_from_this();
    if (!failed_)
      status_ = SharedAtlasStatus::kStopped;
    for (const auto& begin : queue_)
      Reject(begin, RenderRejectReason::kStopped);
    queue_.clear();
    for (auto& [id, plane] : planes_) {
      plane->retired = true;
      plane->host.reset();
    }
    PublishLayout();
    if (!channel_)
      channel_disconnected_ = true;
    if (!render_endpoint_delivered_) {
      pending_render_endpoint_.reset();
      if (channel_)
        channel_->Close();
    }
    // output.close travels on Control, while Begin travels on the render FIFO.
    // Keep receiving/rejecting Begin until its ordered Stop barrier arrives.
    MaybeStopped();
    Poll();
  }
  void Poll() {
    auto protect = shared_from_this();
    bool removed = device_ && FAILED(device_->GetDeviceRemovedReason());
    bool pending = false;
    for (auto& slot : slots_) {
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
        if (target->writing ||
            (target->value && target->ready->GetCompletedValue() < target->value))
          pending = true;
      }
    };
    for (auto& [id, plane] : planes_)
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
    if (work_)
      for (auto& read : work_->reads)
        check_plane(read.plane);
    if (removed && !failed_)
      Fatal("OSR D3D device removed");
    // Admission drain is separate from GPU retirement. Every known Endpoint
    // read retains its slot until that exact consumed fence value completes.
    if (stopping_ && (channel_disconnected_ || stopped_sent_) &&
        (removed || (!pending && !work_))) {
      timer_.Stop();
      planes_.clear();
      retired_planes_.clear();
      work_.reset();
      keepalive_.reset();
    }
  }
  base::DictValue Describe(uint32_t pid) {
    if (failed_ || stopping_)
      return Failure(error_.empty() ? "OSR stopped" : error_);
    if (consumer_) {
      if (consumer_->pid == pid) {
        if (render_endpoint_delivered_)
          return Failure("render endpoint already delivered");
        return Description();
      }
      return Failure("one consumer per generation");
    }
    if (!pid)
      return Failure("invalid consumer pid");
    auto consumer = std::make_unique<Consumer>();
    consumer->pid = pid;
    consumer->process.Set(OpenProcess(PROCESS_DUP_HANDLE | SYNCHRONIZE, FALSE, pid));
    if (!consumer->process.is_valid())
      return Failure("OpenProcess consumer failed");
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
  mojo::ScopedMessagePipeHandle TakeRenderEndpoint(std::string_view token, uint32_t pid) {
    if (failed_ || stopping_ || !consumer_ || consumer_->pid != pid || token != channel_token_ ||
        render_endpoint_delivered_ || !pending_render_endpoint_.is_valid())
      return {};
    render_endpoint_delivered_ = true;
    return std::move(pending_render_endpoint_);
  }
  base::DictValue Description() const {
    base::ListValue ready, consumed, textures;
    for (size_t i = 0; i < slots_.size(); ++i) {
      ready.Append(Number(consumer_->handles[1 + i]));
      consumed.Append(Number(consumer_->handles[1 + kRenderSlotCount + i]));
      textures.Append(Number(consumer_->handles[1 + 2 * kRenderSlotCount + i]));
    }
    return base::DictValue()
        .Set("ok", true)
        .Set("generation", Number(generation_))
        .Set("width", int(width_))
        .Set("height", int(height_))
        .Set("mapping_size", int(sizeof(SharedRenderMapping)))
        .Set("mapping_handle", Number(consumer_->handles[0]))
        .Set("ready_fence_handles", std::move(ready))
        .Set("consumed_fence_handles", std::move(consumed))
        .Set("texture_handles", std::move(textures))
        .Set("render_channel", channel_token_)
        .Set("adapter_luid_low", Number(luid_.LowPart))
        .Set("adapter_luid_high", base::NumberToString(int32_t(luid_.HighPart)));
  }
  base::DictValue Status() const {
    return base::DictValue()
        .Set("kind", "osr-renderer")
        .Set("generation", Number(generation_))
        .Set("completionTime", "unmeasured")
        .Set("status", int(status_))
        .Set("error", error_)
        .Set("slotCount", int(kRenderSlotCount))
        .Set("submitted", Number(submitted_))
        .Set("rejected", Number(rejected_))
        .Set("pending", int(queue_.size() + (work_ ? 1 : 0)));
  }
  void TraceInput(const char* stage, const InputEvent& input, int status) {
    trace_.Add(stage, {}, 0, status, &input);
  }
  base::DictValue RenderStatus(uint64_t id) const {
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

 private:
  const uint32_t width_, height_;
  const uint64_t generation_;
  OsrTrace trace_;
  uint64_t revision_ = 1, published_revision_ = 0, frame_id_ = 0, submitted_ = 0, rejected_ = 0;
  bool failed_ = false, stopping_ = false, issuing_ = false;
  bool stop_barrier_seen_ = false, stopped_sent_ = false, channel_disconnected_ = false;
  SharedAtlasStatus status_ = SharedAtlasStatus::kStarting;
  std::string error_, channel_token_;
  ComPtr<ID3D11Device5> device_;
  ComPtr<ID3D11DeviceContext4> context_;
  ComPtr<ID3D11VertexShader> vertex_shader_;
  ComPtr<ID3D11PixelShader> pixel_shader_;
  ComPtr<ID3D11SamplerState> sampler_;
  LUID luid_{};
  std::array<Slot, kRenderSlotCount> slots_;
  std::map<uint64_t, std::shared_ptr<Plane>> planes_;
  std::vector<uint64_t> order_;
  std::vector<std::shared_ptr<Plane>> retired_planes_;
  std::deque<RenderBegin> queue_;
  OsrWakeProof wake_proof_;
  std::shared_ptr<Work> work_;
  SharedAtlasFrame latest_frame_{};
  base::win::ScopedHandle mapping_handle_;
  raw_ptr<SharedRenderMapping> mapping_ = nullptr;
  std::unique_ptr<RenderChannel> channel_;
  mojo::ScopedMessagePipeHandle pending_render_endpoint_;
  bool render_endpoint_delivered_ = false;
  std::unique_ptr<Consumer> consumer_;
  base::RepeatingTimer timer_;
  std::shared_ptr<State> keepalive_;
  SEQUENCE_CHECKER(sequence_);
};

OsrRenderer::OsrRenderer(uint32_t width, uint32_t height, uint64_t generation)
    : state_(std::make_shared<State>(width, height, generation)) {
  state_->Start();
}
OsrRenderer::~OsrRenderer() {
  state_->Stop();
}
bool OsrRenderer::IsGpuFaultSealed() {
  return g_osr_fault_sealed;
}
void OsrRenderer::SetViews(std::vector<View> views) {
  state_->SetViews(std::move(views));
}
void OsrRenderer::StopView(uint64_t id) {
  state_->StopView(id);
}
base::DictValue OsrRenderer::DescribeForConsumer(uint32_t pid) {
  return state_->Describe(pid);
}
mojo::ScopedMessagePipeHandle OsrRenderer::TakeRenderEndpoint(std::string_view token,
                                                              uint32_t pid) {
  return state_->TakeRenderEndpoint(token, pid);
}
base::DictValue OsrRenderer::Status() const {
  return state_->Status();
}
base::DictValue OsrRenderer::RenderStatus(uint64_t id) const {
  return state_->RenderStatus(id);
}
void OsrRenderer::TraceInput(const char* stage, const InputEvent& input, int status) {
  state_->TraceInput(stage, input, status);
}
void OsrRenderer::Stop() {
  state_->Stop();
}
}  // namespace remotekit::browser
