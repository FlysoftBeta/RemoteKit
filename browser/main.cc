#include <windows.h>
#include "base/command_line.h"
#include "base/process/process_handle.h"
#include "base/win/win_util.h"
#include "components/crash/core/app/run_as_crashpad_handler_win.h"
#include "content/public/app/content_main.h"
#include "content/public/app/sandbox_helper_win.h"
#include "remotekit/browser/main_delegate.h"
#include "sandbox/win/src/sandbox_types.h"

namespace {
DWORD WINAPI WaitForBrowserExit(void* context) {
  const auto browser = static_cast<HANDLE>(context);
  if (WaitForSingleObject(browser, INFINITE) == WAIT_OBJECT_0) {
    // Crashpad finishes writing a browser dump before terminating its client.
    // A lingering renderer must not keep the handler alive after that exit.
    CloseHandle(browser);
    ExitProcess(0);
  }
  CloseHandle(browser);
  return 0;
}
}  // namespace

int APIENTRY wWinMain(HINSTANCE instance, HINSTANCE, wchar_t*, int) {
  base::win::PinUser32();
  base::CommandLine::Init(0, nullptr);
  const auto& command = *base::CommandLine::ForCurrentProcess();
  if (command.GetSwitchValueASCII("type") == "crashpad-handler") {
    HANDLE browser = OpenProcess(SYNCHRONIZE, FALSE, base::GetParentProcessId(GetCurrentProcess()));
    if (!browser)
      return 1;
    HANDLE watcher = CreateThread(nullptr, 0, WaitForBrowserExit, browser, 0, nullptr);
    if (!watcher) {
      CloseHandle(browser);
      return 1;
    }
    CloseHandle(watcher);
    return crash_reporter::RunAsCrashpadHandler(command, {}, "type", "user-data-dir");
  }
  sandbox::SandboxInterfaceInfo sandbox_info = {};
  content::InitializeSandboxInfo(&sandbox_info);
  remotekit::browser::MainDelegate delegate;
  content::ContentMainParams params(&delegate);
  params.instance = instance;
  params.sandbox_info = &sandbox_info;
  return content::ContentMain(std::move(params));
}
