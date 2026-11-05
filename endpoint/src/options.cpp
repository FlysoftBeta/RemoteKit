#include "options.hpp"
#include <windows.h>
#include <charconv>
#include <map>
namespace remotekit {
using media::EncoderSettings;
namespace {
const std::map<std::string, std::pair<uint32_t, uint32_t>> ranges{
    {"--fps", {1u, 120u}},
    {"--bitrate", {100000u, 50000000u}},
    {"--max-bitrate", {100000u, 60000000u}},
    {"--async-depth", {1u, 8u}},
    {"--gop", {1u, 65535u}},
    {"--target-usage", {1u, 7u}},
    {"--buffer-ms", {50u, 5000u}},
    {"--idle-idr-ms", {0u, 4294967295u}},
    {"--max-encode-width", {16u, 4096u}},
    {"--max-encode-height", {16u, 4096u}}};
}
struct OptionValues {
  std::string control_url, node_id;
  fs::path browser, data, browser_trace_directory;
  std::string encoder = "auto";
  EncoderSettings encoding;
  uint32_t idle_idr_ms = 150, max_encode_width = 4096, max_encode_height = 4096;
  bool qsv_low_power_explicit = false;
  OptionValues() {
    wchar_t executable[32768]{};
    GetModuleFileNameW(nullptr, executable, 32768);
    browser = Utf8Path(Env("REMOTEKIT_BROWSER",
                           Utf8(fs::path(executable).parent_path() / "remotekit_browser.exe")));
    data = Utf8Path(Env("REMOTEKIT_DATA_PATH", Env("LOCALAPPDATA", ".") + "/RemoteKit/streaming"));
    encoder = Env("REMOTEKIT_ENCODER", "auto");
    encoding.bitrate = 36000000;
    encoding.max_bitrate = 48000000;
  }
  Result<void> Parse(int argc, char** argv) {
    for (int i = 1; i < argc; ++i) {
      std::string arg = argv[i];
      auto equal = arg.find('=');
      if (equal == std::string::npos)
        return Error{ErrorCode::kInvalidRequest, "arguments require --name=value"};
      auto key = arg.substr(0, equal), value = arg.substr(equal + 1);
      Result<uint32_t> number = uint32_t(0);
      if (auto range = ranges.find(key); range != ranges.end()) {
        uint32_t parsed = 0;
        auto [end, error] = std::from_chars(value.data(), value.data() + value.size(), parsed);
        if (error != std::errc{} || end != value.data() + value.size() || value.empty() ||
            parsed < range->second.first || parsed > range->second.second)
          return Error{ErrorCode::kInvalidRequest, "invalid " + key};
        number = parsed;
      }
      if (key == "--control-url")
        control_url = value;
      else if (key == "--node-id")
        node_id = value;
      else if (key == "--browser")
        browser = Utf8Path(value);
      else if (key == "--data-path")
        data = Utf8Path(value);
      else if (key == "--browser-trace-dir")
        browser_trace_directory = Utf8Path(value);
      else if (key == "--encoder")
        encoder = value;
      else if (key == "--fps")
        encoding.fps = number.value();
      else if (key == "--bitrate")
        encoding.bitrate = number.value();
      else if (key == "--max-bitrate")
        encoding.max_bitrate = number.value();
      else if (key == "--async-depth")
        encoding.async_depth = number.value();
      else if (key == "--gop")
        encoding.gop = number.value();
      else if (key == "--target-usage") {
        encoding.target_usage = number.value();
        encoding.target_usage_explicit = true;
      } else if (key == "--qsv-low-power") {
        if (value != "auto" && value != "on" && value != "off")
          return Error{ErrorCode::kInvalidRequest, "qsv-low-power must be auto, on or off"};
        encoding.qsv_low_power = value == "on" ? 0x10u : (value == "off" ? 0x20u : 0u);
        qsv_low_power_explicit = true;
        encoding.qsv_low_power_explicit = true;
      } else if (key == "--buffer-ms")
        encoding.buffer_ms = number.value();
      else if (key == "--rate-control") {
        if (value != "cbr" && value != "vbr")
          return Error{ErrorCode::kInvalidRequest, "rate-control must be cbr or vbr"};
        encoding.vbr = value == "vbr";
        encoding.rate_control_explicit = true;
      } else if (key == "--idle-idr-ms")
        idle_idr_ms = number.value();
      else if (key == "--max-encode-width")
        max_encode_width = number.value();
      else if (key == "--max-encode-height")
        max_encode_height = number.value();
      else
        return Error{ErrorCode::kInvalidRequest, "unknown endpoint argument: " + key};
    }
    if (encoder != "auto" && encoder != "qsv" && encoder != "nvenc")
      return Error{ErrorCode::kInvalidRequest, "invalid --encoder"};
    if (encoding.bitrate > encoding.max_bitrate)
      return Error{ErrorCode::kInvalidRequest, "--bitrate exceeds --max-bitrate"};
    if (!node_id.empty() && control_url.empty())
      return Error{ErrorCode::kInvalidRequest, "--node-id requires --control-url"};
    browser = fs::absolute(browser);
    data = fs::absolute(data);
    if (!qsv_low_power_explicit && encoder != "nvenc")
      encoding.qsv_low_power = 0x10u;
    if (encoder == "nvenc" && encoding.qsv_low_power)
      return Error{ErrorCode::kInvalidRequest, "qsv-low-power requires qsv or auto encoder"};
    return {};
  }
};

RuntimeOptions::RuntimeOptions(OptionValues v)
    : control_url(std::move(v.control_url)),
      node_id(std::move(v.node_id)),
      browser(std::move(v.browser)),
      data(std::move(v.data)),
      browser_trace_directory(std::move(v.browser_trace_directory)),
      encoder(std::move(v.encoder)),
      encoding(std::move(v.encoding)),
      idle_idr_ms(std::move(v.idle_idr_ms)),
      max_encode_width(std::move(v.max_encode_width)),
      max_encode_height(std::move(v.max_encode_height)) {}
Result<RuntimeOptions> RuntimeOptions::Parse(int argc, char** argv) {
  OptionValues value;
  auto parsed = value.Parse(argc, argv);
  if (!parsed)
    return parsed.error();
  return RuntimeOptions(std::move(value));
}
}  // namespace remotekit
