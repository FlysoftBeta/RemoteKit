// Demo launcher and native window host only; this is not an IPC control plane.
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
// clang-format off
#include <windows.h>
#include <shellapi.h>
// clang-format on

#include <algorithm>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <string>
#include <vector>
#include "remotekit/atlas_client.hpp"

namespace {

struct Options {
  std::wstring browser;
  std::wstring data_path;
  std::wstring urls;
  std::wstring sessions;
  std::wstring presentation = L"fence";
};

struct App {
  HANDLE job = nullptr;
  HANDLE process = nullptr;
  HWND last_child = nullptr;
  bool gpu = false;
  bool reported_error = false;
  std::string channel;
  std::unique_ptr<remotekit::AtlasClient> atlas;
  ~App() {
    atlas.reset();
    if (process)
      CloseHandle(process);
    if (job)
      CloseHandle(job);
  }
};

bool IsAbsolutePath(const std::wstring& path) {
  if (path.size() >= 3 &&
      ((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')) &&
      path[1] == L':' && (path[2] == L'\\' || path[2] == L'/'))
    return true;
  if (path.size() < 5 || path[0] != L'\\' || path[1] != L'\\')
    return false;
  const size_t slash = path.find_first_of(L"\\/", 2);
  return slash != std::wstring::npos && slash > 2 && slash + 1 < path.size();
}

bool ParseArgs(Options& options) {
  int argc = 0;
  LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (!argv)
    return false;
  bool browser_seen = false, data_seen = false, urls_seen = false, sessions_seen = false;
  bool presentation_seen = false;
  bool valid = true;
  for (int i = 1; i < argc && valid; ++i) {
    std::wstring arg(argv[i]);
    auto set = [&](const wchar_t* prefix, std::wstring& target, bool& seen) {
      const std::wstring key(prefix);
      if (arg.rfind(key, 0) != 0)
        return false;
      if (seen || arg.size() == key.size())
        valid = false;
      else {
        seen = true;
        target = arg.substr(key.size());
      }
      return true;
    };
    if (!set(L"--browser=", options.browser, browser_seen) &&
        !set(L"--data-path=", options.data_path, data_seen) &&
        !set(L"--urls=", options.urls, urls_seen) &&
        !set(L"--sessions=", options.sessions, sessions_seen) &&
        !set(L"--presentation=", options.presentation, presentation_seen))
      valid = false;
  }
  LocalFree(argv);
  if (!valid || !browser_seen || !IsAbsolutePath(options.browser) ||
      (data_seen && !IsAbsolutePath(options.data_path)))
    return false;
  if (options.presentation != L"native" && options.presentation != L"fence")
    return false;
  DWORD attrs = GetFileAttributesW(options.browser.c_str());
  if (attrs == INVALID_FILE_ATTRIBUTES || (attrs & FILE_ATTRIBUTE_DIRECTORY))
    return false;
  if (options.browser.size() < 4 ||
      _wcsicmp(options.browser.c_str() + options.browser.size() - 4, L".exe") != 0)
    return false;
  if (data_seen) {
    attrs = GetFileAttributesW(options.data_path.c_str());
    if (attrs != INVALID_FILE_ATTRIBUTES && !(attrs & FILE_ATTRIBUTE_DIRECTORY))
      return false;
  }
  if (urls_seen && (options.urls.front() == L'|' || options.urls.back() == L'|' ||
                    options.urls.find(L"||") != std::wstring::npos))
    return false;
  if (sessions_seen) {
    unsigned int count = 0;
    for (wchar_t c : options.sessions) {
      if (c < L'0' || c > L'9' || count > 8)
        return false;
      count = count * 10 + static_cast<unsigned int>(c - L'0');
    }
    if (count < 1 || count > 8)
      return false;
  }
  return true;
}

// Quote one argument according to the Windows CRT command-line parsing rules.
std::wstring Quote(const std::wstring& value) {
  std::wstring result = L"\"";
  size_t backslashes = 0;
  for (wchar_t c : value) {
    if (c == L'\\') {
      ++backslashes;
      continue;
    }
    if (c == L'"') {
      result.append(backslashes * 2 + 1, L'\\');
      result += c;
    } else {
      result.append(backslashes, L'\\');
      result += c;
    }
    backslashes = 0;
  }
  result.append(backslashes * 2, L'\\');
  result += L'"';
  return result;
}

BOOL CALLBACK ResizeChild(HWND child, LPARAM param) {
  HWND parent = reinterpret_cast<HWND>(param);
  if (GetParent(child) == parent) {
    RECT bounds{};
    GetClientRect(parent, &bounds);
    MoveWindow(child, 0, 0, bounds.right, bounds.bottom, TRUE);
  }
  return TRUE;
}
BOOL CALLBACK CloseChild(HWND child, LPARAM param) {
  if (GetParent(child) == reinterpret_cast<HWND>(param))
    PostMessageW(child, WM_CLOSE, 0, 0);
  return TRUE;
}

LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
  if (message == WM_NCCREATE) {
    const auto* create = reinterpret_cast<CREATESTRUCTW*>(lparam);
    SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(create->lpCreateParams));
  }
  auto* app = reinterpret_cast<App*>(GetWindowLongPtrW(window, GWLP_USERDATA));
  if (app && app->atlas) {
    if (auto handled = app->atlas->HandleMessage(message, wparam, lparam))
      return *handled;
  }
  switch (message) {
    case WM_SIZE:
      if (app && app->atlas) {
        app->atlas->SetOutputEnabled(wparam != SIZE_MINIMIZED);
        app->atlas->Resize();
      }
      EnumChildWindows(window, ResizeChild, reinterpret_cast<LPARAM>(window));
      return 0;
    case WM_DPICHANGED: {
      const auto* suggested = reinterpret_cast<const RECT*>(lparam);
      SetWindowPos(window, nullptr, suggested->left, suggested->top,
                   suggested->right - suggested->left, suggested->bottom - suggested->top,
                   SWP_NOZORDER | SWP_NOACTIVATE);
      // This process and the embedded browser are both PMv2-aware. Child
      // bounds are physical client pixels; do not apply the DPI scale again.
      EnumChildWindows(window, ResizeChild, reinterpret_cast<LPARAM>(window));
      return 0;
    }
    case WM_SETFOCUS: {
      if (app && app->gpu)
        return 0;
      HWND child = GetWindow(window, GW_CHILD);
      if (child) {
        DWORD child_thread = GetWindowThreadProcessId(child, nullptr);
        DWORD current_thread = GetCurrentThreadId();
        bool attached =
            child_thread != current_thread && AttachThreadInput(current_thread, child_thread, TRUE);
        SetFocus(child);
        if (attached)
          AttachThreadInput(current_thread, child_thread, FALSE);
      }
      return 0;
    }
    case WM_TIMER:
      if (app && app->atlas) {
        app->atlas->Poll();
        if (!app->reported_error && !app->atlas->error().empty()) {
          app->reported_error = true;
          SetWindowTextW(window, (L"RemoteKit Endpoint — " + app->atlas->error()).c_str());
          OutputDebugStringW(app->atlas->error().c_str());
        } else if (app->reported_error && app->atlas->error().empty()) {
          app->reported_error = false;
          SetWindowTextW(window, L"RemoteKit Endpoint — Fence");
        }
      }
      if (app && GetWindow(window, GW_CHILD) != app->last_child) {
        app->last_child = GetWindow(window, GW_CHILD);
        EnumChildWindows(window, ResizeChild, reinterpret_cast<LPARAM>(window));
      }
      if (app && app->process && WaitForSingleObject(app->process, 0) == WAIT_OBJECT_0)
        DestroyWindow(window);
      return 0;
    case WM_CLOSE:
      EnumChildWindows(window, CloseChild, reinterpret_cast<LPARAM>(window));
      DestroyWindow(window);
      return 0;
    case WM_DESTROY:
      KillTimer(window, 1);
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(window, message, wparam, lparam);
}

bool StartBrowser(HWND window, const Options& options, App& app) {
  // Native child presentation has no OSR output. The service owns the supported
  // OffscreenHost initialization; this demo does not create that object graph.
  if (app.gpu)
    return false;
  app.job = CreateJobObjectW(nullptr, nullptr);
  if (!app.job)
    return false;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(app.job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
    return false;
  std::wstring command = Quote(options.browser);
  auto append = [&](const std::wstring& arg) { command += L" " + Quote(arg); };
  append(L"--parent-window=" + std::to_wstring(reinterpret_cast<uintptr_t>(window)));
  append(L"--remote-debugging-port=0");
  if (!options.data_path.empty())
    append(L"--data-path=" + options.data_path);
  if (!options.urls.empty())
    append(L"--urls=" + options.urls);
  if (!options.sessions.empty())
    append(L"--sessions=" + options.sessions);
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(options.browser.c_str(), command.data(), nullptr, nullptr, FALSE,
                      CREATE_SUSPENDED, nullptr, nullptr, &startup, &process))
    return false;
  if (!AssignProcessToJobObject(app.job, process.hProcess)) {
    TerminateProcess(process.hProcess, 1);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return false;
  }
  if (ResumeThread(process.hThread) == static_cast<DWORD>(-1)) {
    TerminateProcess(process.hProcess, 1);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return false;
  }
  CloseHandle(process.hThread);
  app.process = process.hProcess;
  return true;
}

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int show) {
  // The manifest sets PMv2 before process entry. Keep this explicit for hosts
  // that launch a build without its manifest, before any HWND is created.
  if (!SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) &&
      !AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(),
                                    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) {
    OutputDebugStringW(L"RemoteKit endpoint requires Per-Monitor V2 DPI awareness.\n");
    return 1;
  }
  Options options;
  if (!ParseArgs(options)) {
    MessageBoxW(nullptr,
                L"Invalid arguments. Required: --browser=<absolute exe path>. Optional: "
                L"--data-path=<absolute directory>, --urls=<URL1|URL2>, --sessions=<1-8>, "
                L"--presentation=<fence|native>.",
                L"Endpoint client", MB_OK | MB_ICONERROR);
    return 1;
  }
  App app;
  app.gpu = options.presentation == L"fence";
  if (app.gpu) {
    constexpr wchar_t message[] =
        L"Fence presentation is unsupported by the native demo. "
        L"The OSR renderer requires the Endpoint service OffscreenHost. "
        L"Use the streaming runtime, or explicitly select --presentation=native.";
    OutputDebugStringW(message);
    MessageBoxW(nullptr, message, L"Endpoint client — unsupported presentation", MB_OK | MB_ICONERROR);
    return 2;
  }
  app.channel =
      "RemoteKit-" + std::to_string(GetCurrentProcessId()) + "-" + std::to_string(GetTickCount64());
  WNDCLASSW wc{};
  wc.lpfnWndProc = WindowProc;
  wc.hInstance = instance;
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.lpszClassName = L"RemoteKitEndpointClient";
  if (!RegisterClassW(&wc)) {
    MessageBoxW(nullptr, L"Could not register the window class.", L"Endpoint client",
                MB_OK | MB_ICONERROR);
    return 1;
  }
  const UINT initial_dpi = GetDpiForSystem();
  RECT bounds{0, 0, MulDiv(1200, initial_dpi, 96), MulDiv(850, initial_dpi, 96)};
  if (!AdjustWindowRectExForDpi(&bounds, WS_OVERLAPPEDWINDOW, FALSE, 0, initial_dpi)) {
    MessageBoxW(nullptr, L"Could not size the window.", L"Endpoint client", MB_OK | MB_ICONERROR);
    return 1;
  }
  HWND window = CreateWindowExW(
      0, wc.lpszClassName, app.gpu ? L"RemoteKit Endpoint — Fence" : L"RemoteKit Endpoint — Native",
      WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT, bounds.right - bounds.left,
      bounds.bottom - bounds.top, nullptr, nullptr, instance, &app);
  if (!window) {
    MessageBoxW(nullptr, L"Could not create the window.", L"Endpoint client", MB_OK | MB_ICONERROR);
    return 1;
  }
  if (!StartBrowser(window, options, app) || !SetTimer(window, 1, app.gpu ? 8 : 250, nullptr)) {
    MessageBoxW(window, L"Could not launch or monitor the browser process.", L"Endpoint client",
                MB_OK | MB_ICONERROR);
    DestroyWindow(window);
    return 1;
  }
  if (app.gpu) {
    auto sdk = std::filesystem::path(options.browser).parent_path() / L"remotekit_sdk.dll";
    app.atlas = std::make_unique<remotekit::AtlasClient>(window, sdk.wstring(), app.channel);
    if (!app.atlas->Start()) {
      DestroyWindow(window);
      return 1;
    }
  }
  ShowWindow(window, show);
  UpdateWindow(window);
  MSG message{};
  int result;
  while ((result = GetMessageW(&message, nullptr, 0, 0)) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  return result < 0 ? 1 : static_cast<int>(message.wParam);
}
