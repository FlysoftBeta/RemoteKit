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
#include "remotekit/shared_atlas.h"

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
  if (setup.ready_fence)
    CloseHandle(std::exchange(setup.ready_fence, nullptr));
  if (setup.consumed_fence)
    CloseHandle(std::exchange(setup.consumed_fence, nullptr));
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
  std::array<ComPtr<ID3D11Texture2D>, 3> textures;
  ComPtr<ID3D11Texture2D> cache;
  ComPtr<ID3D11ShaderResourceView> cache_view;
  ComPtr<ID3D11Fence> ready;
  ComPtr<ID3D11Fence> consumed;
  ComPtr<ID3D11VertexShader> vertex_shader;
  ComPtr<ID3D11PixelShader> pixel_shader;
  ComPtr<ID3D11SamplerState> sampler;
  HANDLE completion_event = nullptr;
  std::uint64_t last_frame = 0;
  std::uint64_t last_read = 0;
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
    if (!context || !consumed)
      return true;
    if (read_without_signal) {
      return Fail(L"GPU read has no completion signal; resources retained until device removal");
    }
    if (!last_read)
      return true;
    const auto completed = consumed->GetCompletedValue();
    if (completed == std::numeric_limits<UINT64>::max()) {
      return Fail(L"Atlas device removed while waiting for reads; fence value is invalid");
    }
    if (completed >= last_read)
      return true;
    if (!allow_wait)
      return false;
    ResetEvent(completion_event);
    HRESULT hr = consumed->SetEventOnCompletion(last_read, completion_event);
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
    const auto after_wait = consumed->GetCompletedValue();
    if (after_wait == std::numeric_limits<UINT64>::max() || after_wait < last_read)
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
    ready.Reset();
    consumed.Reset();
    context.Reset();
    device.Reset();
    if (mapping)
      UnmapViewOfFile(std::exchange(mapping, nullptr));
    if (completion_event)
      CloseHandle(std::exchange(completion_event, nullptr));
    CloseSetup(setup);
    window = nullptr;
    content = {};
    last_read = 0;
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
    if (!IsWindow(hwnd) || !setup.mapping || !setup.ready_fence || !setup.consumed_fence ||
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
    hr = device->OpenSharedFence(setup.ready_fence, IID_PPV_ARGS(&ready));
    if (FAILED(hr))
      return Fail(L"Shared ready fence import failed", hr);
    hr = device->OpenSharedFence(setup.consumed_fence, IID_PPV_ARGS(&consumed));
    if (FAILED(hr))
      return Fail(L"Shared consumed fence import failed", hr);
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
                          sizeof(SharedAtlasMapping));
  if (!mapping)
    return Fail(L"Atlas metadata mapping failed");
  const auto* header = static_cast<const SharedAtlasMapping*>(mapping);
  if (header->magic != kSharedAtlasMagic || header->version != kSharedAtlasVersion ||
      header->mapping_size != sizeof(SharedAtlasMapping))
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
  auto* header = static_cast<SharedAtlasMapping*>(const_cast<void*>(mapping));
  auto* sequence = reinterpret_cast<volatile LONG64*>(&header->publication_sequence);
  SharedAtlasFrame frame{};
  bool stable = false;
  for (int attempt = 0; attempt < 3; ++attempt) {
    const LONG64 before = InterlockedCompareExchange64(sequence, 0, 0);
    if (before & 1)
      continue;
    std::memcpy(&frame, &header->frame, sizeof(frame));
    MemoryBarrier();
    if (before == InterlockedCompareExchange64(sequence, 0, 0)) {
      stable = true;
      break;
    }
  }
  if (!stable)
    return AtlasPollResult::idle;
  if (frame.status == SharedAtlasStatus::kStarting)
    return AtlasPollResult::idle;
  if (frame.status != SharedAtlasStatus::kRunning) {
    Fail(frame.status == SharedAtlasStatus::kDeviceLost
             ? L"Atlas producer device lost"
             : L"Atlas producer stopped or metadata status invalid");
    return AtlasPollResult::error;
  }
  if (frame.generation != setup.generation || frame.width_pixels != setup.width ||
      frame.height_pixels != setup.height) {
    Fail(L"Atlas generation or dimensions changed; new setup and resource import required");
    return AtlasPollResult::error;
  }
  if (frame.slot >= textures.size() || !frame.frame_id || !frame.ready_fence_value ||
      frame.ready_fence_value == std::numeric_limits<UINT64>::max() ||
      frame.view_count > kSharedAtlasMaxViews) {
    Fail(L"Invalid atlas publication");
    return AtlasPollResult::error;
  }
  if (frame.frame_id < last_frame ||
      (frame.frame_id == last_frame &&
       (frame.ready_fence_value != last_read || frame.slot != last_snapshot.slot))) {
    Fail(L"Atlas publication frame/fence regressed or changed an already consumed slot");
    return AtlasPollResult::error;
  }
  if (frame.frame_id > last_frame) {
    if (frame.ready_fence_value <= last_read) {
      Fail(L"Atlas publication fence did not advance");
      return AtlasPollResult::error;
    }
    // Cache is private to this immediate context. Reading producer slots ends
    // after this GPU copy, so repaint never accesses an already released slot.
    ID3D11ShaderResourceView* empty = nullptr;
    context->PSSetShaderResources(0, 1, &empty);
    hr = context->Wait(ready.Get(), frame.ready_fence_value);
    if (FAILED(hr)) {
      Fail(L"Atlas ready-fence GPU wait failed", hr);
      return AtlasPollResult::error;
    }
    read_without_signal = true;
    context->CopyResource(cache.Get(), textures[frame.slot].Get());
    hr = context->Signal(consumed.Get(), frame.ready_fence_value);
    if (FAILED(hr)) {
      context->Flush();
      Fail(L"Atlas consumed-fence GPU signal failed; imported resources retained", hr);
      return AtlasPollResult::error;
    }
    read_without_signal = false;
    last_read = frame.ready_fence_value;
    last_frame = frame.frame_id;
    last_snapshot = frame;
    repaint = true;
    context->Flush();
  } else {
    // Source leases/old slots were already released after the cache copy.
    // Metadata-only stale/IME updates must never reread that producer slot.
    bool placeholder_changed = frame.view_count != last_snapshot.view_count;
    for (std::uint32_t i = 0; i < frame.view_count && !placeholder_changed; ++i) {
      const auto& before = last_snapshot.views[i];
      const auto& after = frame.views[i];
      placeholder_changed =
          before.webview_id != after.webview_id ||
          ((before.reserved ^ after.reserved) & kSharedAtlasViewStale) != 0 ||
          before.x_pixels != after.x_pixels || before.y_pixels != after.y_pixels ||
          before.width_pixels != after.width_pixels || before.height_pixels != after.height_pixels;
    }
    last_snapshot = frame;
    repaint |= placeholder_changed;
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
