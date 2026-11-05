#include "remotekit/browser/osr/device.h"

#include <d3dcompiler.h>
#include <iterator>
#include "base/command_line.h"
#include "base/strings/string_number_conversions.h"

namespace remotekit::browser::osr {
constexpr char kUseAdapterLuid[] = "use-adapter-luid";
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
bool Device::InitializeDevice(const std::optional<LUID>& requested_adapter) {
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
    ComPtr<ID3D11Device> basic_device;
    ComPtr<ID3D11DeviceContext> basic_context;
    constexpr D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
    if (FAILED(D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                                 D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels, std::size(levels),
                                 D3D11_SDK_VERSION, &basic_device, nullptr, &basic_context)))
      continue;
    if (FAILED(basic_device.As(&device)) || FAILED(basic_context.As(&context)))
      continue;
    luid = desc.AdapterLuid;
    return true;
  }
  return false;
}

bool Device::CreateTexture(const gfx::Size& size,
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
  if (FAILED(device->CreateTexture2D(&desc, nullptr, &texture)))
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

bool Device::CreateFence(ComPtr<ID3D11Fence>& fence, base::win::ScopedHandle& handle) {
  if (FAILED(device->CreateFence(0, D3D11_FENCE_FLAG_SHARED, IID_PPV_ARGS(&fence))))
    return false;
  HANDLE shared = nullptr;
  if (FAILED(fence->CreateSharedHandle(nullptr, GENERIC_ALL, nullptr, &shared)))
    return false;
  handle.Set(shared);
  return true;
}

bool Device::InitializeShaders() {
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
      FAILED(device->CreateVertexShader(vs->GetBufferPointer(), vs->GetBufferSize(), nullptr,
                                        &vertex_shader)) ||
      FAILED(device->CreatePixelShader(ps->GetBufferPointer(), ps->GetBufferSize(), nullptr,
                                       &pixel_shader)))
    return false;
  D3D11_SAMPLER_DESC description{};
  description.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
  description.AddressU = description.AddressV = description.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
  description.MaxLOD = D3D11_FLOAT32_MAX;
  return SUCCEEDED(device->CreateSamplerState(&description, &sampler));
}
std::string Device::Initialize() {
  const auto* command_line = base::CommandLine::ForCurrentProcess();
  std::optional<LUID> requested_adapter;
  if (command_line->HasSwitch(kUseAdapterLuid)) {
    requested_adapter = ParseAdapterLuid(command_line->GetSwitchValueASCII(kUseAdapterLuid));
    if (!requested_adapter)
      return "invalid OSR adapter LUID";
  }
  if (!InitializeDevice(requested_adapter))
    return requested_adapter
               ? "OSR hardware D3D11.4 initialization failed for requested adapter LUID"
               : "OSR hardware D3D11.4 initialization failed";
  if (!InitializeShaders())
    return "OSR hardware D3D11.4/shader initialization failed";
  return {};
}

}  // namespace remotekit::browser::osr
