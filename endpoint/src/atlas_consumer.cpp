#include "remotekit/atlas_consumer.hpp"

#ifdef _WIN32
#include <d3d11_4.h>
#include <d3dcompiler.h>
#include <dxgi1_4.h>
#include <wrl/client.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <cwchar>
#include <limits>
#include <utility>

// The shared-memory ABI lives outside the C++ endpoint model.
#include "remotekit/shared_render_slots.h"

namespace remotekit {
namespace {
using Microsoft::WRL::ComPtr;
constexpr DWORD kCloseTimeoutMs = 250;

void CloseSetup(AtlasConsumerSetup& setup) {
  for (HANDLE& handle : setup.textures) {
    if (handle)
      CloseHandle(std::exchange(handle, nullptr));
  }
  if (setup.mapping)
    CloseHandle(std::exchange(setup.mapping, nullptr));
  for (auto& handles : {&setup.ready_fences, &setup.consumed_fences})
    for (auto& handle : *handles)
      if (handle)
        CloseHandle(std::exchange(handle, nullptr));
}

constexpr char kShader[] = R"(
Texture2D image : register(t0);
SamplerState linear_sampler : register(s0);
struct Vertex { float4 position : SV_Position; float2 uv : TEXCOORD0; };
Vertex vs_main(uint id : SV_VertexID) {
  Vertex v;
  v.uv = float2((id << 1) & 2, id & 2);
  v.position = float4(v.uv.x * 2 - 1, 1 - v.uv.y * 2, 0, 1);
  return v;
}
float4 ps_main(Vertex v) : SV_Target { return image.Sample(linear_sampler, v.uv); }
)";
}  // namespace

struct AtlasConsumer::Impl {
  AtlasConsumerSetup setup;
  HWND window = nullptr;
  const void* mapping = nullptr;
  ComPtr<ID3D11Device5> device;
  ComPtr<ID3D11DeviceContext4> context;
  ComPtr<IDXGISwapChain1> swapchain;
  ComPtr<ID3D11RenderTargetView> target;
  std::array<ComPtr<ID3D11Texture2D>, kRenderSlotCount> textures;
  ComPtr<ID3D11Texture2D> cache;
  ComPtr<ID3D11ShaderResourceView> cache_view;
  std::array<ComPtr<ID3D11Fence>, kRenderSlotCount> ready;
  std::array<ComPtr<ID3D11Fence>, kRenderSlotCount> consumed;
  std::uint64_t pending = 0, ready_value = 0, consumed_value = 0;
  ComPtr<ID3D11VertexShader> vertex_shader;
  ComPtr<ID3D11PixelShader> pixel_shader;
  ComPtr<ID3D11SamplerState> sampler;
  HANDLE completion_event = nullptr;
  std::uint64_t last_frame = 0;
  // This demo activates only slot zero; this value never retires another slot.
  std::uint64_t slot_read_value = 0;
  UINT client_width = 0;
  UINT client_height = 0;
  bool failed = false;
  bool read_without_signal = false;
  bool occluded = false;
  bool repaint = false;
  bool close_wait_attempted = false;
  SharedAtlasFrame last_snapshot{};
  AtlasContentRect content;
  std::wstring error;

  bool Fail(const wchar_t* message, HRESULT result = S_OK) {
    error = message;
    if (FAILED(result)) {
      wchar_t code[32]{};
      swprintf_s(code, L" (HRESULT 0x%08X)", static_cast<unsigned>(result));
      error += code;
    }
    failed = true;
    return false;
  }

  bool WaitForReads(bool allow_wait = true) {
    // Fence UINT64_MAX is not completion. Only this consumer device's actual
    // removal result proves its submitted reads can no longer execute.
    if (device && FAILED(device->GetDeviceRemovedReason()))
      return true;
    if (!context || !consumed[0])
      return true;
    if (read_without_signal) {
      return Fail(L"GPU read has no completion signal; resources retained until device removal");
    }
    if (!slot_read_value)
      return true;
    const auto completed = consumed[0]->GetCompletedValue();
    if (completed == std::numeric_limits<UINT64>::max()) {
      return Fail(L"Atlas device removed while waiting for reads; fence value is invalid");
    }
    if (completed >= slot_read_value)
      return true;
    if (!allow_wait)
      return false;
    ResetEvent(completion_event);
    HRESULT hr = consumed[0]->SetEventOnCompletion(slot_read_value, completion_event);
    if (FAILED(hr)) {
      return Fail(L"Unable to wait for atlas GPU reads; resources retained", hr);
    }
    context->Flush();
    if (WaitForSingleObject(completion_event, kCloseTimeoutMs) != WAIT_OBJECT_0) {
      if (device && FAILED(device->GetDeviceRemovedReason()))
        return true;
      return Fail(L"Atlas GPU read shutdown timed out; resources retained");
    }
    if (device && FAILED(device->GetDeviceRemovedReason()))
      return true;
    const auto after_wait = consumed[0]->GetCompletedValue();
    if (after_wait == std::numeric_limits<UINT64>::max() || after_wait < slot_read_value)
      return Fail(
          L"Atlas read completion event did not prove a valid completed fence; resources retained");
    return true;
  }

  void Release() {
    if (context)
      context->ClearState();
    target.Reset();
    swapchain.Reset();
    for (auto& texture : textures)
      texture.Reset();
    cache_view.Reset();
    cache.Reset();
    sampler.Reset();
    pixel_shader.Reset();
    vertex_shader.Reset();
    for (auto& fence : ready)
      fence.Reset();
    for (auto& fence : consumed)
      fence.Reset();
    pending = ready_value = consumed_value = 0;
    context.Reset();
    device.Reset();
    if (mapping)
      UnmapViewOfFile(std::exchange(mapping, nullptr));
    if (completion_event)
      CloseHandle(std::exchange(completion_event, nullptr));
    CloseSetup(setup);
    window = nullptr;
    content = {};
    slot_read_value = 0;
    last_frame = 0;
    client_width = client_height = 0;
    read_without_signal = false;
    occluded = false;
    repaint = false;
    close_wait_attempted = false;
    last_snapshot = {};
  }

  bool Resize() {
    if (failed)
      return false;
    if (!swapchain)
      return Fail(L"Atlas consumer is not open");
    RECT bounds{};
    if (!GetClientRect(window, &bounds))
      return Fail(L"GetClientRect failed");
    const UINT width = static_cast<UINT>(std::max<LONG>(0, bounds.right));
    const UINT height = static_cast<UINT>(std::max<LONG>(0, bounds.bottom));
    if (width == client_width && height == client_height)
      return true;
    content = {};
    if (!width || !height) {
      client_width = width;
      client_height = height;
      return true;
    }
    if (!WaitForReads()) {
      close_wait_attempted = true;
      return false;
    }
    context->OMSetRenderTargets(0, nullptr, nullptr);
    target.Reset();
    HRESULT hr = swapchain->ResizeBuffers(2, width, height, DXGI_FORMAT_B8G8R8A8_UNORM, 0);
    if (FAILED(hr))
      return Fail(L"Atlas swapchain resize failed", hr);
    ComPtr<ID3D11Texture2D> backbuffer;
    hr = swapchain->GetBuffer(0, IID_PPV_ARGS(&backbuffer));
    if (FAILED(hr))
      return Fail(L"Atlas backbuffer acquisition failed", hr);
    hr = device->CreateRenderTargetView(backbuffer.Get(), nullptr, &target);
    if (FAILED(hr))
      return Fail(L"Atlas render target creation failed", hr);
    client_width = width;
    client_height = height;
    const double scale = std::min(static_cast<double>(width) / setup.width,
                                  static_cast<double>(height) / setup.height);
    const int draw_width = std::max(1, static_cast<int>(setup.width * scale));
    const int draw_height = std::max(1, static_cast<int>(setup.height * scale));
    content.left = (static_cast<int>(width) - draw_width) / 2;
    content.top = (static_cast<int>(height) - draw_height) / 2;
    content.right = content.left + draw_width;
    content.bottom = content.top + draw_height;
    // A resized backbuffer needs one redraw of the latest available frame.
    repaint = true;
    return true;
  }

  bool Initialize(HWND hwnd, AtlasConsumerSetup incoming) {
    setup = incoming;
    window = hwnd;
    failed = false;
    error.clear();
    if (!IsWindow(hwnd) || !setup.mapping || !setup.ready_fences[0] || !setup.consumed_fences[0] ||
        !setup.generation || !setup.width || !setup.height)
      return Fail(L"Invalid atlas setup");
    for (HANDLE handle : setup.textures)
      if (!handle)
        return Fail(L"Missing shared atlas texture handle");
    ComPtr<IDXGIFactory4> factory;
    HRESULT hr = CreateDXGIFactory1(IID_PPV_ARGS(&factory));
    if (FAILED(hr))
      return Fail(L"DXGI factory creation failed", hr);
    ComPtr<IDXGIAdapter1> adapter;
    hr = factory->EnumAdapterByLuid(setup.adapter_luid, IID_PPV_ARGS(&adapter));
    if (FAILED(hr))
      return Fail(L"Unsupported atlas adapter LUID; cross-adapter import is unsupported", hr);
    ComPtr<ID3D11Device> base_device;
    ComPtr<ID3D11DeviceContext> base_context;
    const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
    hr = D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                           D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels, ARRAYSIZE(levels),
                           D3D11_SDK_VERSION, &base_device, nullptr, &base_context);
    if (FAILED(hr))
      return Fail(L"Hardware D3D11 device creation failed", hr);
    if (FAILED(hr = base_device.As(&device)) || FAILED(hr = base_context.As(&context)))
      return Fail(L"D3D11.4 shared fences are unsupported", hr);
    for (std::size_t i = 0; i < ready.size(); ++i) {
      if (!setup.ready_fences[i] || !setup.consumed_fences[i])
        return Fail(L"Missing per-slot fence handle");
      hr = device->OpenSharedFence(setup.ready_fences[i], IID_PPV_ARGS(&ready[i]));
      if (FAILED(hr))
        return Fail(L"Shared ready fence import failed", hr);
      hr = device->OpenSharedFence(setup.consumed_fences[i], IID_PPV_ARGS(&consumed[i]));
      if (FAILED(hr))
        return Fail(L"Shared consumed fence import failed", hr);
    }
    for (std::size_t i = 0; i < textures.size(); ++i) {
      hr = device->OpenSharedResource1(setup.textures[i], IID_PPV_ARGS(&textures[i]));
      if (FAILED(hr))
        return Fail(L"Shared atlas texture import failed", hr);
      D3D11_TEXTURE2D_DESC desc{};
      textures[i]->GetDesc(&desc);
      if (desc.Width != setup.width || desc.Height != setup.height ||
          desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM || desc.MipLevels != 1 || desc.ArraySize != 1 ||
          desc.SampleDesc.Count != 1)
        return Fail(L"Shared atlas texture does not match setup BGRA8 dimensions");
    }
    D3D11_TEXTURE2D_DESC cache_desc{};
    cache_desc.Width = setup.width;
    cache_desc.Height = setup.height;
    cache_desc.MipLevels = cache_desc.ArraySize = 1;
    cache_desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    cache_desc.SampleDesc.Count = 1;
    cache_desc.Usage = D3D11_USAGE_DEFAULT;
    cache_desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    hr = device->CreateTexture2D(&cache_desc, nullptr, &cache);
    if (FAILED(hr))
      return Fail(L"Consumer atlas cache creation failed", hr);
    hr = device->CreateShaderResourceView(cache.Get(), nullptr, &cache_view);
    if (FAILED(hr))
      return Fail(L"Consumer atlas cache SRV creation failed", hr);
    ComPtr<ID3DBlob> vertex, pixel, diagnostics;
    hr = D3DCompile(kShader, sizeof(kShader) - 1, nullptr, nullptr, nullptr, "vs_main", "vs_5_0",
                    D3DCOMPILE_ENABLE_STRICTNESS, 0, &vertex, &diagnostics);
    if (FAILED(hr))
      return Fail(L"Atlas vertex shader compilation failed", hr);
    hr = D3DCompile(kShader, sizeof(kShader) - 1, nullptr, nullptr, nullptr, "ps_main", "ps_5_0",
                    D3DCOMPILE_ENABLE_STRICTNESS, 0, &pixel, &diagnostics);
    if (FAILED(hr))
      return Fail(L"Atlas pixel shader compilation failed", hr);
    hr = device->CreateVertexShader(vertex->GetBufferPointer(), vertex->GetBufferSize(), nullptr,
                                    &vertex_shader);
    if (FAILED(hr))
      return Fail(L"Atlas vertex shader creation failed", hr);
    hr = device->CreatePixelShader(pixel->GetBufferPointer(), pixel->GetBufferSize(), nullptr,
                                   &pixel_shader);
    if (FAILED(hr))
      return Fail(L"Atlas pixel shader creation failed", hr);
    D3D11_SAMPLER_DESC sampler_desc{};
    sampler_desc.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
    sampler_desc.AddressU = sampler_desc.AddressV = sampler_desc.AddressW =
        D3D11_TEXTURE_ADDRESS_CLAMP;
    sampler_desc.MaxLOD = D3D11_FLOAT32_MAX;
    hr = device->CreateSamplerState(&sampler_desc, &sampler);
    if (FAILED(hr))
      return Fail(L"Atlas sampler creation failed", hr);
    DXGI_SWAP_CHAIN_DESC1 swap_desc{};
    swap_desc.Width = swap_desc.Height = 1;
    swap_desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    swap_desc.SampleDesc.Count = 1;
    swap_desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    swap_desc.BufferCount = 2;
    swap_desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
    hr = factory->CreateSwapChainForHwnd(device.Get(), hwnd, &swap_desc, nullptr, nullptr,
                                         &swapchain);
    if (FAILED(hr))
      return Fail(L"Atlas HWND swapchain creation failed", hr);
    factory->MakeWindowAssociation(hwnd, DXGI_MWA_NO_ALT_ENTER);
    completion_event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!completion_event)
      return Fail(L"Atlas completion event creation failed");
    // ABI-specific mapping and publication read are defined below.
    return MapMetadata() && Resize();
  }

  bool MapMetadata();
  AtlasPollResult Poll();
};

bool AtlasConsumer::Impl::MapMetadata() {
  // InterlockedCompareExchange64 requires writable pages even for an atomic read.
  mapping = MapViewOfFile(setup.mapping, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0,
                          sizeof(SharedRenderMapping));
  if (!mapping)
    return Fail(L"Atlas metadata mapping failed");
  const auto* header = static_cast<const SharedRenderMapping*>(mapping);
  if (header->magic != kSharedRenderMagic || header->version != kSharedRenderVersion ||
      header->mapping_size != sizeof(SharedRenderMapping))
    return Fail(L"Unsupported atlas metadata ABI");
  return true;
}

AtlasPollResult AtlasConsumer::Impl::Poll() {
  if (failed)
    return AtlasPollResult::error;
  if (!mapping || !context) {
    Fail(L"Atlas consumer is not open");
    return AtlasPollResult::error;
  }
  HRESULT hr = device->GetDeviceRemovedReason();
  if (FAILED(hr)) {
    Fail(L"Atlas consumer device removed", hr);
    return AtlasPollResult::error;
  }
  auto* mapping_header = static_cast<SharedRenderMapping*>(const_cast<void*>(mapping));
  auto* layout_sequence = reinterpret_cast<volatile LONG64*>(&mapping_header->publication_sequence);
  SharedAtlasFrame layout{};
  bool layout_stable = false;
  for (int attempt = 0; attempt < 3; ++attempt) {
    const auto before = InterlockedCompareExchange64(layout_sequence, 0, 0);
    if (before & 1)
      continue;
    std::memcpy(&layout, &mapping_header->latest_layout, sizeof(layout));
    MemoryBarrier();
    if (before == InterlockedCompareExchange64(layout_sequence, 0, 0)) {
      layout_stable = true;
      break;
    }
  }
  if (layout_stable && layout.status != SharedAtlasStatus::kStarting &&
      (layout.status != SharedAtlasStatus::kRunning || layout.generation != setup.generation ||
       layout.width_pixels != setup.width || layout.height_pixels != setup.height)) {
    Fail(L"Render output stopped or requires a new resource generation");
    return AtlasPollResult::error;
  }
  if (pending && !ready_value) {
    const auto completed = ready[0]->GetCompletedValue();
    if (completed == std::numeric_limits<UINT64>::max()) {
      Fail(L"Invalid ready fence completion");
      return AtlasPollResult::error;
    }
    if (completed >= pending) {
      auto* header = static_cast<SharedRenderMapping*>(const_cast<void*>(mapping));
      auto& slot = header->slots[0];
      auto* sequence = reinterpret_cast<volatile LONG64*>(&slot.publication_sequence);
      SharedAtlasFrame frame{};
      bool stable = false;
      for (int attempt = 0; attempt < 3; ++attempt) {
        const LONG64 before = InterlockedCompareExchange64(sequence, 0, 0);
        if (before & 1)
          continue;
        std::memcpy(&frame, &slot.frame, sizeof(frame));
        MemoryBarrier();
        if (before == InterlockedCompareExchange64(sequence, 0, 0)) {
          stable = true;
          break;
        }
      }
      if (!stable)
        return AtlasPollResult::idle;
      if (frame.generation != setup.generation || frame.slot != 0 ||
          frame.ready_fence_value != pending || !frame.frame_id ||
          frame.width_pixels != setup.width || frame.height_pixels != setup.height ||
          frame.status != SharedAtlasStatus::kRunning || frame.view_count > kSharedAtlasMaxViews) {
        Fail(L"Render slot metadata does not match the completed request");
        return AtlasPollResult::error;
      }
      for (std::uint32_t i = 0; i < frame.view_count; ++i) {
        const auto& view = frame.views[i];
        if (!std::isfinite(view.atlas_pixels_per_dip) || view.atlas_pixels_per_dip <= 0 ||
            !std::isfinite(view.page_device_scale_factor) || view.page_device_scale_factor <= 0) {
          Fail(L"Invalid render view scale");
          return AtlasPollResult::error;
        }
      }
      ID3D11ShaderResourceView* empty = nullptr;
      context->PSSetShaderResources(0, 1, &empty);
      hr = context->Wait(ready[0].Get(), pending);
      if (FAILED(hr)) {
        Fail(L"Ready fence GPU wait failed", hr);
        return AtlasPollResult::error;
      }
      read_without_signal = true;
      context->CopyResource(cache.Get(), textures[0].Get());
      hr = context->Signal(consumed[0].Get(), pending);
      if (FAILED(hr)) {
        context->Flush();
        Fail(L"Consumed GPU signal failed; resources retained", hr);
        return AtlasPollResult::error;
      }
      read_without_signal = false;
      slot_read_value = ready_value = pending;
      last_frame = frame.frame_id;
      last_snapshot = frame;
      repaint = true;
      context->Flush();
    }
  }
  if (pending && ready_value) {
    const auto done = consumed[0]->GetCompletedValue();
    if (done == std::numeric_limits<UINT64>::max()) {
      Fail(L"Invalid consumed fence completion");
      return AtlasPollResult::error;
    }
    if (done >= pending) {
      consumed_value = pending;
      pending = 0;
    }
  }
  if (!repaint || !last_frame || !client_width || !client_height)
    return AtlasPollResult::idle;
  if (occluded) {
    hr = swapchain->Present(0, DXGI_PRESENT_TEST);
    if (hr == DXGI_STATUS_OCCLUDED)
      return AtlasPollResult::idle;
    if (FAILED(hr)) {
      Fail(L"Atlas swapchain visibility test failed", hr);
      return AtlasPollResult::error;
    }
    occluded = false;
  }
  const float black[4] = {0, 0, 0, 1};
  context->ClearRenderTargetView(target.Get(), black);
  D3D11_VIEWPORT viewport{};
  viewport.TopLeftX = static_cast<float>(content.left);
  viewport.TopLeftY = static_cast<float>(content.top);
  viewport.Width = static_cast<float>(content.right - content.left);
  viewport.Height = static_cast<float>(content.bottom - content.top);
  viewport.MaxDepth = 1;
  context->RSSetViewports(1, &viewport);
  ID3D11RenderTargetView* render_target = target.Get();
  context->OMSetRenderTargets(1, &render_target, nullptr);
  context->IASetInputLayout(nullptr);
  context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
  context->VSSetShader(vertex_shader.Get(), nullptr, 0);
  context->PSSetShader(pixel_shader.Get(), nullptr, 0);
  ID3D11ShaderResourceView* resource_view = cache_view.Get();
  ID3D11SamplerState* sample_state = sampler.Get();
  context->PSSetShaderResources(0, 1, &resource_view);
  context->PSSetSamplers(0, 1, &sample_state);
  context->Draw(3, 0);
  // Stale means last-frame placeholder, not live pixels. Mark it only on the
  // private backbuffer; the shared source and private pixel cache stay intact.
  const float amber[4] = {1.0f, 0.62f, 0.12f, 1.0f};
  const double scale_x = static_cast<double>(content.right - content.left) / setup.width;
  const double scale_y = static_cast<double>(content.bottom - content.top) / setup.height;
  for (std::uint32_t i = 0; i < last_snapshot.view_count; ++i) {
    const auto& view = last_snapshot.views[i];
    if (!(view.reserved & kSharedAtlasViewStale))
      continue;
    const LONG left =
        static_cast<LONG>(std::clamp(std::floor(content.left + view.x_pixels * scale_x), 0.0,
                                     static_cast<double>(client_width)));
    const LONG top = static_cast<LONG>(std::clamp(std::floor(content.top + view.y_pixels * scale_y),
                                                  0.0, static_cast<double>(client_height)));
    const LONG right = static_cast<LONG>(
        std::clamp(std::ceil(content.left +
                             (static_cast<double>(view.x_pixels) + view.width_pixels) * scale_x),
                   0.0, static_cast<double>(client_width)));
    const LONG bottom = static_cast<LONG>(
        std::clamp(std::ceil(content.top +
                             (static_cast<double>(view.y_pixels) + view.height_pixels) * scale_y),
                   0.0, static_cast<double>(client_height)));
    if (right <= left || bottom <= top)
      continue;
    const LONG x_border = std::min<LONG>(3, right - left),
               y_border = std::min<LONG>(3, bottom - top);
    const D3D11_RECT borders[4] = {{left, top, right, top + y_border},
                                   {left, bottom - y_border, right, bottom},
                                   {left, top, left + x_border, bottom},
                                   {right - x_border, top, right, bottom}};
    context->ClearView(target.Get(), amber, borders, 4);
  }
  hr = swapchain->Present(0, 0);
  if (hr == DXGI_STATUS_OCCLUDED) {
    occluded = true;
    return AtlasPollResult::idle;
  }
  if (FAILED(hr)) {
    Fail(L"Atlas Present failed", hr);
    return AtlasPollResult::error;
  }
  repaint = false;
  return AtlasPollResult::presented;
}

AtlasConsumer::AtlasConsumer() : impl_(std::make_unique<Impl>()) {}
AtlasConsumer::~AtlasConsumer() {
  // Releasing imported resources during a live GPU read is unsafe. A failed
  // shutdown intentionally retains the entire device ownership until process exit.
  if (!Close())
    impl_.release();
}
bool AtlasConsumer::Open(HWND window, AtlasConsumerSetup setup) {
  if (!Close()) {
    CloseSetup(setup);
    return false;
  }
  if (impl_->Initialize(window, setup))
    return true;
  impl_->Release();
  return false;
}
bool AtlasConsumer::Close() {
  // UI Poll may retry a failed close every tick. Only the first attempt waits;
  // retries are nonblocking completion/device-removal queries.
  const bool allow_wait = !impl_->close_wait_attempted;
  impl_->close_wait_attempted = true;
  if (!impl_->WaitForReads(allow_wait))
    return false;
  impl_->Release();
  impl_->failed = false;
  return true;
}
bool AtlasConsumer::Begin(std::uint64_t value) {
  if (!value || impl_->pending || impl_->failed)
    return false;
  impl_->pending = value;
  impl_->ready_value = impl_->consumed_value = 0;
  return true;
}
void AtlasConsumer::Reject(std::uint64_t value) {
  if (impl_->pending == value && !impl_->ready_value)
    impl_->pending = 0;
}
std::uint64_t AtlasConsumer::ReadyValue() const {
  return impl_->ready_value;
}
std::uint64_t AtlasConsumer::ConsumedValue() const {
  return impl_->consumed_value;
}
bool AtlasConsumer::Resize() {
  return impl_->Resize();
}
void AtlasConsumer::RequestRepaint() {
  impl_->repaint = true;
}
AtlasPollResult AtlasConsumer::PollAndPresent() {
  return impl_->Poll();
}
AtlasContentRect AtlasConsumer::GetContentRect() const {
  return impl_->content;
}
SharedAtlasFrame AtlasConsumer::GetLastFrame() const {
  return impl_->last_snapshot;
}
const std::wstring& AtlasConsumer::LastError() const {
  return impl_->error;
}

}  // namespace remotekit
#endif
