#pragma once
#include "util/common.hpp"
#include "media/hardware_encoder.hpp"
#include "util/error.hpp"
#include <functional>
namespace remotekit {
struct OptionValues;
struct ProcessOptions {
  bool stdio = false;
  fs::path node_root;
  static Result<ProcessOptions> Parse(int argc, char** argv);
};
class RuntimeOptions {
 public:
  RuntimeOptions(const RuntimeOptions& other);
  RuntimeOptions(RuntimeOptions&&) noexcept = default;
  void SetConfigSource(std::function<Json()> source);
  const std::string node_id, build_id;
  const fs::path node_root;
  const fs::path browser, data;
  const std::string encoder;
  const media::EncoderSettings encoding;
  const uint32_t idle_idr_ms, max_encode_width, max_encode_height;
  const std::string peer_listen, peer_address;
  // WebRTC UDP ports (0 when the OS chooses) and the host Viewers use when it differs from the
  // node's own interfaces, e.g. a forwarded public address.
  const uint16_t rtc_port_min, rtc_port_max;
  const std::string rtc_address;
  static constexpr uint32_t kAtlasAllocationAlignment = 1;
  static constexpr int32_t kRtcPlayoutMinMs = 0, kRtcPlayoutMaxMs = 50;
  static Result<RuntimeOptions> FromConfig(const Json& config,
                                           const fs::path& root,
                                           std::string build_id,
                                           const std::string& node_id);

 private:
  explicit RuntimeOptions(OptionValues value);
  Json source_;
  std::function<Json()> config_source_;
};
}  // namespace remotekit
