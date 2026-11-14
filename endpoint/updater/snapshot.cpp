#include "snapshot.hpp"
#include "util/retry_unit.hpp"
#include <cstdio>
namespace remotekit::updater {
SnapshotSupervisor::SnapshotSupervisor(fs::path executable, fs::path root, std::string node) {
  stop_.value = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!stop_.value)
    throw std::runtime_error("cannot create snapshot supervisor stop event");
  worker_ = std::thread([this, executable, root, node] {
    try {
      Log log(root / L"logs/snapshot.log");
      RetryUnit retry("snapshot");
      retry.Input(node);
      while (!Stopping(stop_.value)) {
        if (!retry.Ready()) {
          if (Delay(stop_.value, 100))
            break;
          continue;
        }
        const auto started = GetTickCount64();
        try {
          auto arguments = L"--data-root=" + Quote((root / L"data").wstring()) + L" --node-id=" +
                           Quote(fs::path(node).wstring()) + L" --supervisor-pid=" +
                           std::to_wstring(GetCurrentProcessId());
          ChildProcess child(executable, arguments, root, log, true);
          log.Event(LogLevel::kInfo, "snapshot.started");
          HANDLE waits[] = {stop_.value, child.handle()};
          WaitForMultipleObjects(2, waits, FALSE, INFINITE);
          child.Stop(0);
          log.Event(LogLevel::kWarn, "snapshot.exited", {{"exitCode", child.ExitCode()}});
          if (Stopping(stop_.value))
            break;
          if (GetTickCount64() - started >= 60000)
            retry.Success();
          retry.Fail({ErrorCode::kUnavailable, "snapshot process exited"});
        } catch (const std::exception& error) {
          retry.Fail({ErrorCode::kUnavailable, error.what()});
        }
      }
    } catch (const std::exception& error) {
      try {
        Log log(root / L"logs/snapshot.log");
        log.Event(LogLevel::kError, "snapshot.supervisor_failed",
                  {{"nodeId", node}, {"message", error.what()}});
      } catch (...) {
        fprintf(stderr, "snapshot supervisor failed for %s: %s\n", node.c_str(), error.what());
      }
    } catch (...) {
      fputs("snapshot supervisor failed\n", stderr);
    }
  });
}
SnapshotSupervisor::~SnapshotSupervisor() {
  SetEvent(stop_.value);
  worker_.join();
}
}  // namespace remotekit::updater
