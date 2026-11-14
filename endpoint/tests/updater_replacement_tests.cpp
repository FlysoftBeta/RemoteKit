#include "replacement.hpp"
#include "archive.hpp"
#include <fstream>
#include <iostream>
namespace {
bool fail_install = false;
BOOL WINAPI ReplacementReplace(LPCWSTR installed,
                               LPCWSTR staged,
                               LPCWSTR backup,
                               DWORD flags,
                               LPVOID exclude,
                               LPVOID reserved) {
  if (!std::filesystem::is_regular_file(installed))
    throw std::runtime_error("installed path missing before atomic replacement");
  if (fail_install) {
    SetLastError(ERROR_ACCESS_DENIED);
    return FALSE;
  }
  return ReplaceFileW(installed, staged, backup, flags, exclude, reserved);
}
}  // namespace
#define ReplaceFileW ReplacementReplace
#include "../updater/replacement.cpp"
#undef ReplaceFileW
using namespace remotekit;
using namespace remotekit::updater;
namespace {
void Check(bool value, const char* message) {
  if (!value)
    throw std::runtime_error(message);
}
int Child() {
  const auto installed = ExecutablePath();
  const auto root = installed.parent_path();
  const auto replacement = root / L"replacement";
  std::ofstream(replacement) << "replacement bytes";
  const auto original = cluster::Sha256File(installed).value();
  Log log(root / L"logs/replacement.log");
  fail_install = true;
  const auto result = ReplaceExecutable(installed, replacement, root, L"", true, log);
  Check(!result && result.error().message == "cannot install new supervisor",
        "installation failure returned");
  Check(fs::exists(installed) && cluster::Sha256File(installed).value() == original,
        "old executable restored");
  Check(!fs::exists(installed.wstring() + L".old"), "rollback consumes old path");
  Check(fs::exists(installed.wstring() + L".new"), "new executable was staged before renaming");
  fail_install = false;
  auto retried = ReplaceExecutable(installed, replacement, root, L"", true, log);
  Check(retried && retried.value(), "same release replacement retried after transient failure");
  Check(cluster::Sha256File(installed).value() == cluster::Sha256File(replacement).value(),
        "atomic replacement installed promised bytes");
  return 0;
}
}  // namespace
int wmain(int argc, wchar_t** argv) {
  try {
    if (argc == 2 && std::wstring_view(argv[1]) == L"--child")
      return Child();
    if (argc != 2)
      return 2;
    const auto root =
        fs::path(argv[1]) / (L"replacement-" + std::to_wstring(GetCurrentProcessId()));
    fs::create_directories(root);
    const auto copy = root / L"remotekit_node.exe";
    fs::copy_file(ExecutablePath(), copy, fs::copy_options::overwrite_existing);
    auto command = Quote(copy.wstring()) + L" --child";
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    Check(CreateProcessW(copy.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
                         nullptr, root.c_str(), &startup, &process) != FALSE,
          "launch replacement child");
    WaitForSingleObject(process.hProcess, 30000);
    DWORD code = 1;
    GetExitCodeProcess(process.hProcess, &code);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    Check(code == 0, "replacement rollback child");
    fs::remove_all(root);
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
