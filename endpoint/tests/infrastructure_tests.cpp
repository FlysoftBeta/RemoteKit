#include "coordination_fixture.hpp"
#include "runtime_config_fixture.hpp"
#include "cluster/noise.hpp"
#include "management/link.hpp"
#include "management/reply.hpp"
#include "objects/work_queue.hpp"
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
#include <condition_variable>
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
  Check(bool(process.Terminate()) && process.JobEmpty() &&
            process.state() == BrowserProcess::State::kExited,
        "stop confirms process exit");
  process.ReleaseExited();
  Check(!process.Present() && process.state() == BrowserProcess::State::kStopped,
        "release confirmed process");
  TemporaryDirectory directory;
  const auto locked_path = directory.path / "browser-file";
  const auto ready_name = L"Local\\RemoteKitJob-" + std::to_wstring(GetCurrentProcessId());
  const auto ready = CreateEventW(nullptr, TRUE, FALSE, ready_name.c_str());
  Check(ready != nullptr, "job child readiness event");
  Check(bool(process.Launch(executable,
                            BrowserProcess::Quote(executable.wstring()) + L" --spawn-job-child " +
                                BrowserProcess::Quote(locked_path.wstring()) + L" " +
                                BrowserProcess::Quote(ready_name),
                            key)),
        "launch browser tree fixture");
  Check(WaitForSingleObject(ready, 5000) == WAIT_OBJECT_0, "job child holds session file");
  CloseHandle(ready);
  const auto tree_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (process.Alive() && std::chrono::steady_clock::now() < tree_deadline)
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  Check(process.Exited() && !process.JobEmpty(), "child outlives root browser process");
  Check(bool(process.Terminate()) && process.JobEmpty(), "termination drains descendant job");
  if (!DeleteFileW(locked_path.c_str()))
    throw std::logic_error("session file released before stop returns: Win32 " +
                           std::to_string(GetLastError()));
  process.ReleaseExited();
}
class FixtureLink : public ManagementLink {
 public:
  std::vector<Json> requests, replies, events;
  std::mutex mutex;
  std::condition_variable replied;
  size_t index = 0;
  std::optional<ReadyState> ReadyConfiguration() override {
    return ReadyState{7,
                      {{"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
                       {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}},
                      "connection"};
  }
  bool Next(std::string& bytes, uint64_t& generation, bool& eof) override {
    // Replay assertions require the preceding RPC result to have been retained.
    std::unique_lock lock(mutex);
    Check(replied.wait_for(lock, std::chrono::seconds(5), [&] { return replies.size() == index; }),
          "fixture reply deadline");
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
    replied.notify_all();
    return true;
  }
  bool SendEvent(const Json& event, uint64_t, DeliveryFlag = {}) override {
    std::lock_guard lock(mutex);
    events.push_back(event);
    return true;
  }
  void OnDisconnect(Disconnect) override {}
  Result<Json> Request(const std::string&, Json) override {
    return Json{{"ok", true}};
  }
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
void WorkerQueueBoundary() {
  objects::WorkQueue queue(0);
  for (size_t i = 0; i < limits::managementWorkerQueue; ++i)
    Check(queue.Submit([] {}), "worker queue accepts exact count bound");
  Check(!queue.Submit([] {}), "worker queue rejects one past bound");
}
class SaturatedLink final : public ManagementLink {
 public:
  std::mutex mutex;
  std::condition_variable wake;
  size_t next = 0, blocked = 0;
  bool release = false;
  Json busy;
  bool Next(std::string& bytes, uint64_t& generation, bool& eof) override {
    std::unique_lock lock(mutex);
    if (next == 4)
      Check(wake.wait_for(lock, std::chrono::seconds(5), [&] { return blocked == 4; }),
            "all management workers occupied");
    eof = next == 4 + limits::managementWorkerQueue + 1;
    if (eof) {
      release = true;
      wake.notify_all();
      return false;
    }
    auto request =
        test::Rpc("node.logs.search", {{"errorId", "e-0123456789"}}, "op-" + std::to_string(next));
    request.update(
        {{"id", next}, {"tenantId", ""}, {"sessionId", nullptr}, {"placementEpoch", nullptr}});
    bytes = request.dump();
    generation = 1;
    ++next;
    return true;
  }
  bool Current(uint64_t generation) override { return generation == 1; }
  bool SendReply(uint64_t, const Json& reply) override {
    std::unique_lock lock(mutex);
    if (reply.value("ok", true) == false && reply.at("error").at("code") == "busy") {
      busy = reply;
      return true;
    }
    ++blocked;
    wake.notify_all();
    wake.wait(lock, [&] { return release; });
    return true;
  }
  bool SendEvent(const Json&, uint64_t, DeliveryFlag = {}) override { return true; }
  void OnDisconnect(Disconnect) override {}
  Result<Json> Request(const std::string&, Json) override { return Json::object(); }
};
void WorkerBusyReply() {
  TemporaryDirectory directory;
  const auto options = RuntimeOptions::FromConfig(TestConfig(), directory.path, "dev", "test");
  Check(bool(options), "worker saturation options");
  SaturatedLink link;
  media::Sdk sdk;
  Service service(sdk, options.value(), link, {}, "endpoint");
  Check(service.Run() == 0, "worker saturation keeps service alive");
  const auto id = 4 + limits::managementWorkerQueue;
  Check(link.busy.value("id", size_t(-1)) == id &&
            link.busy.value("opId", "") == "op-" + std::to_string(id) &&
            link.busy.at("error").at("code") == "busy",
        "busy reply preserves id and opId");
}
class EventPressureLink final : public FixtureLink {
 public:
  QueueBudget budget{1, limits::managementQueueBytes};
  bool refuse = false;
  QueueBudget EventBudget() override { return budget; }
  bool SendEvent(const Json& event, uint64_t, DeliveryFlag = {}) override {
    if (refuse)
      return false;
    events.push_back(event);
    return true;
  }
};
void EventReplayPressure() {
  TemporaryDirectory directory;
  const auto options = RuntimeOptions::FromConfig(TestConfig(), directory.path, "dev", "test");
  Check(bool(options), "event replay options");
  const auto session_id = std::string(32, 'a');
  SessionDb database(options.value().data / "sessions" / session_id);
  Check(bool(database.Open()), "event replay database");
  for (int i = 1; i <= 3; ++i)
    Check(bool(database.Events().Append("view.closed",
                                        {{"viewId", std::to_string(i)}, {"reason", "script"}},
                                        "event-" + std::to_string(i), "browser")),
          "persistent replay event");
  const auto state = database.Events().State();
  Check(bool(state) && bool(database.Close()), "close replay database");
  Check(bool(Checkpoints::WriteCopy(options.value().data / "sessions" / session_id,
                                    {{"version", 1},
                                     {"sessionId", session_id},
                                     {"placementEpoch", uint64_t(1)},
                                     {"base", nullptr},
                                     {"state", "dirty"},
                                     {"stoppedCleanly", true},
                                     {"changesAt", 0},
                                     {"lastCommit", nullptr}})),
        "replay database belongs to a local copy");
  EventPressureLink link;
  media::Sdk sdk;
  objects::ObjectService objects(options.value().data, link, {}, "test", "dev");
  media::FrameAdmission admission;
  const auto execution = std::make_shared<SessionExecution>(
      sdk, options.value(), link, objects, admission,
      Json{{"tenantId", "tenant"}, {"sessionId", session_id}, {"placementEpoch", uint64_t(1)}},
      "endpoint");
  execution->Activate("connection", 7);
  const auto hooks = execution->Hooks();
  const auto stream = state.value().at("streamId").get<std::string>();
  hooks.maintain();
  Check(link.events.size() == 1 && link.events.back().at("seq") == "1",
        "replay pass respects queue credit");
  Check(!hooks.acknowledge(stream, 2), "unsent event cannot be acknowledged");
  Check(bool(hooks.acknowledge(stream, 1)), "sent prefix can be acknowledged");
  link.budget.messages = 2;
  link.refuse = true;
  hooks.maintain();
  Check(!hooks.acknowledge(stream, 2), "failed enqueue does not advance sent cursor");
  link.refuse = false;
  std::this_thread::sleep_for(std::chrono::milliseconds(510));
  hooks.maintain();
  Check(
      link.events.size() == 3 && link.events[1].at("seq") == "2" && link.events[2].at("seq") == "3",
      "refused events replay from durable stream");
  Check(bool(hooks.acknowledge(stream, 3)), "replayed prefix can be acknowledged");
}
}  // namespace
int main(int argc, char** argv) {
  if (argc >= 4 && std::string_view(argv[1]) == "--spawn-job-child") {
    wchar_t self[32768]{};
    GetModuleFileNameW(nullptr, self, 32768);
    std::wstring command = BrowserProcess::Quote(self) + L" --hold-job-file " +
                           BrowserProcess::Quote(fs::path(argv[2]).wstring()) + L" " +
                           BrowserProcess::Quote(fs::path(argv[3]).wstring());
    STARTUPINFOW startup{sizeof(startup)};
    PROCESS_INFORMATION child{};
    if (!CreateProcessW(self, command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr,
                        nullptr, &startup, &child))
      return 1;
    CloseHandle(child.hThread);
    CloseHandle(child.hProcess);
    return 0;
  }
  if (argc >= 4 && std::string_view(argv[1]) == "--hold-job-file") {
    const auto file = CreateFileW(fs::path(argv[2]).c_str(), GENERIC_READ | GENERIC_WRITE, 0,
                                  nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    const auto ready = OpenEventW(EVENT_MODIFY_STATE, FALSE, fs::path(argv[3]).c_str());
    if (file == INVALID_HANDLE_VALUE || !ready)
      return 1;
    SetEvent(ready);
    CloseHandle(ready);
    Sleep(INFINITE);
    return 0;
  }
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
    WorkerQueueBoundary();
    WorkerBusyReply();
    EventReplayPressure();
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
