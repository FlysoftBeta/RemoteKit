#include "supervisor.hpp"
#include "download.hpp"
#include "process.hpp"
#include "replacement.hpp"
#include "snapshot.hpp"
#include "util/retry_unit.hpp"
#include <thread>

namespace remotekit::updater {
namespace {
struct Replaced {};
using EndpointResult = std::variant<DWORD, Replaced>;
EndpointResult RunEndpoint(const fs::path& root,
                           const std::string& id,
                           HANDLE stop,
                           Log& log,
                           Log& endpoint_log,
                           bool service,
                           RetryUnit& replacement_retry) {
  auto executable = root / L"runtime" / id / L"bin/endpoint_service.exe";
  auto config = cluster::LoadNodeFiles(root);
  if (!config)
    throw std::runtime_error("cannot load snapshot node identity");
  SnapshotSupervisor snapshots(executable.parent_path() / L"remotekit_snapshot.exe", root,
                               config.value().node_id);
  ChildProcess child(executable, L"--node-root=" + Quote(root.wstring()), root, endpoint_log,
                     false);
  log.Event(LogLevel::kInfo, "endpoint.started");
  HANDLE waits[] = {stop, child.handle()};
  DWORD result = WAIT_TIMEOUT;
  while ((result = WaitForMultipleObjects(2, waits, FALSE, 1000)) == WAIT_TIMEOUT) {
    if (!replacement_retry.Ready())
      continue;
    auto replaced = ReplaceExecutable(root / L"remotekit_node.exe",
                                      executable.parent_path() / L"remotekit_node.exe", root,
                                      L"run --root=" + Quote(root.wstring()), service, log);
    if (!replaced)
      replacement_retry.Fail(replaced.error());
    else {
      replacement_retry.Success();
      if (replaced.value()) {
        child.Stop(30000);
        return Replaced{};
      }
    }
  }
  if (result == WAIT_OBJECT_0 || result == WAIT_FAILED)
    child.Stop(30000);
  DWORD code = child.ExitCode();
  log.Event(LogLevel::kWarn, "endpoint.exited", {{"exitCode", code}});
  return code;
}
}  // namespace
int Supervise(const fs::path& root, HANDLE stop, bool service) {
  fs::create_directories(root);
  std::error_code ec;
  fs::remove(root / L"remotekit_node.exe.old", ec);
  fs::remove(root / L"remotekit_node.exe.new", ec);
  Log log(root / L"logs/supervisor.log"), endpoint_log(root / L"logs/endpoint.log");
  auto config = cluster::LoadNodeFiles(root);
  if (!config) {
    log.Event(LogLevel::kError, "supervisor.config_failed", LogErrorFields(config.error()));
    return 1;
  }
  enum class Phase { kStartup, kRun, kUpdate };
  Phase phase = Phase::kStartup;
  RetryUnit update_retry("updater"), process_retry("endpoint"),
      replacement_retry("updater.replacement");
  update_retry.Input(config.value().node_id);
  UpdateStage update_stage = DiscoverRelease{};
  std::optional<std::string> observed_current;
  std::optional<std::string> reported_invalid;
  while (!Stopping(stop)) {
    auto current = ReadCurrent(root);
    if (!current) {
      log.Event(LogLevel::kError, "supervisor.current_failed", LogErrorFields(current.error()));
      if (Delay(stop, 1000))
        break;
      continue;
    }
    const auto* missing = std::get_if<release::NotInstalled>(&current.value());
    const auto invalid = missing ? missing->invalid : std::nullopt;
    if (invalid && !reported_invalid) {
      log.Event(LogLevel::kWarn, "current.invalid", {{"message", *invalid}});
      update_retry.Input(config.value().node_id + ":" + *invalid);
      phase = Phase::kStartup;
    }
    reported_invalid = invalid;
    auto id = release::InstalledId(current.value());
    if (observed_current && *observed_current != id) {
      update_retry.Input(id.empty() ? config.value().node_id : id);
    }
    observed_current = id;
    if (phase == Phase::kStartup) {
      CleanupRuntimeBestEffort(root, id, log);
      update_stage = DiscoverRelease{};
      phase = Phase::kRun;
    }
    replacement_retry.Input(id);
    if (!id.empty() && replacement_retry.Ready()) {
      auto replaced = ReplaceExecutable(root / L"remotekit_node.exe",
                                        root / L"runtime" / id / L"bin/remotekit_node.exe", root,
                                        L"run --root=" + Quote(root.wstring()), service, log);
      if (!replaced)
        replacement_retry.Fail(replaced.error());
      else {
        replacement_retry.Success();
        if (replaced.value())
          return service ? 1 : 0;
      }
    }
    if (id.empty())
      phase = Phase::kUpdate;
    if (phase == Phase::kUpdate) {
      if (!update_retry.Ready()) {
        if (Delay(stop, update_retry.Status() == RetryUnit::State::kWaiting ? 100 : 1000))
          break;
        continue;
      }
      auto result = Update(root, stop, log, service, update_retry, update_stage);
      if (!result) {
        const auto previous_status = update_retry.Status();
        update_retry.Fail(result.error());
        if (previous_status == RetryUnit::State::kIdle)
          log.Event(LogLevel::kError, "supervisor.update_failed", LogErrorFields(result.error()));
        continue;
      }
      update_retry.Success();
      if (result.value())
        return service ? 1 : 0;
      phase = Phase::kRun;
      continue;
    }
    process_retry.Input(id);
    if (!process_retry.Ready()) {
      if (Delay(stop, 100))
        break;
      continue;
    }
    const auto started = GetTickCount64();
    DWORD code = 1;
    try {
      auto result = RunEndpoint(root, id, stop, log, endpoint_log, service, replacement_retry);
      if (std::holds_alternative<Replaced>(result))
        return service ? 1 : 0;
      code = std::get<DWORD>(result);
    } catch (const std::exception& error) {
      process_retry.Fail({ErrorCode::kUnavailable, error.what()});
      continue;
    }
    if (Stopping(stop))
      break;
    if (GetTickCount64() - started >= 60000)
      process_retry.Success();
    if (code == 3) {
      phase = Phase::kUpdate;
      continue;
    }
    if (code == 4)
      continue;
    process_retry.Fail({ErrorCode::kUnavailable, "endpoint process exited"});
  }
  log.Event(LogLevel::kInfo, "supervisor.stopped");
  return 0;
}
}  // namespace remotekit::updater
