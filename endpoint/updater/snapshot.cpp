#include "snapshot.hpp"
namespace remotekit::updater {
SnapshotSupervisor::SnapshotSupervisor(fs::path executable, fs::path root, std::string node) {
  stop_.value = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!stop_.value)
    throw std::runtime_error("cannot create snapshot supervisor stop event");
  worker_ = std::thread([this, executable, root, node] {
    Log log(root / L"logs/snapshot.log");
    unsigned backoff = 1;
    while (!Stopping(stop_.value)) {
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
      } catch (const std::exception& error) {
        log.Event(LogLevel::kWarn, "snapshot.start_failed", {{"message", error.what()}});
      }
      if (GetTickCount64() - started >= 60000)
        backoff = 1;
      if (Delay(stop_.value, backoff * 1000))
        break;
      backoff = std::min(30u, backoff * 2);
    }
  });
}
SnapshotSupervisor::~SnapshotSupervisor() {
  SetEvent(stop_.value);
  worker_.join();
}
}  // namespace remotekit::updater
