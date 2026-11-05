#pragma once
#include "options.hpp"
#include "media/sdk_loader.hpp"
#include "media/gpu_device.hpp"
namespace remotekit {
using namespace media;
struct StreamingAdapter {
  LUID luid;
  std::string encoder;
  ComPtr<ID3D11Device5> device;
  ComPtr<ID3D11DeviceContext4> context;
};
std::string AdapterLuid(LUID luid);
Result<StreamingAdapter> SelectStreamingAdapter(Sdk& sdk, const RuntimeOptions& options);
}  // namespace remotekit
