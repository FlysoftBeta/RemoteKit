#pragma once
#include <d3d11_4.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
#include <optional>
#include <string>
#include "base/win/scoped_handle.h"
#include "ui/gfx/geometry/size.h"
namespace remotekit::browser::osr {
using Microsoft::WRL::ComPtr;
class Device {
 public:
  std::string Initialize();
  bool InitializeDevice(const std::optional<LUID>& requested_adapter);
  bool CreateTexture(const gfx::Size& size,
                     ComPtr<ID3D11Texture2D>& texture,
                     base::win::ScopedHandle& handle);
  bool CreateFence(ComPtr<ID3D11Fence>& fence, base::win::ScopedHandle& handle);
  bool InitializeShaders();
  ComPtr<ID3D11Device5> device;
  ComPtr<ID3D11DeviceContext4> context;
  ComPtr<ID3D11VertexShader> vertex_shader;
  ComPtr<ID3D11PixelShader> pixel_shader;
  ComPtr<ID3D11SamplerState> sampler;
  LUID luid{};
};
}  // namespace remotekit::browser::osr
