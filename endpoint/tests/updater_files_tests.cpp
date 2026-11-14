#include "platform.hpp"
enum class AtomicFlushMode { kWrite, kFail };
AtomicFlushMode atomic_flush_mode = AtomicFlushMode::kWrite;
BOOL WINAPI AtomicFlush(HANDLE file) {
  if (atomic_flush_mode == AtomicFlushMode::kFail) {
    SetLastError(ERROR_WRITE_FAULT);
    return FALSE;
  }
  return FlushFileBuffers(file);
}
#define FlushFileBuffers AtomicFlush
#include "download.hpp"
#undef FlushFileBuffers
#include "process.hpp"
#include "archive.hpp"
#include "replacement.hpp"
#include "snapshot.hpp"
#include "supervisor.hpp"
#include "service.hpp"
#include "cluster/channel.hpp"
#include "util/retry_unit.hpp"
#include <fstream>
#include <iostream>
namespace remotekit {
std::optional<Error> command_error;
void CaptureCommandError(LogLevel, std::string_view, const Error& error) {
  command_error = error;
}
namespace updater {
Result<void> FailedUninstall(const Service&) {
  Error error{ErrorCode::kRejected, "original service failure", ErrorReason::kCorruptState};
  error.error_id = "e-1234567890";
  return error;
}
}  // namespace updater
}  // namespace remotekit
#define wmain CommandMain
#define LogError CaptureCommandError
#define UninstallService FailedUninstall
#include "../updater/main.cpp"
#undef UninstallService
#undef LogError
#undef wmain
namespace remotekit::cluster {
Json offered_release;
std::optional<Error> download_failure;
std::optional<Error> receive_failure;
unsigned download_requests = 0;
unsigned release_connections = 0;
class ReleaseChannel : public Channel {
 public:
  Result<void> Send(const Json&) override {
    ++download_requests;
    if (download_failure)
      return *download_failure;
    return {};
  }
  Result<void> SendBinary(const Json&, std::span<const uint8_t>) override { return {}; }
  Result<Message> Receive(std::chrono::milliseconds) override {
    if (receive_failure)
      return *receive_failure;
    if (step_++ == 0)
      return Message{
          Message::Kind::kBinary, {{"type", "package.chunk"}, {"offset", uint64_t(0)}}, {'x'}};
    return Message{Message::Kind::kJson, {{"type", "package.end"}, {"size", uint64_t(1)}}, {}};
  }
  void Close() override {}

 private:
  unsigned step_ = 0;
};
Result<Established> ReleaseConnection(const std::string&, const Key&, const Key&, const Hello&) {
  ++release_connections;
  return Established{std::make_unique<ReleaseChannel>(),
                     {{"type", "node.release"}, {"release", offered_release}}};
}
}  // namespace remotekit::cluster
namespace remotekit::updater {
enum class RuntimeMove { kNormal, kFailOnce };
RuntimeMove runtime_move = RuntimeMove::kNormal;
enum class Extraction { kArchive, kFixture };
Extraction extraction = Extraction::kArchive;
BOOL WINAPI MoveRuntime(LPCWSTR source, LPCWSTR destination, DWORD flags) {
  if (runtime_move == RuntimeMove::kFailOnce && fs::path(source).filename() == L"node") {
    runtime_move = RuntimeMove::kNormal;
    SetLastError(ERROR_ACCESS_DENIED);
    return FALSE;
  }
  return MoveFileExW(source, destination, flags);
}
Result<void> ExtractFixture(const fs::path& archive, const fs::path& destination) {
  if (extraction == Extraction::kArchive)
    return ExtractArchive(archive, destination);
  const auto runtime = destination / L"node";
  fs::create_directories(runtime / L"bin");
  release::WriteText(runtime / L"build.json",
                     Json{{"buildId", cluster::offered_release["buildId"]}}.dump());
  for (auto required : release::kNodeFiles)
    release::WriteText(runtime / required, "fixture");
  return {};
}
}  // namespace remotekit::updater
#define ConnectWebSocket ReleaseConnection
#define MoveFileExW MoveRuntime
#define ExtractArchive ExtractFixture
#include "../updater/download.cpp"
#undef ExtractArchive
#undef MoveFileExW
#undef ConnectWebSocket
namespace remotekit::updater {
unsigned supervised_updates = 0;
unsigned supervised_delays = 0;
enum class SupervisorFixture { kFinalError, kInstallRetry, kNewBuild };
SupervisorFixture supervisor_fixture = SupervisorFixture::kFinalError;
fs::path supervised_root;
Result<bool> SupervisedUpdate(const fs::path& root,
                              HANDLE stop,
                              Log&,
                              bool,
                              RetryUnit&,
                              UpdateStage& stage) {
  ++supervised_updates;
  supervised_root = root;
  if (supervisor_fixture == SupervisorFixture::kNewBuild && supervised_updates == 2)
    SetEvent(stop);
  if (supervisor_fixture == SupervisorFixture::kInstallRetry) {
    if (supervised_updates == 1) {
      stage = DownloadedRelease{};
      Error failure{ErrorCode::kUnavailable, "cannot move extracted runtime"};
      failure.retry_after_ms = 0;
      return failure;
    }
    if (!std::holds_alternative<DownloadedRelease>(stage))
      throw std::runtime_error("supervisor discarded the downloaded release after cleanup");
    SetEvent(stop);
    return false;
  }
  return Error{ErrorCode::kInvalidRequest, "duplicate key in cluster JSON"};
}
bool SupervisedDelay(HANDLE stop, DWORD) {
  ++supervised_delays;
  if (supervisor_fixture == SupervisorFixture::kNewBuild && supervised_delays == 10) {
    const auto runtime = supervised_root / L"runtime" / std::string(64, 'c');
    fs::create_directories(runtime / L"bin");
    for (auto required : release::kNodeFiles)
      release::WriteText(runtime / required, "fixture");
    release::WriteText(runtime / L"build.json", Json{{"buildId", std::string(64, 'c')}}.dump());
    release::WriteText(supervised_root / L"current", std::string(64, 'c'));
  }
  if (supervised_delays == 20)
    SetEvent(stop);
  return Stopping(stop);
}
}  // namespace remotekit::updater
#define Supervise TestSupervise
#define Update SupervisedUpdate
#define Delay SupervisedDelay
#include "../updater/supervisor.cpp"
#undef Delay
#undef Update
#undef Supervise
using namespace remotekit;
using namespace remotekit::cluster;
using namespace remotekit::updater;
namespace {
void Check(bool value) {
  if (!value)
    throw std::runtime_error("node files/log assertion failed");
}
void Write(const fs::path& path, const Json& value) {
  std::ofstream(path) << value.dump();
}
}  // namespace
int wmain(int argc, wchar_t** argv) {
  if (argc == 2 && std::wstring_view(argv[1]) == L"--flood") {
    std::string bytes(65536, 'x');
    for (unsigned i = 0; i < 256; ++i)
      std::cout << bytes;
    return 0;
  }
  if (argc != 2)
    return 2;
  auto root = fs::path(argv[1]) / (L"node-files-" + std::to_wstring(GetCurrentProcessId()));
  try {
    fs::create_directories(root);
    wchar_t executable[] = L"node";
    wchar_t uninstall[] = L"service-uninstall";
    wchar_t* command[] = {executable, uninstall};
    Check(CommandMain(2, command) == 1);
    Check(command_error && command_error->code == ErrorCode::kRejected &&
          command_error->message == "original service failure" &&
          command_error->error_id == "e-1234567890" &&
          command_error->reason == ErrorReason::kCorruptState);
    Check(CommandMain(1, command) == 1);
    Check(command_error && command_error->code == ErrorCode::kInvalidRequest);
    Json config = {{"version", 1},
                   {"control", "ws://example.test/api/node"},
                   {"privateKey", std::string(43, 'A') + "="},
                   {"controlPublicKey", std::string(43, 'A') + "="},
                   {"nodeId", "node-1"}};
    Write(root / L"node.json", config);
    auto files = LoadNodeFiles(root);
    Check(static_cast<bool>(files));
    Check(files.value().node_id == "node-1" && files.value().private_key == Key{});
    config.erase("control");
    Write(root / L"node.json", config);
    Check(bool(LoadNodeFiles(root)));
    config["control"] = "ws://example.test/api/node";
    config.erase("nodeId");
    Write(root / L"node.json", config);
    Check(!LoadNodeFiles(root));
    config["nodeId"] = "node-1";
    config["extra"] = true;
    Write(root / L"node.json", config);
    Check(!LoadNodeFiles(root));
    config.erase("extra");
    config["privateKey"] = std::string(42, 'A') + "B=";
    Write(root / L"node.json", config);
    Check(!LoadNodeFiles(root));
    config["privateKey"] = std::string(43, 'A') + "=";
    for (auto id : {"Upper", "-node", "node/name", ""}) {
      config["nodeId"] = id;
      Write(root / L"node.json", config);
      Check(!LoadNodeFiles(root));
    }
    config["nodeId"] = "node";
    config["control"] = "wss://example.test/api/node?key=secret";
    Write(root / L"node.json", config);
    Check(!LoadNodeFiles(root));
    Check(ReadBuildId(root).value() == "dev");
    Write(root / L"build.json", {{"buildId", std::string(64, 'a')}});
    Check(ReadBuildId(root).value() == std::string(64, 'a'));
    Write(root / L"build.json", {{"buildId", "dev"}});
    Check(!ReadBuildId(root));
    Write(root / L"build.json", {{"buildId", std::string(64, 'a')}, {"extra", true}});
    Check(!ReadBuildId(root));
    auto runtime = root / L"runtime" / std::string(64, 'a');
    fs::create_directories(runtime / L"bin");
    Write(runtime / L"build.json", {{"buildId", std::string(64, 'a')}});
    std::ofstream(runtime / L"bin/endpoint_service.exe") << "dummy";
    std::ofstream(runtime / L"bin/remotekit_snapshot.exe") << "dummy";
    std::ofstream(root / L"current") << std::string(64, 'a') << '\n';
    std::ofstream(runtime / L"bin/remotekit_node.exe") << "dummy";
    Check(release::InstalledId(release::Take(ReadCurrent(root))) == std::string(64, 'a'));
    std::ofstream(root / L"current") << "../escape";
    auto invalid = release::Take(ReadCurrent(root));
    Check(std::holds_alternative<release::NotInstalled>(invalid) &&
          std::get<release::NotInstalled>(invalid).invalid);
    fs::remove(root / L"current");
    const auto absent = release::Take(ReadCurrent(root));
    Check(std::holds_alternative<release::NotInstalled>(absent) &&
          !std::get<release::NotInstalled>(absent).invalid);
    release::AtomicText(root / L"current", std::string(64, 'a'));
    fs::remove(runtime / L"bin/remotekit_node.exe");
    auto incomplete = release::Take(ReadCurrent(root));
    Check(std::holds_alternative<release::NotInstalled>(incomplete) &&
          std::get<release::NotInstalled>(incomplete).invalid);
    std::ofstream(runtime / L"bin/remotekit_node.exe") << "dummy";
    fs::remove(runtime / L"build.json");
    auto missing_build = release::Take(ReadCurrent(root));
    Check(std::holds_alternative<release::NotInstalled>(missing_build) &&
          std::get<release::NotInstalled>(missing_build).invalid);
    for (const auto& text : {std::string("{"), Json{{"buildId", std::string(64, 'b')}}.dump(),
                             std::string(65537, 'x'), std::string(R"({"buildId":1})")}) {
      release::WriteText(runtime / L"build.json", text);
      auto bad_build = release::Take(ReadCurrent(root));
      Check(std::holds_alternative<release::NotInstalled>(bad_build) &&
            std::get<release::NotInstalled>(bad_build).invalid);
    }
    Write(runtime / L"build.json", {{"buildId", std::string(64, 'a')}});
    {
      Handle build_locked(CreateFileW((runtime / L"build.json").c_str(), GENERIC_READ, 0, nullptr,
                                      OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
      auto unreadable_build = ReadCurrent(root);
      Check(!unreadable_build && unreadable_build.error().code == ErrorCode::kUnavailable &&
            !unreadable_build.error().reason);
    }
    Handle locked(CreateFileW((root / L"current").c_str(), GENERIC_READ, 0, nullptr, OPEN_EXISTING,
                              FILE_ATTRIBUTE_NORMAL, nullptr));
    auto unreadable = ReadCurrent(root);
    Check(!unreadable && unreadable.error().code == ErrorCode::kUnavailable);
    CloseHandle(locked.Release());
    auto descriptor = Json{
        {"buildId", std::string(64, 'a')}, {"sha256", std::string(64, 'b')}, {"size", uint64_t(1)}};
    Check(DecodeNodeRelease(descriptor.dump()) == descriptor);
    for (auto text :
         {descriptor.dump().insert(1, "\"extra\":1,"), descriptor.dump().insert(1, "\"size\":1,"),
          Json{{"buildId", std::string(64, 'a')}, {"size", uint64_t(1)}}.dump()}) {
      try {
        DecodeNodeRelease(text);
        Check(false);
      } catch (const release::Failure&) {
      }
    }
    config["control"] = "ws://127.0.0.1:1/api/node";
    Write(root / L"node.json", config);
    offered_release = descriptor;
    offered_release["buildId"] = std::string(64, 'b');
    Log update_log(root / L"logs/update.log");
    Handle update_stop(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    for (auto code :
         {ErrorCode::kInvalidRequest, ErrorCode::kUnauthenticated, ErrorCode::kForbidden,
          ErrorCode::kLocked, ErrorCode::kNotFound, ErrorCode::kConflict, ErrorCode::kLimitExceeded,
          ErrorCode::kRateLimited, ErrorCode::kBusy, ErrorCode::kUnavailable, ErrorCode::kRejected,
          ErrorCode::kCanceled, ErrorCode::kOutcomeUnknown, ErrorCode::kInternal}) {
      RetryUnit retry("test.updater");
      UpdateStage stage = DiscoverRelease{};
      download_failure = Error{code, "injected download failure"};
      offered_release["buildId"] = std::string(64, 'b');
      download_requests = 0;
      auto first = Update(root, update_stop.value, update_log, false, retry, stage);
      Check(!first && first.error().code == code && download_requests == 1);
      retry.Fail(first.error());
      auto repeated = Update(root, update_stop.value, update_log, false, retry, stage);
      Check(!repeated && repeated.error().code == code && download_requests == 1);
      offered_release["buildId"] = std::string(64, 'c');
      auto changed = Update(root, update_stop.value, update_log, false, retry, stage);
      Check(!changed && changed.error().code == code && download_requests == 2);
    }
    download_failure.reset();
    {
      RetryUnit retry("test.updater.receive");
      UpdateStage stage = DiscoverRelease{};
      receive_failure = Error{ErrorCode::kInvalidRequest, "duplicate key in cluster JSON"};
      receive_failure->error_id = "e-1234567890";
      auto failed = Update(root, update_stop.value, update_log, false, retry, stage);
      Check(!failed && failed.error().code == ErrorCode::kInvalidRequest &&
            failed.error().error_id == receive_failure->error_id);
      retry.Fail(failed.error());
      Check(retry.Status() == RetryUnit::State::kFaulted);
      const auto requests = download_requests;
      auto repeated = Update(root, update_stop.value, update_log, false, retry, stage);
      Check(!repeated && repeated.error().code == ErrorCode::kInvalidRequest &&
            download_requests == requests);
      offered_release["sha256"] = std::string(64, 'd');
      auto changed = Update(root, update_stop.value, update_log, false, retry, stage);
      Check(!changed && download_requests == requests + 1);
      Check(release::InstalledId(release::Take(ReadCurrent(root))) == std::string(64, 'a'));
      receive_failure.reset();
    }
    auto next_runtime = root / L"runtime" / std::string(64, 'b');
    fs::create_directories(next_runtime / L"bin");
    Write(next_runtime / L"build.json", {{"buildId", std::string(64, 'b')}});
    for (auto required : release::kNodeFiles)
      std::ofstream(next_runtime / required) << "dummy";
    release::WriteText(root / L"one-byte", "x");
    offered_release["buildId"] = std::string(64, 'b');
    offered_release["sha256"] = Hex(Sha256File(root / L"one-byte").value());
    RetryUnit activation("test.activation");
    UpdateStage activation_stage = DiscoverRelease{};
    const auto connections_before_activation = release_connections;
    {
      Handle blocked(CreateFileW((root / L"current.tmp").c_str(), GENERIC_WRITE, 0, nullptr,
                                 CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
      auto failed =
          Update(root, update_stop.value, update_log, false, activation, activation_stage);
      Check(!failed && failed.error().code == ErrorCode::kUnavailable);
      Check(release::InstalledId(release::Take(ReadCurrent(root))) == std::string(64, 'a'));
    }
    atomic_flush_mode = AtomicFlushMode::kFail;
    auto unflushed =
        Update(root, update_stop.value, update_log, false, activation, activation_stage);
    atomic_flush_mode = AtomicFlushMode::kWrite;
    Check(!unflushed && unflushed.error().code == ErrorCode::kUnavailable);
    Check(release::InstalledId(release::Take(ReadCurrent(root))) == std::string(64, 'a'));
    {
      Handle retained(CreateFileW((runtime / L"build.json").c_str(), GENERIC_READ, FILE_SHARE_READ,
                                  nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
      auto activated =
          Update(root, update_stop.value, update_log, false, activation, activation_stage);
      Check(activated && !activated.value());
      Check(release::InstalledId(release::Take(ReadCurrent(root))) == std::string(64, 'b'));
      std::ifstream events(root / L"logs/update.log");
      std::string text((std::istreambuf_iterator<char>(events)), {});
      Check(text.find("runtime.cleanup_failed") != std::string::npos);
    }
    Check(release_connections == connections_before_activation + 1);
    {
      RetryUnit retry("test.updater.install");
      UpdateStage stage = DiscoverRelease{};
      offered_release["buildId"] = std::string(64, 'c');
      extraction = Extraction::kFixture;
      runtime_move = RuntimeMove::kFailOnce;
      const auto connections = release_connections;
      auto failed = Update(root, update_stop.value, update_log, false, retry, stage);
      Check(!failed && failed.error().code == ErrorCode::kUnavailable);
      Check(std::holds_alternative<DownloadedRelease>(stage));
      Check(release::InstalledId(release::Take(ReadCurrent(root))) == std::string(64, 'b'));
      auto installed = Update(root, update_stop.value, update_log, false, retry, stage);
      Check(installed && !installed.value() && release_connections == connections + 1);
      Check(release::InstalledId(release::Take(ReadCurrent(root))) == std::string(64, 'c'));
      extraction = Extraction::kArchive;
    }
    {
      const auto faulted_root = root / L"faulted-supervisor";
      fs::create_directories(faulted_root);
      Write(faulted_root / L"node.json", config);
      Handle stop(CreateEventW(nullptr, TRUE, FALSE, nullptr));
      Check(TestSupervise(faulted_root, stop.value, false) == 0);
      Check(supervised_updates == 1 && supervised_delays == 20);
      Check(!fs::exists(faulted_root / L"current"));
    }
    {
      const auto retry_root = root / L"retry-supervisor";
      const auto runtime = retry_root / L"runtime" / std::string(64, 'a');
      fs::create_directories(runtime / L"bin");
      for (auto required : release::kNodeFiles)
        release::WriteText(runtime / required, "fixture");
      release::WriteText(retry_root / L"current", std::string(64, 'a'));
      Write(retry_root / L"node.json", config);
      supervised_updates = 0;
      supervised_delays = 0;
      supervisor_fixture = SupervisorFixture::kInstallRetry;
      Handle stop(CreateEventW(nullptr, TRUE, FALSE, nullptr));
      Check(TestSupervise(retry_root, stop.value, false) == 0);
      Check(supervised_updates == 2 && supervised_delays == 0);
    }
    {
      const auto changed_root = root / L"new-build-supervisor";
      fs::create_directories(changed_root);
      Write(changed_root / L"node.json", config);
      supervised_updates = 0;
      supervised_delays = 0;
      supervisor_fixture = SupervisorFixture::kNewBuild;
      Handle stop(CreateEventW(nullptr, TRUE, FALSE, nullptr));
      Check(TestSupervise(changed_root, stop.value, false) == 0);
      Check(supervised_updates == 2 && supervised_delays == 10);
    }
    Log broken_log(root / L"logs/broken");
    fs::create_directory(root / L"logs/broken");
    {
      ChildProcess flood(ExecutablePath(), L"--flood", root, broken_log, true);
      Check(WaitForSingleObject(flood.handle(), 10000) == WAIT_OBJECT_0);
      Check(flood.ExitCode() == 0);
    }
    fs::create_directories(root / L"runtime/obsolete");
    std::ofstream(root / L"runtime/obsolete/locked") << "locked";
    Handle cleanup_lock(CreateFileW((root / L"runtime/obsolete/locked").c_str(), GENERIC_READ,
                                    FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL,
                                    nullptr));
    Log cleanup_log(root / L"logs/cleanup.log");
    CleanupRuntimeBestEffort(root, std::string(64, 'a'), cleanup_log);
    Check(fs::exists(root / L"runtime/obsolete/locked"));
    std::ifstream cleanup_events(root / L"logs/cleanup.log");
    std::string cleanup_text((std::istreambuf_iterator<char>(cleanup_events)), {});
    Check(cleanup_text.find("runtime.cleanup_failed") != std::string::npos);
    cleanup_events.close();
    CloseHandle(cleanup_lock.Release());
    std::ofstream(root / L"bad-log-root") << "blocks logs directory";
    {
      SnapshotSupervisor snapshots(root / L"missing.exe", root / L"bad-log-root", "node-1");
      Sleep(100);
    }
    config["control"] = "ws://127.0.0.1:1/api/node";
    Write(root / L"node.json", config);
    release::WriteText(root / L"current", std::string(64, 'a'));
    fs::create_directories(root / L"runtime/preserve");
    Handle blocked_current(CreateFileW((root / L"current").c_str(), GENERIC_READ, 0, nullptr,
                                       OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    Handle stop(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    std::jthread supervisor([&] { Supervise(root, stop.value, false); });
    Sleep(200);
    SetEvent(stop.value);
    supervisor.join();
    Check(fs::exists(root / L"runtime/preserve"));
    Check(!fs::exists(root / L"logs/endpoint.log"));
    std::ifstream current_events(root / L"logs/supervisor.log");
    std::string current_text((std::istreambuf_iterator<char>(current_events)), {});
    Check(current_text.find("supervisor.current_failed") != std::string::npos);
    current_events.close();
    CloseHandle(blocked_current.Release());

    Log log(root / L"logs/test.log");
    Bytes bytes(16 * 1024 * 1024);
    for (uint8_t marker = 0; marker < 6; ++marker) {
      std::fill(bytes.begin(), bytes.end(), marker);
      log.Write(bytes);
    }
    log.Write(Bytes{99});
    Check(fs::file_size(root / L"logs/test.log") == 1);
    for (int i = 1; i <= 4; ++i) {
      auto path = root / L"logs" / (L"test.log." + std::to_wstring(i));
      Check(fs::file_size(path) == 16 * 1024 * 1024);
      std::ifstream file(path, std::ios::binary);
      Check(file.get() == 6 - i);
    }
    Check(!fs::exists(root / L"logs/test.log.5"));
    fs::remove_all(root);
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    std::error_code ec;
    fs::remove_all(root, ec);
    return 1;
  }
}
