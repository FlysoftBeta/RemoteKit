#include "supervisor.hpp"
#include "release/options.hpp"
#include "release/payload.hpp"
#include "release/http.hpp"
#include "updater/service.hpp"
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
constexpr char kUsage[] =
    "remotekit_control init --root=<dir> --manifest=<url> --key-file=<file>\n"
    "remotekit_control install --root=<dir> --payload=<payload.tar>\n"
    "remotekit_control run --root=<dir>\n"
    "remotekit_control service --root=<dir>\n"
    "remotekit_control service-install --root=<dir>\n"
    "remotekit_control service-uninstall\n";
}  // namespace
int wmain(int argc, wchar_t** argv) {
  using namespace remotekit;
  using namespace release;
  try {
    if (argc < 2 || std::wstring_view(argv[1]) == L"--help") {
      std::cout << kUsage;
      return argc < 2 ? 1 : 0;
    }
    std::wstring command = argv[1];
    const updater::Service service{L"RemoteKitControl", L"RemoteKit Control",
                                   L"remotekit_control.exe", manager::Supervise};
    if (command == L"service-uninstall") {
      Options options(argc, argv, {});
      Take(updater::UninstallService(service));
      return 0;
    }
    if (command == L"init") {
      Options options(argc, argv, {L"root", L"manifest", L"key-file"});
      auto root = options.Path(L"root");
      auto manifest = options.Text(L"manifest");
      Require(ValidUrl(manifest), "invalid manager manifest URL");
      auto key = LoadKey(options.Path(L"key-file"));
      fs::create_directories(root / L"config");
      AtomicText(root / L"config/manager.json", Json{{"manifest", manifest}}.dump());
      AtomicText(root / L"config/release.key", EncodeKey(key));
      SecureZeroMemory(key.data(), key.size());
      auto target = root / L"remotekit_control.exe";
      auto running = updater::ExecutablePath();
      if (!fs::exists(target) || !fs::equivalent(target, running))
        fs::copy_file(running, target, fs::copy_options::overwrite_existing);
      return 0;
    }
    if (command == L"install") {
      Options options(argc, argv, {L"root", L"payload"});
      auto root = options.Path(L"root");
      auto lock = manager::Lock(root);
      auto payload = options.Path(L"payload");
      auto id = PayloadBuildId(payload);
      InstallPayload(root, payload, id, PayloadSource::kCopy);
      AtomicText(root / L"current", id);
      manager::Cleanup(root, id);
      return 0;
    }
    Options options(argc, argv, {L"root"});
    auto root = options.Path(L"root");
    if (command == L"service-install") {
      Take(updater::InstallService(root, service));
      return 0;
    }
    if (command == L"service")
      return updater::RunService(root, service);
    Require(command == L"run", "unknown manager command");
    updater::Handle stop(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    Io(stop.value != nullptr, "cannot create manager stop event");
    stop_event = stop.value;
    SetConsoleCtrlHandler(Stop, TRUE);
    int code = manager::Supervise(root, stop.value, false);
    SetConsoleCtrlHandler(Stop, FALSE);
    stop_event = nullptr;
    return code;
  } catch (const Failure& failure) {
    LogError(LogLevel::kError, "manager.failed", failure.error);
  } catch (const std::exception&) {
    LogEvent(LogLevel::kError, "manager.filesystem_failed");
  }
  return 1;
}
