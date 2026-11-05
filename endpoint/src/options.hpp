#pragma once
#include "common.hpp"
#include "media/hardware_encoder.hpp"
#include "remotekit/error.hpp"
namespace remotekit {
struct OptionValues;
class RuntimeOptions {
 public:
  const std::string control_url, node_id;
  const fs::path browser, data, browser_trace_directory;
  const std::string encoder;
  const media::EncoderSettings encoding;
  const uint32_t idle_idr_ms, max_encode_width, max_encode_height;
  static constexpr uint32_t kAtlasAllocationAlignment = 1;
  static constexpr int32_t kRtcPlayoutMinMs = 0, kRtcPlayoutMaxMs = 50;
  static Result<RuntimeOptions> Parse(int argc, char** argv);

 private:
  explicit RuntimeOptions(OptionValues value);
};
}  // namespace remotekit
