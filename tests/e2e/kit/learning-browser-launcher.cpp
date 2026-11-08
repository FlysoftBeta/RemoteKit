#include <windows.h>

#include <string>
#include <vector>

std::wstring Environment(const wchar_t* name) {
  const DWORD length = GetEnvironmentVariableW(name, nullptr, 0);
  std::vector<wchar_t> value(length);
  if (!length || !GetEnvironmentVariableW(name, value.data(), length))
    return {};
  return value.data();
}

int wmain() {
  const auto browser = Environment(L"REMOTEKIT_TEST_BROWSER");
  const auto port = Environment(L"REMOTEKIT_TEST_LEARNING_PORT");
  const auto pin = Environment(L"REMOTEKIT_TEST_LEARNING_CERT_PIN");
  if (browser.empty() || port.empty() || pin.empty())
    return 2;
  const std::wstring original = GetCommandLineW();
  const auto arguments = original[0] == L'"' ? original.find(L'"', 1) + 1 : original.find(L' ');
  std::wstring command = L"\"" + browser + L"\"" + original.substr(arguments);
  command += L" --no-proxy-server --host-resolver-rules=\"MAP www.xinjiaoyu.com 127.0.0.1:" + port +
             L"\" --ignore-certificate-errors-spki-list=" + pin;
  STARTUPINFOW startup{sizeof(startup)};
  startup.dwFlags = STARTF_USESHOWWINDOW;
  startup.wShowWindow = SW_HIDE;
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(browser.c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW,
                      nullptr, nullptr, &startup, &process))
    return 3;
  CloseHandle(process.hThread);
  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD status = 1;
  GetExitCodeProcess(process.hProcess, &status);
  CloseHandle(process.hProcess);
  return static_cast<int>(status);
}
