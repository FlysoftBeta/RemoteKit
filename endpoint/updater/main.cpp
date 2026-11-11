#include "download.hpp"
#include "service.hpp"
#include "supervisor.hpp"
#include <iostream>
namespace {
HANDLE stop_event = nullptr;
BOOL WINAPI Stop(DWORD code) {
  if (code == CTRL_C_EVENT || code == CTRL_BREAK_EVENT || code == CTRL_CLOSE_EVENT ||
      code == CTRL_SHUTDOWN_EVENT) {
    if (stop_event)
      SetEvent(stop_event);
    return TRUE;
  }
  return FALSE;
}
}  // namespace
int wmain(int argc, wchar_t** argv) {
  using namespace remotekit::updater;
  try {
    const Service service{L"RemoteKitNode", L"RemoteKit Node", L"remotekit_node.exe", Supervise};
    if (argc < 2)
      throw std::runtime_error(
          "expected run, install, service, service-install or service-uninstall");
    std::wstring command = argv[1];
    if (command == L"service-uninstall" && argc == 2) {
      auto result = UninstallService(service);
      if (!result)
        throw std::runtime_error(result.error().message);
      return 0;
    }
    if (argc < 3 || !std::wstring_view(argv[2]).starts_with(L"--root=") || !argv[2][7])
      throw std::runtime_error("expected --root=<directory>");
    auto root = fs::absolute(fs::path(argv[2] + 7)).lexically_normal();
    if (command == L"install") {
      if (argc != 4 || !std::wstring_view(argv[3]).starts_with(L"--package=") || !argv[3][10])
        throw std::runtime_error("expected --package=<Control package directory>");
      auto result = InstallBundled(root, fs::absolute(fs::path(argv[3] + 10)));
      if (!result)
        throw std::runtime_error(result.error().message);
      return 0;
    }
    if (argc != 3)
      throw std::runtime_error("unexpected node command arguments");
    if (command == L"service-install") {
      auto result = InstallService(root, service);
      if (!result)
        throw std::runtime_error(result.error().message);
      return 0;
    }
    if (command == L"service")
      return RunService(root, service);
    if (command != L"run")
      throw std::runtime_error("unknown node command");
    Handle stop(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    if (!stop.value)
      throw std::runtime_error("cannot create stop event");
    stop_event = stop.value;
    SetConsoleCtrlHandler(Stop, TRUE);
    int code = Supervise(root, stop.value, false);
    SetConsoleCtrlHandler(Stop, FALSE);
    stop_event = nullptr;
    return code;
  } catch (const std::exception& error) {
    remotekit::LogError(remotekit::LogLevel::kError, "supervisor.failed",
                        remotekit::Error{remotekit::ErrorCode::kInternal, error.what()});
    return 1;
  }
}
