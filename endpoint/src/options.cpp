#include "options.hpp"
#include "cluster/node_files.hpp"
#include <windows.h>
#include <map>
#include <set>
namespace remotekit {
namespace {
Error Invalid(const std::string& field) {
  return {ErrorCode::kInvalidRequest, "invalid node configuration: " + field};
}
const std::map<std::string, std::pair<uint32_t, uint32_t>> ranges{
    {"fps", {1, 120}},
    {"bitrate", {100000, 50000000}},
    {"maxBitrate", {100000, 60000000}},
    {"asyncDepth", {1, 8}},
    {"gop", {1, 65535}},
    {"targetUsage", {1, 7}},
    {"bufferMs", {50, 5000}},
    {"idleIdrMs", {0, UINT32_MAX}},
    {"maxEncodeWidth", {16, 4096}},
    {"maxEncodeHeight", {16, 4096}},
    {"maxSessions", {1, 64}}};
}  // namespace
Result<ProcessOptions> ProcessOptions::Parse(int argc, char** argv) {
  ProcessOptions value;
  std::set<std::string> seen;
  for (int i = 1; i < argc; ++i) {
    std::string argument = argv[i];
    auto equal = argument.find('=');
    auto name = argument.substr(0, equal);
    auto text = equal == std::string::npos ? "" : argument.substr(equal + 1);
    if (!seen.insert(name).second)
      return Invalid("duplicate argument " + name);
    if (argument == "--stdio")
      value.stdio = true;
    else if (name == "--node-root" && !text.empty())
      value.node_root = Utf8Path(text);
    else if (name == "--node-id" && !text.empty())
      value.node_id = text;
    else
      return Invalid("argument " + argument);
  }
  if (!value.node_root.is_absolute() ||
      (value.stdio ? !cluster::ValidNodeId(value.node_id) : !value.node_id.empty()))
    return Invalid("expected --node-root=<absolute path>, with --stdio --node-id=<id> locally");
  value.node_root = value.node_root.lexically_normal();
  return value;
}
struct OptionValues {
  std::string node_id, build_id;
  fs::path node_root, browser, data, browser_trace_directory;
  std::string encoder;
  std::string peer_listen, peer_advertise;
  uint64_t disk_reserve_bytes, session_memory_bytes;
  media::EncoderSettings encoding;
  uint32_t idle_idr_ms, max_encode_width, max_encode_height, max_sessions;
};
RuntimeOptions::RuntimeOptions(OptionValues v)
    : node_id(std::move(v.node_id)),
      build_id(std::move(v.build_id)),
      node_root(std::move(v.node_root)),
      browser(std::move(v.browser)),
      data(std::move(v.data)),
      browser_trace_directory(std::move(v.browser_trace_directory)),
      encoder(std::move(v.encoder)),
      encoding(v.encoding),
      idle_idr_ms(v.idle_idr_ms),
      max_encode_width(v.max_encode_width),
      max_encode_height(v.max_encode_height),
      max_sessions(v.max_sessions),
      peer_listen(std::move(v.peer_listen)),
      peer_advertise(std::move(v.peer_advertise)),
      disk_reserve_bytes(v.disk_reserve_bytes),
      session_memory_bytes(v.session_memory_bytes) {}
Result<RuntimeOptions> RuntimeOptions::FromConfig(const Json& config,
                                                  const fs::path& root,
                                                  std::string build_id,
                                                  const std::string& node_id) {
  const std::set<std::string> fields{"nodeId",
                                     "encoder",
                                     "fps",
                                     "bitrate",
                                     "maxBitrate",
                                     "asyncDepth",
                                     "gop",
                                     "targetUsage",
                                     "qsvLowPower",
                                     "bufferMs",
                                     "rateControl",
                                     "idleIdrMs",
                                     "maxEncodeWidth",
                                     "maxEncodeHeight",
                                     "dataPath",
                                     "browser",
                                     "browserTraceDir",
                                     "maxSessions",
                                     "peer",
                                     "diskReserveBytes",
                                     "sessionMemoryBytes"};
  const std::set<std::string> nullable{"asyncDepth",  "gop",     "targetUsage",    "bufferMs",
                                       "rateControl", "browser", "browserTraceDir"};
  if (!config.is_object() || config.size() != fields.size())
    return Invalid("required fields");
  for (const auto& [name, value] : config.items()) {
    if (!fields.contains(name))
      return Invalid("unknown field " + name);
    if (name == "peer") {
      if (!value.is_object() || value.size() != 2 || !value.contains("listen") ||
          !value["listen"].is_string() || !value.contains("advertise") ||
          !value["advertise"].is_string())
        return Invalid(name);
      for (const auto* field : {"listen", "advertise"}) {
        const auto address = value[field].get<std::string>();
        const auto colon = address.rfind(':');
        if (colon == std::string::npos || colon == 0 || colon + 1 == address.size() ||
            address.size() > 1024)
          return Invalid(name);
        const auto port = address.substr(colon + 1);
        if (port.size() > 5 ||
            !std::all_of(port.begin(), port.end(), [](char c) { return c >= '0' && c <= '9'; }) ||
            std::stoul(port) > 65535)
          return Invalid(name);
      }
      continue;
    }
    if (name == "diskReserveBytes" || name == "sessionMemoryBytes") {
      if (!value.is_number_integer() || (!value.is_number_unsigned() && value.get<int64_t>() < 0) ||
          value.get<uint64_t>() > 9007199254740991ULL ||
          (name == "sessionMemoryBytes" && value == 0))
        return Invalid(name);
      continue;
    }
    if (value.is_null() && nullable.contains(name))
      continue;
    if (auto range = ranges.find(name); range != ranges.end()) {
      if (!value.is_number_integer() ||
          (value.is_number_integer() && !value.is_number_unsigned() && value.get<int64_t>() < 0) ||
          value.get<uint64_t>() < range->second.first ||
          value.get<uint64_t>() > range->second.second)
        return Invalid(name);
    } else if (!value.is_string() || value.get_ref<const std::string&>().empty())
      return Invalid(name);
  }
  for (const auto& field : fields)
    if (!config.contains(field))
      return Invalid(field);
  if (!cluster::ValidNodeId(node_id) || config["nodeId"] != node_id || !root.is_absolute() ||
      (build_id != "dev" && !cluster::ValidBuildId(build_id)))
    return Invalid("node identity");
  OptionValues v;
  v.peer_listen = config["peer"]["listen"];
  v.peer_advertise = config["peer"]["advertise"];
  v.disk_reserve_bytes = config["diskReserveBytes"];
  v.session_memory_bytes = config["sessionMemoryBytes"];
  v.node_id = node_id;
  v.build_id = std::move(build_id);
  v.node_root = root;
  v.encoder = config["encoder"].get<std::string>();
  if (v.encoder != "auto" && v.encoder != "qsv" && v.encoder != "nvenc")
    return Invalid("encoder");
  auto number = [&](const char* field, uint32_t& destination) {
    if (!config[field].is_null())
      destination = config[field].get<uint32_t>();
  };
  number("fps", v.encoding.fps);
  number("bitrate", v.encoding.bitrate);
  number("maxBitrate", v.encoding.max_bitrate);
  number("asyncDepth", v.encoding.async_depth);
  number("gop", v.encoding.gop);
  number("targetUsage", v.encoding.target_usage);
  number("bufferMs", v.encoding.buffer_ms);
  number("idleIdrMs", v.idle_idr_ms);
  number("maxEncodeWidth", v.max_encode_width);
  number("maxEncodeHeight", v.max_encode_height);
  number("maxSessions", v.max_sessions);
  if (v.encoding.max_bitrate < v.encoding.bitrate)
    return Invalid("maxBitrate");
  v.encoding.target_usage_explicit = !config["targetUsage"].is_null();
  const auto low_power = config["qsvLowPower"].get<std::string>();
  if (low_power != "auto" && low_power != "on" && low_power != "off")
    return Invalid("qsvLowPower");
  if (v.encoder == "nvenc" && low_power != "auto")
    return Invalid("qsvLowPower");
  v.encoding.qsv_low_power =
      low_power == "off" ? 0x20u : (low_power == "on" || v.encoder != "nvenc" ? 0x10u : 0u);
  v.encoding.qsv_low_power_explicit = low_power != "auto";
  if (!config["rateControl"].is_null()) {
    if (config["rateControl"] != "cbr" && config["rateControl"] != "vbr")
      return Invalid("rateControl");
    v.encoding.vbr = config["rateControl"] == "vbr";
    v.encoding.rate_control_explicit = true;
  }
  auto path = [&](const char* name) {
    return (root / Utf8Path(config[name].get<std::string>())).lexically_normal();
  };
  v.data = path("dataPath");
  wchar_t executable[32768]{};
  GetModuleFileNameW(nullptr, executable, 32768);
  v.browser = config["browser"].is_null()
                  ? fs::path(executable).parent_path() / "remotekit_browser.exe"
                  : path("browser");
  if (!config["browserTraceDir"].is_null())
    v.browser_trace_directory = path("browserTraceDir");
  return RuntimeOptions(std::move(v));
}
}  // namespace remotekit
