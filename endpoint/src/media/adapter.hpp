#pragma once

#include "media/sdk_loader.hpp"
#include "media/gpu_device.hpp"
#include "media/hardware_encoder.hpp"
namespace remotekit {
using namespace media;
struct StreamingAdapter {
  LUID luid;
  std::string encoder;
  ComPtr<ID3D11Device5> device;
  ComPtr<ID3D11DeviceContext4> context;
};
std::string AdapterLuid(LUID luid);
struct AdapterConfig {
  std::string encoder;
  EncoderSettings encoding;
  uint32_t max_encode_width, max_encode_height;
};
Result<StreamingAdapter> SelectStreamingAdapter(Sdk& sdk, const AdapterConfig& options);
}  // namespace remotekit
