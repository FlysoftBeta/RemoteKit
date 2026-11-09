#include "supervisor.hpp"
#include "download.hpp"
#include "process.hpp"
#include "replacement.hpp"
#include "util/error_policy.hpp"
#include <thread>

namespace remotekit::updater {
namespace {
DWORD RunEndpoint(const fs::path& root,
                  const std::string& id,
                  HANDLE stop,
                  Log& log,
                  Log& endpoint_log) {
  auto executable = root / L"runtime" / id / L"bin/endpoint_service.exe";
  ChildProcess child(executable, L"--node-root=" + Quote(root.wstring()), root, endpoint_log,
                     false);
  log.Line("started endpoint");
  HANDLE waits[] = {stop, child.handle()};
  DWORD result = WaitForMultipleObjects(2, waits, FALSE, INFINITE);
  if (result == WAIT_OBJECT_0 || result == WAIT_FAILED)
    child.Stop(30000);
  DWORD code = child.ExitCode();
  log.Line("endpoint exit " + std::to_string(code));
  return code;
}
}  // namespace
int Supervise(const fs::path& root, HANDLE stop, bool service) {
  fs::create_directories(root);
  std::error_code ec;
  fs::remove(root / L"remotekit_node.exe.old", ec);
  Log log(root / L"logs/supervisor.log"), endpoint_log(root / L"logs/endpoint.log");
  auto config = cluster::LoadNodeFiles(root);
  if (!config) {
    log.Line(config.error().message);
    return 1;
  }
  CleanupRuntime(root, ReadCurrent(root), true);
  unsigned backoff = 1;
  unsigned update_attempt = 0;
  bool update = ReadCurrent(root).empty();
  while (!Stopping(stop)) {
    if (update) {
      auto result = Update(root, stop, log, service);
      if (!result) {
        log.Line(result.error().message);
        const auto delay = result.error().code == ErrorCode::kUnavailable ||
                                   result.error().code == ErrorCode::kBusy
                               ? RetryDelay(result.error(), update_attempt++)
                               : std::nullopt;
        if (!delay) {
          if (result.error().code != ErrorCode::kRejected &&
              result.error().code != ErrorCode::kInternal)
            return 1;
        }
        if (Delay(stop, delay ? static_cast<DWORD>(delay->count()) : 30000))
          break;
        continue;
      }
      if (result.value())
        return service ? 1 : 0;
      update_attempt = 0;
      update = false;
    }
    auto id = ReadCurrent(root);
    if (id.empty()) {
      update = true;
      continue;
    }
    auto started = GetTickCount64();
    DWORD code = 1;
    try {
      code = RunEndpoint(root, id, stop, log, endpoint_log);
    } catch (const std::exception& error) {
      log.Line(error.what());
    }
    if (Stopping(stop))
      break;
    if (GetTickCount64() - started >= 60000)
      backoff = 1;
    if (code == 3) {
      update = true;
      continue;
    }
    if (code == 4)
      continue;
    log.Line("restart delay " + std::to_string(backoff) + " s");
    if (Delay(stop, backoff * 1000))
      break;
    backoff = std::min(backoff * 2, 30u);
  }
  log.Line("supervisor stopped");
  return 0;
}
}  // namespace remotekit::updater
