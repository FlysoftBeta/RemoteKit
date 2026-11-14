#include "crash/crash.hpp"
#include "util/log.hpp"
#include <windows.h>
#include <fstream>
#include <iostream>
#include <stdexcept>
namespace {
void Check(bool value, const char* message) {
  if (!value)
    throw std::runtime_error(message);
}
__declspec(noinline) void Fault() {
  *static_cast<volatile int*>(nullptr) = 42;
}
}  // namespace
int wmain(int argc, wchar_t** argv) {
  using namespace remotekit;
  if (RunCrashHandler(argc, argv))
    return 0;
  if (argc == 3 && std::wstring_view(argv[1]) == L"--fault") {
    InitLog(argv[2], "endpoint");
    InstallCrashHandler(argv[2], "endpoint");
    LogEvent(LogLevel::kInfo, "test.before_crash");
    Fault();
    return 2;
  }
  if (argc != 2)
    return 2;
  const auto root = fs::absolute(fs::path(argv[1]) /
                                 (L"crash-handler-" + std::to_wstring(GetCurrentProcessId())));
  try {
    fs::create_directories(root);
    wchar_t executable[32768];
    GetModuleFileNameW(nullptr, executable, std::size(executable));
    auto command = L"\"" + std::wstring(executable) + L"\" --fault \"" + root.wstring() + L"\"";
    STARTUPINFOW startup{sizeof(startup)};
    PROCESS_INFORMATION process{};
    Check(CreateProcessW(executable, command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
                         nullptr, nullptr, &startup, &process) != FALSE,
          "start crashing fixture");
    CloseHandle(process.hThread);
    const auto waited = WaitForSingleObject(process.hProcess, 30000);
    if (waited != WAIT_OBJECT_0)
      TerminateProcess(process.hProcess, 1);
    DWORD code = 0;
    GetExitCodeProcess(process.hProcess, &code);
    CloseHandle(process.hProcess);
    Check(waited == WAIT_OBJECT_0 && code == 0xC0000005, "access violation exit code");
    bool dump = false;
    for (const auto& entry : fs::directory_iterator(root / "crashes/endpoint")) {
      if (entry.path().extension() != ".dmp")
        continue;
      std::ifstream file(entry.path(), std::ios::binary);
      char signature[4]{};
      file.read(signature, sizeof(signature));
      Check(std::string_view(signature, 4) == "MDMP", "valid minidump signature");
      dump = true;
    }
    Check(dump, "minidump exists");
    std::ifstream file(root / LocalLogDate() / "endpoint.jsonl");
    std::string line;
    bool crashed = false;
    while (std::getline(file, line)) {
      const auto record = Json::parse(line);
      if (record.at("ev") != "process.crashed")
        continue;
      Check(record.at("codeName") == "EXCEPTION_ACCESS_VIOLATION" &&
                record.at("code") == 0xC0000005 && record.at("pid") == process.dwProcessId &&
                record.at("proc") == "endpoint" && record.at("stack").is_array() &&
                !record.at("stack").empty() && !record.at("address").get<std::string>().empty() &&
                fs::exists(root / record.at("dump").get<std::string>()),
            "crash record fields");
      crashed = true;
    }
    Check(crashed, "crash record appended to host day file");
    file.close();
    fs::remove_all(root);
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
