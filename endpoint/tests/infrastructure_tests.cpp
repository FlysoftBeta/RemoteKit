#include "coordination_fixture.hpp"
#include "runtime_config_fixture.hpp"
#include "cluster/noise.hpp"
#include "management/link.hpp"
#include "options.hpp"
#include "persistence/durable_json.hpp"
#include "persistence/checkpoint.hpp"
#include "persistence/session_db.hpp"
#include "util/file_io.hpp"
#include "rtc/candidate_address.hpp"
#include "platform/process.hpp"
#include "service.hpp"
#include "media/sdk_loader.hpp"
#include "util/thread.hpp"
#include <windows.h>
#include <array>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <sstream>
#include <thread>

namespace {
using namespace remotekit;
void Check(bool value, const char* message) {
  if (!value)
    throw std::logic_error(message);
}
Result<RuntimeOptions> Options(Json config = TestConfig()) {
  return RuntimeOptions::FromConfig(config, fs::current_path(), "dev", "test");
}
void NumericOptions() {
  const std::array names{
      "fps",         "bitrate",  "maxBitrate", "asyncDepth",     "gop",
      "targetUsage", "bufferMs", "idleIdrMs",  "maxEncodeWidth", "maxEncodeHeight"};
  for (const auto* name : names) {
    for (const auto& invalid : {Json("1"), Json(-1), Json(true), Json(1.5), Json(4294967296ULL)}) {
      auto config = TestConfig();
      config["media"][name] = invalid;
      auto parsed = Options(config);
      Check(!parsed && parsed.error().code == ErrorCode::kInvalidRequest &&
                parsed.error().message.find(name) != std::string::npos,
            "numeric field must reject invalid type/range and identify field");
    }
  }
  auto config = TestConfig();
  config["media"]["fps"] = 120;
  Check(bool(Options(config)), "valid boundary");
  config["media"]["fps"] = 121;
  Check(!Options(config), "fps range");
  config = TestConfig();
  config["media"]["maxBitrate"] = 100000;
  Check(!Options(config), "maxBitrate below bitrate");
  config = TestConfig();
  config["media"]["encoder"] = "nvenc";
  config["media"]["qsvLowPower"] = "off";
  Check(!Options(config), "nvenc rejects qsvLowPower");
  config["media"]["qsvLowPower"] = "auto";
  Check(Options(config).value().encoding.qsv_low_power == 0, "nvenc default");
  Check(Options().value().encoding.qsv_low_power == 0x10, "qsv auto resolves on");
  const auto baseline = TestConfig();
  for (const auto& [field, value] : baseline.items()) {
    auto missing = TestConfig();
    missing.erase(field);
    Check(!Options(missing), "missing field rejected");
  }
  config = TestConfig();
  config["extra"] = 1;
  Check(!Options(config), "unknown field rejected");
  config = TestConfig();
  config["nodeId"] = "another";
  Check(!Options(config), "node identity mismatch");
  auto options = Options().value();
  for (const auto* field : {"maxSessions", "diskReserveBytes", "sessionMemoryBytes"}) {
    config = TestConfig();
    config[field] = nullptr;
    Check(!Options(config), "placement limits are not Endpoint configuration");
  }
  auto current = TestConfig();
  auto initial = Options().value();
  initial.SetConfigSource([&] { return current; });
  const auto existing = initial;
  current["media"]["fps"] = 24;
  const auto next = initial;
  Check(existing.encoding.fps == 60 && next.encoding.fps == 24,
        "media snapshots apply only to future Sessions");
  Check(options.data == fs::current_path() / "data" && options.browser.is_absolute(),
        "paths resolved against node root");
  Check(!options.rtc_port_min && !options.rtc_port_max && options.rtc_address.empty(),
        "RTC defaults to OS-chosen ports on local interfaces");
  config = TestConfig();
  config["rtc"] = {{"ports", "40000-40019"}, {"address", "viewer.example"}};
  const auto forwarded = Options(config).value();
  Check(forwarded.rtc_port_min == 40000 && forwarded.rtc_port_max == 40019 &&
            forwarded.rtc_address == "viewer.example",
        "RTC port range and address");
  for (const auto& invalid :
       {Json{{"ports", "40000"}, {"address", nullptr}},
        Json{{"ports", "900-1000"}, {"address", nullptr}},
        Json{{"ports", "5000-4000"}, {"address", nullptr}},
        Json{{"ports", "40000-40001x"}, {"address", nullptr}},
        Json{{"ports", nullptr}, {"address", "viewer.example"}},
        Json{{"ports", "40000-40001"}, {"address", "bad host"}}, Json{{"ports", nullptr}}}) {
    config = TestConfig();
    config["rtc"] = invalid;
    Check(!Options(config), "invalid RTC configuration rejected");
  }
}
void AdvertisedCandidates() {
  const std::string host =
      "candidate:1234 1 udp 2122260223 192.168.1.20 40005 typ host generation 0 network-id 1";
  Check(
      AdvertisedCandidate(host, "203.0.113.7", 40000, 40019) ==
          "candidate:rk1234 1 udp 2122260223 203.0.113.7 40005 typ host generation 0 network-id 1",
      "host candidate in range gets the advertised address");
  Check(!AdvertisedCandidate(host, "203.0.113.7", 41000, 41019), "port outside forwarded range");
  Check(!AdvertisedCandidate(host, "192.168.1.20", 40000, 40019), "already the advertised address");
  Check(!AdvertisedCandidate("candidate:1 1 tcp 1518280447 192.168.1.20 40005 typ host tcptype "
                             "passive",
                             "203.0.113.7", 40000, 40019),
        "TCP candidates are not forwarded");
  Check(!AdvertisedCandidate("candidate:1 1 udp 1686052607 198.51.100.2 40005 typ srflx raddr "
                             "192.168.1.20 rport 40005",
                             "203.0.113.7", 40000, 40019),
        "only host candidates");
  Check(
      !AdvertisedCandidate("candidate:1 1 udp 1 192.168.1.20 4x typ host", "203.0.113.7", 0, 65535),
      "malformed port");
  Check(ResolveRtcAddress("127.0.0.1").value() == "127.0.0.1", "IP literal resolves to itself");
}
void ProcessArguments() {
  auto parse = [](std::vector<std::string> arguments) {
    std::vector<char*> pointers;
    for (auto& argument : arguments)
      pointers.push_back(argument.data());
    return ProcessOptions::Parse(static_cast<int>(pointers.size()), pointers.data());
  };
  const auto root = "--node-root=" + Utf8(fs::current_path());
  Check(bool(parse({"endpoint", root})), "remote arguments");
  Check(bool(parse({"endpoint", "--stdio", root})), "local arguments");
  for (auto arguments : std::vector<std::vector<std::string>>{
           {"endpoint"},
           {"endpoint", "--node-root=relative"},
           {"endpoint", root, root},
           {"endpoint", root, "--node-id=test"},
           {"endpoint", "--stdio", root, "--node-id=UPPER"},
           {"endpoint", root, "--encoder=auto"},
           {"endpoint", root, "--browser=test"},
           {"endpoint", root, "--data-path=test"},
           {"endpoint", root, "--fps=60"},
           {"endpoint", root, "--control-url=ws://host/api/node"}})
    Check(!parse(std::move(arguments)), "reject invalid or extra arguments");
}
struct TemporaryDirectory {
  fs::path path = fs::temp_directory_path() /
                  (L"remotekit-infrastructure-" + std::to_wstring(GetCurrentProcessId()) + L"-" +
                   std::to_wstring(GetTickCount64()));
  TemporaryDirectory() { fs::create_directories(path); }
  ~TemporaryDirectory() {
    std::error_code ignored;
    fs::remove_all(path, ignored);
  }
};
void Durability() {
  TemporaryDirectory directory;
  const auto path = directory.path / "state.json";
  Check(bool(WriteDurableJson(path, {{"value", 1}})), "initial durable write");
  fs::create_directory(directory.path / "state.json.new");
  Check(!WriteDurableJson(path, {{"value", 2}}), "failed temp write");
  Check(Json::parse(*ReadFileIfExists(path).value())["value"] == 1, "preserve committed state");
  Check(bool(WriteDurableJson(path, {{"value", 3}})), "replacement durable write");
  Check(Json::parse(*ReadFileIfExists(path).value())["value"] == 3, "committed replacement");
}
void ThreadFailure() {
  bool failed = false;
  std::thread worker([&] {
    RunThread(
        "injected failure", [] { throw std::logic_error("injected"); }, [&] { failed = true; });
  });
  worker.join();
  Check(failed, "thread exception must mark its owner failed");
  RunThread("failure callback", [] { throw 1; }, [] { throw 2; });
}
void ProcessOwnership() {
  Check(BrowserProcess::Quote(L"") == L"\"\"", "empty argument quoting");
  Check(BrowserProcess::Quote(L"a b\\") == L"\"a b\\\\\"", "trailing slash quoting");
  Check(BrowserProcess::Quote(L"a\"b") == L"\"a\\\"b\"", "embedded quote");
  wchar_t self[32768]{};
  GetModuleFileNameW(nullptr, self, 32768);
  const fs::path executable = self;
  SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
  HANDLE unrelated = CreateEventW(&security, TRUE, FALSE, nullptr);
  Check(unrelated != nullptr, "unrelated inheritable handle");
  cluster::Key key;
  key.fill(7);
  BrowserProcess process;
  auto started = process.Launch(executable,
                                BrowserProcess::Quote(executable.wstring()) +
                                    L" --check-profile-key --unrelated-handle=" +
                                    std::to_wstring(reinterpret_cast<uintptr_t>(unrelated)),
                                key);
  Check(bool(started), "suspended process launch and job assignment");
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (process.Alive() && std::chrono::steady_clock::now() < deadline)
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  const bool inherited = WaitForSingleObject(unrelated, 0) != WAIT_TIMEOUT;
  CloseHandle(unrelated);
  Check(!inherited, "unrelated inheritable event was excluded");
  Check(process.ExitCode() == 0, "only the key handle is inherited, with exactly 32 key bytes");
  Check(process.Present(), "retain exact process identity");
  Check(bool(process.Terminate()) && process.state() == BrowserProcess::State::kExited,
        "stop confirms process exit");
  process.ReleaseExited();
  Check(!process.Present() && process.state() == BrowserProcess::State::kStopped,
        "release confirmed process");
}
class FixtureLink final : public ManagementLink {
 public:
  std::vector<Json> requests, replies, events;
  std::mutex mutex;
  size_t index = 0;
  std::optional<ReadyState> ReadyConfiguration() override {
    return ReadyState{7,
                      {{"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
                       {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}},
                      "connection"};
  }
  bool Next(std::string& bytes, uint64_t& generation, bool& eof) override {
    generation = 7;
    eof = index == requests.size();
    if (eof)
      return false;
    auto request = requests[index];
    request["id"] = index++;
    bytes = request.dump();
    return true;
  }
  bool Current(uint64_t generation) override { return generation == 7; }
  bool SendReply(uint64_t, const Json& reply) override {
    std::lock_guard lock(mutex);
    replies.push_back(reply);
    return true;
  }
  bool SendEvent(const Json& event, uint64_t, DeliveryFlag = {}) override {
    std::lock_guard lock(mutex);
    events.push_back(event);
    return true;
  }
  void OnDisconnect(Disconnect) override {}
  Result<Json> Request(const std::string&, Json) override { return Json::object(); }
};
void ManagementDispatch() {
  TemporaryDirectory directory;
  auto parsed = RuntimeOptions::FromConfig(TestConfig(), directory.path, "dev", "test");
  Check(bool(parsed), "fixture options");
  FixtureLink link;
  auto desired = test::Desired();
  auto conflict = desired;
  conflict["profileKey"] = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
  auto stale = desired;
  stale["placementEpoch"] = 2;
  auto invalid = desired;
  invalid["run"] = "running";
  invalid["commit"] = "invalid";
  auto logs = test::Rpc("session.logs.read", {{"log", "browser"}, {"maxBytes", 128}}, "log-read");
  auto replay = logs;
  replay["replay"] = true;
  auto unknown = logs;
  unknown["opId"] = "evicted";
  unknown["replay"] = true;
  link.requests = {test::NodeDesired(Json::array({test::Placement()})),
                   desired,
                   conflict,
                   stale,
                   invalid,
                   logs,
                   replay,
                   unknown};
  media::Sdk sdk;
  Service service(sdk, parsed.value(), link, {}, "endpoint");
  Check(service.Run() == 0, "management dispatch");
  auto reply = [&](int id) -> Json {
    for (const auto& value : link.replies)
      if (value["id"] == id)
        return value;
    throw std::logic_error("missing reply");
  };
  Check(reply(0)["ok"] && reply(1)["ok"], "fence and desired acceptance");
  Check(reply(2)["error"]["code"] == "conflict" && reply(3)["error"]["code"] == "conflict",
        "revision and placement conflicts");
  Check(reply(4)["error"]["code"] == "invalid_request", "running commit rejected");
  Check(reply(5)["ok"] && reply(6)["result"] == reply(5)["result"], "target-bound RPC replay");
  Check(reply(7)["error"]["code"] == "outcome_unknown", "missing replay never executes");
  Check(!link.events.empty() && link.events[0]["event"] == "session.observed",
        "initial observed replaces copy report");
}
}  // namespace
int main(int argc, char** argv) {
  if (argc > 1 && std::string_view(argv[1]) == "--check-profile-key") {
    HANDLE reader = nullptr, unrelated = nullptr;
    for (int i = 2; i < argc; ++i) {
      std::string argument = argv[i];
      if (argument.starts_with("--profile-key-handle="))
        reader = reinterpret_cast<HANDLE>(std::stoull(argument.substr(21)));
      if (argument.starts_with("--unrelated-handle="))
        unrelated = reinterpret_cast<HANDLE>(std::stoull(argument.substr(19)));
    }
    std::array<uint8_t, 32> bytes;
    // Handle values can be reused for child runtime objects.
    SetEvent(unrelated);
    DWORD count = 0;
    if (!reader || !ReadFile(reader, bytes.data(), 32, &count, nullptr) || count != 32 ||
        !std::all_of(bytes.begin(), bytes.end(), [](uint8_t b) { return b == 7; }))
      return 1;
    uint8_t tail;
    bool extra = ReadFile(reader, &tail, 1, &count, nullptr) && count;
    CloseHandle(reader);
    return extra ? 1 : 0;
  }
  try {
    NumericOptions();
    AdvertisedCandidates();
    ProcessArguments();
    Durability();
    ThreadFailure();
    ProcessOwnership();
    ManagementDispatch();
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
