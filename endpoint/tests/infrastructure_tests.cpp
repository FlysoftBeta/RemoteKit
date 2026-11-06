#include "runtime_config_fixture.hpp"
#include "cluster/noise.hpp"
#include "management/link.hpp"
#include "options.hpp"
#include "persistence/session_store.hpp"
#include "platform/process.hpp"
#include "service.hpp"
#include "media/sdk_loader.hpp"
#include "util/thread.hpp"
#include <windows.h>
#include <array>
#include <fstream>
#include <iostream>
#include <stdexcept>
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
      "fps",      "bitrate",   "maxBitrate",     "asyncDepth",      "gop",        "targetUsage",
      "bufferMs", "idleIdrMs", "maxEncodeWidth", "maxEncodeHeight", "maxSessions"};
  for (const auto* name : names) {
    for (const auto& invalid : {Json("1"), Json(-1), Json(true), Json(1.5), Json(4294967296ULL)}) {
      auto config = TestConfig();
      config[name] = invalid;
      auto parsed = Options(config);
      Check(!parsed && parsed.error().code == ErrorCode::kInvalidRequest &&
                parsed.error().message.find(name) != std::string::npos,
            "numeric field must reject invalid type/range and identify field");
    }
  }
  auto config = TestConfig();
  config["fps"] = 120;
  Check(bool(Options(config)), "valid boundary");
  config["fps"] = 121;
  Check(!Options(config), "fps range");
  config = TestConfig();
  config["maxBitrate"] = 100000;
  Check(!Options(config), "maxBitrate below bitrate");
  config = TestConfig();
  config["encoder"] = "nvenc";
  config["qsvLowPower"] = "off";
  Check(!Options(config), "nvenc rejects qsvLowPower");
  config["qsvLowPower"] = "auto";
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
  Check(options.data == fs::current_path() / "data" && options.browser.is_absolute(),
        "paths resolved against node root");
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
  Check(bool(parse({"endpoint", "--stdio", "--node-id=test", root})), "local arguments");
  for (auto arguments : std::vector<std::vector<std::string>>{
           {"endpoint"},
           {"endpoint", "--node-root=relative"},
           {"endpoint", root, root},
           {"endpoint", root, "--node-id=test"},
           {"endpoint", "--stdio", root},
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
  SessionStore store(directory.path);
  Check(bool(store.Save("state.json", {{"value", 1}})), "initial durable write");
  fs::create_directory(directory.path / "state.json.new");
  Check(!store.Save("state.json", {{"value", 2}}), "failed temp write must fail the transaction");
  Check(store.Load("state.json").at("value") == 1,
        "failed transaction must preserve committed state");
  Check(bool(store.Save("state.json", {{"value", 3}})), "replacement durable write");
  Check(store.Load("state.json").at("value") == 3, "committed replacement");
  Check(!fs::exists(directory.path / "state.json.new"), "temporary file is removed");
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
  SessionStore& store;
  fs::path directory;
  std::vector<Json> replies;
  size_t index = 0;
  explicit FixtureLink(SessionStore& value, fs::path path)
      : store(value), directory(std::move(path)) {}
  bool Next(std::string& bytes, uint64_t& generation, bool& eof) override {
    static const std::vector<Json> requests{
        {{"id", 100}, {"method", "session.snapshot"}, {"tenantId", "tenant"}},
        {{"id", 101},
         {"method", "session.open"},
         {"tenantId", "tenant"},
         {"sessionId", "bad"},
         {"placementEpoch", 1},
         {"profileKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}},
        {{"id", 103},
         {"method", "session.open"},
         {"tenantId", "tenant"},
         {"sessionId", "0123456789abcdef0123456789abcdef"},
         {"placementEpoch", 1},
         {"profileKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}},
        {{"id", 104},
         {"method", "session.open"},
         {"tenantId", "tenant"},
         {"sessionId", "0123456789abcdef0123456789abcdef"},
         {"placementEpoch", 1},
         {"profileKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}},
        {{"id", 105},
         {"method", "session.open"},
         {"tenantId", "tenant"},
         {"sessionId", "0123456789abcdef0123456789abcdef"},
         {"placementEpoch", 1},
         {"profileKey", "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="}},
        {{"id", 106},
         {"method", "session.open"},
         {"tenantId", "tenant"},
         {"sessionId", "0123456789abcdef0123456789abcdef"},
         {"placementEpoch", 2},
         {"profileKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}},
        {{"id", 107},
         {"method", "session.open"},
         {"tenantId", "tenant"},
         {"sessionId", "1123456789abcdef0123456789abcdef"},
         {"placementEpoch", 1},
         {"profileKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}},
        {{"id", 108},
         {"method", "session.open"},
         {"tenantId", "other"},
         {"sessionId", "0123456789abcdef0123456789abcdef"},
         {"placementEpoch", 1},
         {"profileKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}},
        {{"id", 0}, {"method", "unknown"}, {"tenantId", "new-tenant"}},
        {{"id", 1}, {"method", "session.snapshot"}, {"tenantId", "tenant"}},
        {{"id", 2}, {"method", "session.events.ack"}, {"tenantId", "tenant"}, {"eventIds", {"1"}}},
        {{"id", 3}, {"method", "session.snapshot"}, {"tenantId", "tenant"}},
        {{"id", 4}, {"method", "session.events.ack"}, {"tenantId", "tenant"}, {"eventIds", {"1"}}},
        {{"id", 5}, {"method", "session.snapshot"}, {"tenantId", "tenant"}},
        {{"id", 6}, {"method", "shutdown"}}};
    eof = index == requests.size();
    if (eof)
      return false;
    if (requests[index]["id"] == 2)
      fs::create_directory(directory / "sessions/0123456789abcdef0123456789abcdef/events.json.new");
    generation = 7;
    auto request = requests[index++];
    if (request.value("method", std::string()) == "session.open") {
      request["objectKey"] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
      request["objectIdKey"] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
      request["checkpoint"] = std::string(64, 'a');
      request["placementEpoch"] = request["id"] == 106 ? 1 : 2;
    }
    bytes = request.dump();
    return true;
  }
  bool Current(uint64_t generation) override { return generation == 7; }
  bool SendReply(uint64_t generation, const Json& reply) override {
    Check(generation == 7, "request link generation");
    replies.push_back(reply);
    return true;
  }
  bool SendEvent(const Json&, uint64_t) override { return true; }
  void OnDisconnect(Disconnect) override {}
  Result<Json> Request(const std::string&, Json) override {
    return Error{ErrorCode::kUnavailable, "test Control has no object responder"};
  }
};
void ManagementDispatch() {
  TemporaryDirectory directory;
  SessionStore store(directory.path);
  Check(bool(store.Save("sessions/0123456789abcdef0123456789abcdef.checkpoint",
                        std::string(64, 'a'))),
        "warm copy fixture");
  Check(bool(store.Save(
            "sessions/0123456789abcdef0123456789abcdef/events.json",
            {{"next", 2},
             {"events",
              Json::array({{{"eventId", "1"}, {"type", "view.closed"}, {"viewId", "1"}}})}})),
        "event fixture");
  auto config = TestConfig();
  config["dataPath"] = Utf8(directory.path);
  auto parsed = Options(config);
  Check(bool(parsed), "fixture options");
  FixtureLink link(store, directory.path);
  media::Sdk sdk;
  Service service(sdk, parsed.value(), link, cluster::Key{});
  Check(service.Run() == 0, "management dispatch");
  auto reply = [&](int id) -> Json {
    for (const auto& value : link.replies)
      if (value["id"] == id)
        return value;
    throw std::logic_error("missing reply");
  };
  Check(reply(100)["error"]["code"] == "not_found", "unopened tenant");
  Check(reply(101)["error"]["code"] == "invalid_request", "invalid session ID");
  Check(reply(103)["ok"] && reply(104)["ok"], "idempotent session.open");
  for (int id : {105, 106, 107, 108})
    Check(reply(id)["error"]["code"] == "conflict", "placement/key/identity conflict");
  Check(reply(0)["error"]["code"] == "invalid_request", "unknown method error code");
  Check(reply(1)["result"]["events"].size() == 1, "event loaded");
  Check(reply(2)["error"]["code"] == "unavailable",
        "failed acknowledgement reports persistence failure");
  Check(reply(3)["result"]["events"].size() == 1, "failed acknowledgement preserves memory");
  Check(reply(5)["result"]["events"].empty(), "acknowledged events removed");
  Check(store.Load("sessions/0123456789abcdef0123456789abcdef/events.json")["events"].empty(),
        "acknowledgement committed");
  Check(!fs::exists(directory.path / "sessions.json"), "no numeric registry");
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
