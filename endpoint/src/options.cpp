#include "options.hpp"
#include "cluster/node_files.hpp"
#include <windows.h>
#include <algorithm>
#include <charconv>
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
    {"maxEncodeHeight", {16, 4096}}};
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
    else
      return Invalid("argument " + argument);
  }
  if (!value.node_root.is_absolute())
    return Invalid("expected --node-root=<absolute path>");
  value.node_root = value.node_root.lexically_normal();
  return value;
}
struct OptionValues {
  std::string node_id, build_id;
  fs::path node_root, browser, data;
  std::string encoder;
  std::string peer_listen, peer_address;
  uint16_t rtc_port_min = 0, rtc_port_max = 0;
  std::string rtc_address;
  media::EncoderSettings encoding;
  uint32_t idle_idr_ms, max_encode_width, max_encode_height;
};
RuntimeOptions::RuntimeOptions(OptionValues v)
    : node_id(std::move(v.node_id)),
      build_id(std::move(v.build_id)),
      node_root(std::move(v.node_root)),
      browser(std::move(v.browser)),
      data(std::move(v.data)),
      encoder(std::move(v.encoder)),
      encoding(v.encoding),
      idle_idr_ms(v.idle_idr_ms),
      max_encode_width(v.max_encode_width),
      max_encode_height(v.max_encode_height),
      peer_listen(std::move(v.peer_listen)),
      peer_address(std::move(v.peer_address)),
      rtc_port_min(v.rtc_port_min),
      rtc_port_max(v.rtc_port_max),
      rtc_address(std::move(v.rtc_address)) {}
RuntimeOptions::RuntimeOptions(const RuntimeOptions& other)
    : RuntimeOptions(
          std::move(FromConfig(other.config_source_ ? other.config_source_() : other.source_,
                               other.node_root,
                               other.build_id,
                               other.node_id))
              .value()) {}
void RuntimeOptions::SetConfigSource(std::function<Json()> source) {
  config_source_ = std::move(source);
}
Result<RuntimeOptions> RuntimeOptions::FromConfig(const Json& source,
                                                  const fs::path& root,
                                                  std::string build_id,
                                                  const std::string& node_id) {
  if (!source.is_object() || source.size() != 4 || !source.contains("nodeId") ||
      !source.contains("peer") || !source.contains("rtc") || !source.contains("media") ||
      !source["media"].is_object())
    return Invalid("required fields");
  Json config = source["media"];
  for (const auto* name : {"nodeId", "peer", "rtc"}) {
    if (config.contains(name))
      return Invalid(name);
    config[name] = source[name];
  }
  const std::set<std::string> fields{
      "nodeId",         "encoder",         "fps",         "bitrate",
      "maxBitrate",     "asyncDepth",      "gop",         "targetUsage",
      "qsvLowPower",    "bufferMs",        "rateControl", "idleIdrMs",
      "maxEncodeWidth", "maxEncodeHeight", "peer",        "rtc"};
  const std::set<std::string> nullable{"asyncDepth", "gop", "targetUsage", "bufferMs",
                                       "rateControl"};
  if (!config.is_object() || config.size() != fields.size())
    return Invalid("required fields");
  for (const auto& [name, value] : config.items()) {
    if (!fields.contains(name))
      return Invalid("unknown field " + name);
    if (name == "peer") {
      if (!value.is_object() || value.size() != 2 || !value.contains("listen") ||
          !value["listen"].is_string() || !value.contains("address") ||
          !value["address"].is_string())
        return Invalid(name);
      for (const auto* field : {"listen", "address"}) {
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
    if (name == "rtc") {
      if (!value.is_object() || value.size() != 2 || !value.contains("ports") ||
          !value.contains("address") || !(value["ports"].is_null() || value["ports"].is_string()) ||
          !(value["address"].is_null() || value["address"].is_string()))
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
  v.peer_address = config["peer"]["address"];
  if (const auto& ports = config["rtc"]["ports"]; !ports.is_null()) {
    const auto text = ports.get<std::string>();
    const auto dash = text.find('-');
    unsigned min = 0, max = 0;
    auto number = [&](size_t begin, size_t end, unsigned& out) {
      const auto parsed = std::from_chars(text.data() + begin, text.data() + end, out);
      return begin < end && end - begin <= 5 && parsed.ec == std::errc() &&
             parsed.ptr == text.data() + end;
    };
    if (dash == std::string::npos || !number(0, dash, min) || !number(dash + 1, text.size(), max) ||
        min < 1024 || max > 65535 || min > max)
      return Invalid("rtc.ports");
    v.rtc_port_min = static_cast<uint16_t>(min);
    v.rtc_port_max = static_cast<uint16_t>(max);
  }
  if (const auto& address = config["rtc"]["address"]; !address.is_null()) {
    v.rtc_address = address.get<std::string>();
    if (v.rtc_address.empty() || v.rtc_address.size() > 253 || !v.rtc_port_min ||
        !std::all_of(v.rtc_address.begin(), v.rtc_address.end(), [](char c) {
          return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
                 c == '.' || c == '-';
        }))
      return Invalid("rtc.address");
  }
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
  v.data = root / "data";
  wchar_t executable[32768]{};
  GetModuleFileNameW(nullptr, executable, 32768);
  v.browser = fs::path(executable).parent_path() / "remotekit_browser.exe";
  RuntimeOptions options(std::move(v));
  options.source_ = source;
  return options;
}
}  // namespace remotekit
