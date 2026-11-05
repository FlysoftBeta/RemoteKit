#include <windows.h>
#include "base/command_line.h"
#include "base/win/win_util.h"
#include "content/public/app/content_main.h"
#include "content/public/app/sandbox_helper_win.h"
#include "remotekit/browser/main_delegate.h"
#include "sandbox/win/src/sandbox_types.h"

int APIENTRY wWinMain(HINSTANCE instance, HINSTANCE, wchar_t*, int) {
  base::win::PinUser32();
  base::CommandLine::Init(0, nullptr);
  sandbox::SandboxInterfaceInfo sandbox_info = {};
  content::InitializeSandboxInfo(&sandbox_info);
  remotekit::browser::MainDelegate delegate;
  content::ContentMainParams params(&delegate);
  params.instance = instance;
  params.sandbox_info = &sandbox_info;
  return content::ContentMain(std::move(params));
}
