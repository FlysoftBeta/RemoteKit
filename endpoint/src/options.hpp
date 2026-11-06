#pragma once
#include "util/common.hpp"
#include "media/hardware_encoder.hpp"
#include "util/error.hpp"
namespace remotekit {
struct OptionValues;
struct ProcessOptions {
  bool stdio = false;
  fs::path node_root;
  std::string node_id;
  static Result<ProcessOptions> Parse(int argc, char** argv);
};
class RuntimeOptions {
 public:
  const std::string node_id, build_id;
  const fs::path node_root;
  const fs::path browser, data, browser_trace_directory;
  const std::string encoder;
  const media::EncoderSettings encoding;
  const uint32_t idle_idr_ms, max_encode_width, max_encode_height;
  const uint32_t max_sessions;
  const std::string peer_listen, peer_advertise;
  const uint64_t disk_reserve_bytes, session_memory_bytes;
  static constexpr uint32_t kAtlasAllocationAlignment = 1;
  static constexpr int32_t kRtcPlayoutMinMs = 0, kRtcPlayoutMaxMs = 50;
  static Result<RuntimeOptions> FromConfig(const Json& config,
                                           const fs::path& root,
                                           std::string build_id,
                                           const std::string& node_id);

 private:
  explicit RuntimeOptions(OptionValues value);
};
}  // namespace remotekit
