#include "release_fixtures.hpp"
#include "release/payload.hpp"
#include "release/crypto.hpp"
#include "manager/supervisor.hpp"
#include "manager/snapshots.hpp"
#include <thread>
#include "updater/archive.hpp"
#include "updater/download.hpp"
#include "release/executor.hpp"
#include <iostream>

namespace {
std::atomic<ULONGLONG> manager_clock_offset = 0;
std::optional<remotekit::release::Fetched> manager_release;
ULONGLONG ManagerClock() {
  return GetTickCount64() + manager_clock_offset.load();
}
}  // namespace
namespace remotekit::release {
Fetched FetchManagerFixture(const std::string&,
                            State& state,
                            const fs::path& base,
                            const fs::path&,
                            const Key&,
                            const Http&,
                            RetryUnit& retry) {
  if (!manager_release)
    Fail(ErrorCode::kUnavailable, "fixture release unavailable");
  retry.Input(manager_release->build_id);
  if (!retry.Ready())
    throw Failure(*retry.Failure());
  if (state.current == manager_release->build_id)
    return {state.current, {}, base};
  return *manager_release;
}
}  // namespace remotekit::release
#define GetTickCount64 ManagerClock
#define Fetch FetchManagerFixture
#include "../manager/supervisor.cpp"
#undef Fetch
#undef GetTickCount64

using namespace remotekit;
using namespace remotekit::release;
using namespace release_test;
namespace {
template <class Predicate>
void Until(Predicate predicate, const char* message) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (!predicate()) {
    Check(std::chrono::steady_clock::now() < deadline, message);
    Sleep(10);
  }
}
std::string TextFile(const fs::path& path) {
  std::ifstream input(path, std::ios::binary);
  return {(std::istreambuf_iterator<char>(input)), {}};
}
Json ManagerEvents(const fs::path& root) {
  std::ifstream input(root / L"logs/manager.log");
  Json records = Json::array();
  for (std::string line; std::getline(input, line);)
    records.push_back(Json::parse(line));
  return records;
}
void ConfigureManager(const fs::path& root) {
  fs::create_directories(root / L"config");
  WriteText(root / L"config/manager.json",
            R"({"version":1,"manifest":"http://127.0.0.1:1/release","checkIntervalMinutes":5})");
  WriteText(root / L"config/release.key", EncodeKey(Key{}));
}
class ManagerRun {
 public:
  explicit ManagerRun(const fs::path& root)
      : stop_(CreateEventW(nullptr, TRUE, FALSE, nullptr)),
        thread_([this, root] { code_ = manager::Supervise(root, stop_.value, false); }) {}
  ~ManagerRun() { Stop(); }
  void Stop() {
    SetEvent(stop_.value);
    if (thread_.joinable())
      thread_.join();
  }
  int code() const { return code_.load(); }

 private:
  updater::Handle stop_;
  std::atomic<int> code_ = -1;
  std::jthread thread_;
};
Bytes ControlPayload(const std::string& id) {
  Bytes tar;
  const auto build = Json{{"buildId", id}}.dump();
  Entry(tar, "build.json", build);
  Entry(tar, "node/build.json", build);
  const auto executable = Read(updater::ExecutablePath());
  Entry(tar, "bin/node.exe", {reinterpret_cast<const char*>(executable.data()), executable.size()});
  for (auto name : {"bin/remotekit_control.exe", "bin/remotekit_node.exe",
                    "control/dist/server.mjs", "node/bin/endpoint_service.exe",
                    "node/bin/remotekit_node.exe", "node/bin/remotekit_snapshot.exe"})
    Entry(tar, name, "fixture");
  tar.resize(tar.size() + 1024);
  return tar;
}
enum class Damage {
  kCurrent,
  kMissingBuild,
  kMissingFile,
  kInvalidBuild,
  kMismatchedBuild,
  kLargeBuild
};
void DamageInstallation(const fs::path& root, const std::string& id, Damage damage) {
  const auto version = root / L"versions" / id;
  switch (damage) {
    case Damage::kCurrent:
      WriteText(root / L"current", "../invalid");
      return;
    case Damage::kMissingBuild:
      fs::remove(version / L"build.json");
      return;
    case Damage::kMissingFile:
      fs::remove(version / L"bin/remotekit_node.exe");
      return;
    case Damage::kInvalidBuild:
      WriteText(version / L"build.json", "{");
      return;
    case Damage::kMismatchedBuild:
      WriteText(version / L"build.json", Json{{"buildId", std::string(64, 'b')}}.dump());
      return;
    case Damage::kLargeBuild:
      WriteText(version / L"build.json", std::string(65537, 'x'));
      return;
  }
}
void SelfHealing(const fs::path& scratch) {
  const std::string id(64, 'a');
  const auto payload = ControlPayload(id);
  unsigned index = 0;
  for (auto damage : {Damage::kCurrent, Damage::kMissingBuild, Damage::kMissingFile,
                      Damage::kInvalidBuild, Damage::kMismatchedBuild, Damage::kLargeBuild}) {
    const auto root = scratch / ("heal-" + std::to_string(index++));
    ConfigureManager(root);
    const auto input = scratch / ("heal-input-" + std::to_string(index) + ".tar");
    Write(input, payload);
    InstallPayload(root, input, id, PayloadSource::kCopy);
    WriteText(root / L"current", id);
    DamageInstallation(root, id, damage);
    auto state = Take(manager::Current(root));
    const auto* missing = std::get_if<NotInstalled>(&state);
    Check(missing && missing->invalid && !missing->invalid->empty(),
          "damaged current is uninstalled with a reason");
    fs::create_directories(root / L"versions/obsolete");
    fs::create_directories(root / L"work/stage-obsolete");
    WriteText(root / L"work/payload-obsolete.tar", "obsolete");
    manager_release = Fetched{id, {}, input};
    ManagerRun running(root);
    Until([&] { return fs::exists(root / L"control-child.pid"); },
          "manager did not reinstall damaged version");
    Check(InstalledId(Take(manager::Current(root))) == id, "reinstalled current is valid");
    Check(!fs::exists(root / L"versions/obsolete") && !fs::exists(root / L"work/stage-obsolete") &&
              !fs::exists(root / L"work/payload-obsolete.tar"),
          "damaged installation cleaned before reinstall");
    running.Stop();
    Check(running.code() == 0, "self-healing manager stops normally");
    const auto events = ManagerEvents(root);
    unsigned warnings = 0;
    for (const auto& event : events) {
      if (event.at("ev") == "current.invalid") {
        ++warnings;
        Check(event.at("lvl") == "warn" && !event.at("message").get<std::string>().empty(),
              "invalid current warning has its reason");
      }
      Check(event.at("ev") != "manager.current_failed", "damage does not use the error channel");
    }
    Check(warnings == 1, "one current invalid warning per installation");
    manager_release.reset();
  }
}
void ReadFailure(const fs::path& root, const fs::path& blocked_file) {
  ConfigureManager(root);
  fs::create_directories(root / L"versions/preserve");
  fs::create_directories(root / L"work/stage-preserve");
  updater::Handle blocked(CreateFileW(blocked_file.c_str(), GENERIC_READ, 0, nullptr, OPEN_EXISTING,
                                      FILE_ATTRIBUTE_NORMAL, nullptr));
  Check(blocked.value != INVALID_HANDLE_VALUE, "fixture file is locked");
  ManagerRun running(root);
  Until(
      [&] {
        return TextFile(root / L"logs/manager.log").find("manager.current_failed") !=
               std::string::npos;
      },
      "startup read failure was not reported");
  Check(fs::exists(root / L"versions/preserve") && fs::exists(root / L"work/stage-preserve"),
        "read failure preserves startup state");
  Check(!fs::exists(root / L"control-child.pid"), "read failure does not launch Control");
  running.Stop();
  Check(running.code() == 0, "read failure manager stops normally");
  for (const auto& event : ManagerEvents(root))
    if (event.at("ev") == "manager.current_failed")
      Check(event.at("err").at("code") == "unavailable", "read failure is unavailable");
}
void RunningReadFailure(const fs::path& scratch) {
  const std::string id(64, 'a');
  const auto payload = ControlPayload(id);
  for (const auto* name : {L"current", L"build.json"}) {
    const auto root = scratch / (std::wstring(L"running-") + name);
    ConfigureManager(root);
    const auto input = scratch / (std::wstring(L"running-input-") + name + L".tar");
    Write(input, payload);
    const auto version = InstallPayload(root, input, id, PayloadSource::kCopy);
    WriteText(root / L"current", id);
    ManagerRun running(root);
    Until([&] { return fs::exists(root / L"control-child.pid"); }, "Control fixture did not start");
    const auto pid = static_cast<DWORD>(std::stoul(TextFile(root / L"control-child.pid")));
    updater::Handle process(OpenProcess(SYNCHRONIZE, FALSE, pid));
    Check(process.value != nullptr, "Control fixture process opened");
    const auto blocked_file = std::wstring_view(name) == L"current" ? root / name : version / name;
    updater::Handle blocked(CreateFileW(blocked_file.c_str(), GENERIC_READ, 0, nullptr,
                                        OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    Check(blocked.value != INVALID_HANDLE_VALUE, "running current read fixture locked");
    manager_clock_offset += 300001;
    Until(
        [&] {
          return TextFile(root / L"logs/manager.log").find("manager.current_failed") !=
                 std::string::npos;
        },
        "periodic read failure was not reported");
    Sleep(200);
    Check(WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT,
          "periodic read failure keeps Control running");
    Check(!fs::exists(root / L"control-child.stopped"),
          "periodic read failure does not close Control stdin");
    running.Stop();
    Check(running.code() == 0, "running manager stops normally");
    const auto events = ManagerEvents(root);
    unsigned started = 0;
    for (const auto& event : events)
      if (event.at("ev") == "control.started")
        ++started;
    Check(started == 1, "read failure does not restart Control");
    manager_clock_offset = 0;
  }
}
}  // namespace
int wmain(int argc, wchar_t** argv) {
  if (argc == 2 && fs::path(argv[1]).filename() == L"server.mjs") {
    WriteText(L"control-child.pid", std::to_string(GetCurrentProcessId()));
    char byte;
    DWORD count = 0;
    while (ReadFile(GetStdHandle(STD_INPUT_HANDLE), &byte, 1, &count, nullptr) && count) {
    }
    WriteText(L"control-child.stopped", "stdin EOF");
    return 0;
  }
  if (argc != 2)
    return 2;
  auto root = fs::absolute(fs::path(argv[1]) /
                           (L"manager-files-" + std::to_wstring(GetCurrentProcessId())));
  try {
    fs::create_directories(root);
    std::map<std::string, std::unique_ptr<int>> supervisors;
    Json nodes{{"first", {{"local", Json::object()}}}, {"second", {{"local", Json::object()}}}};
    unsigned starts = 0, failures = 0;
    auto start = [&](const std::string& node, const Json&) {
      ++starts;
      if (node == "second" && failures == 0)
        throw std::runtime_error("bad local path");
      return std::make_unique<int>(1);
    };
    auto failed = [&](const std::string& node, const std::exception&) {
      Check(node == "second", "snapshot failure identifies node");
      ++failures;
    };
    manager::ReconcileSnapshots(nodes, supervisors, start, failed);
    Check(supervisors.size() == 1 && supervisors.contains("first"),
          "successful snapshot supervisor retained");
    manager::ReconcileSnapshots(nodes, supervisors, start, failed);
    Check(supervisors.size() == 2 && starts == 3 && failures == 1, "only failed snapshot retried");
    std::string id(64, 'a');
    auto tar = PayloadTar(id);
    tar.resize(tar.size() - 1024);
    std::string long_path = "node/" + std::string(120, 'x') + "/asset.txt";
    std::string record = " path=" + long_path + "\n";
    size_t length = record.size() + 1;
    while (std::to_string(length).size() + record.size() != length)
      length = std::to_string(length).size() + record.size();
    Entry(tar, "PaxHeader", std::to_string(length) + record, 'x');
    Entry(tar, "placeholder", "raw PAX record");
    tar.resize(tar.size() + 1024);
    Write(root / L"input.tar", tar);
    auto payload_hash = HashFile(root / L"input.tar");
    Check(PayloadBuildId(root / L"input.tar") == id, "payload identity");
    Check(std::holds_alternative<NotInstalled>(Take(manager::Current(root))),
          "missing current is not installed");
    auto version = InstallPayload(root, root / L"input.tar", id, PayloadSource::kMove);
    Check(HashFile(version / L"payload.tar") == payload_hash && !fs::exists(root / L"input.tar"),
          "payload base retained");
    Check(!fs::exists(version / L"node"), "node files extracted into version");
    Check(InstallPayload(root, version / L"payload.tar", id, PayloadSource::kCopy) == version,
          "committed payload installation can be retried");
    WriteText(version / L"build.json", Json{{"buildId", std::string(64, 'b')}}.dump());
    try {
      InstallPayload(root, version / L"payload.tar", id, PayloadSource::kCopy);
      Check(false, "conflicting committed identity accepted");
    } catch (const Failure& failure) {
      Check(failure.error.code == ErrorCode::kConflict, "committed identity mismatch conflicts");
    }
    WriteText(version / L"build.json", Json{{"buildId", id}}.dump());
    auto manager_exe = version / L"bin/remotekit_control.exe";
    fs::remove(manager_exe);
    try {
      InstallPayload(root, version / L"payload.tar", id, PayloadSource::kCopy);
      Check(false, "incomplete committed version accepted");
    } catch (const Failure& failure) {
      Check(failure.error.code == ErrorCode::kConflict, "incomplete committed version conflicts");
    }
    WriteText(manager_exe, "fixture");
    Take(updater::ExtractArchive(version / L"release/node.tar.zst", root / L"extracted"));
    auto long_file = Read(root / L"extracted" / long_path);
    Check(std::string(long_file.begin(), long_file.end()) == "raw PAX record",
          "raw PAX node record");
    Check(Take(cluster::ReadBuildId(root / L"extracted/node")) == id,
          "node archive build identity");
    Take(updater::InstallBundled(root / L"local-node", version));
    fs::create_directories(root / L"local-node/runtime/obsolete");
    Take(updater::InstallBundled(root / L"local-node", version));
    Check(!fs::exists(root / L"local-node/runtime/obsolete"), "bundled runtime cleanup");
    auto reserved = tar;
    reserved.resize(reserved.size() - 1024);
    Entry(reserved, "release/evil", "bad");
    reserved.resize(reserved.size() + 1024);
    Write(root / L"reserved.tar", reserved);
    Reject(
        [&] { InstallPayload(root / L"reject", root / L"reserved.tar", id, PayloadSource::kCopy); },
        "reserved release path accepted");
    auto global = Bytes{};
    Entry(global, "global", "", 'g');
    global.insert(global.end(), tar.begin(), tar.end());
    Write(root / L"global.tar", global);
    Reject([&] { PayloadBuildId(root / L"global.tar"); }, "global PAX header accepted");
    Reject(
        [&] {
          InstallPayload(root / L"wrong", version / L"payload.tar", std::string(64, 'b'),
                         PayloadSource::kCopy);
        },
        "wrong build accepted");
    {
      auto lock = manager::Lock(root);
      Reject([&] { manager::Lock(root); }, "manager lock not exclusive");
    }
    AtomicText(root / L"current", id);
    Check(InstalledId(Take(manager::Current(root))) == id, "current version validation");
    {
      updater::Handle blocked(CreateFileW((root / L"current").c_str(), GENERIC_READ, 0, nullptr,
                                          OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
      auto unreadable = manager::Current(root);
      Check(!unreadable && unreadable.error().code == ErrorCode::kUnavailable,
            "current sharing failure is unavailable");
    }
    WriteText(root / L"current", "invalid");
    auto invalid = Take(manager::Current(root));
    Check(std::holds_alternative<NotInstalled>(invalid) && std::get<NotInstalled>(invalid).invalid,
          "invalid current is uninstalled with a reason");
    AtomicText(root / L"current", id);
    fs::remove(version / L"build.json");
    auto missing_build = Take(manager::Current(root));
    Check(std::holds_alternative<NotInstalled>(missing_build) &&
              std::get<NotInstalled>(missing_build).invalid,
          "missing build is uninstalled with a reason");
    WriteText(version / L"build.json", Json{{"buildId", id}}.dump());
    fs::create_directories(root / L"versions/obsolete");
    fs::create_directories(root / L"work/stage-obsolete");
    fs::create_directories(root / L"work/assets/keep");
    WriteText(root / L"work/payload-obsolete.tar", "old");
    WriteText(root / L"remotekit_control.exe.old", "old");
    WriteText(root / L"remotekit_control.exe.new", "staged");
    manager::Cleanup(root, id);
    Check(!fs::exists(root / L"remotekit_control.exe.old") &&
              !fs::exists(root / L"remotekit_control.exe.new"),
          "stale supervisor executables removed");
    Check(!fs::exists(root / L"versions/obsolete") && !fs::exists(root / L"work/stage-obsolete") &&
              !fs::exists(root / L"work/payload-obsolete.tar") &&
              fs::exists(root / L"work/assets/keep"),
          "manager cleanup");
    ReadFailure(root, root / L"current");
    fs::remove(root / L"logs/manager.log");
    ReadFailure(root, version / L"build.json");
    SelfHealing(root);
    RunningReadFailure(root);
    fs::remove_all(updater::ExtendedPath(root));
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
