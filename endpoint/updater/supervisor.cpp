#include "supervisor.hpp"
#include "download.hpp"
#include "util/error_policy.hpp"
#include <thread>

namespace remotekit::updater {
namespace {
DWORD RunEndpoint(const fs::path& root,
                  const std::string& id,
                  HANDLE stop,
                  Log& log,
                  Log& endpoint_log) {
  SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
  Handle input_read, input_write, output_read, output_write;
  if (!CreatePipe(&input_read.value, &input_write.value, &security, 0) ||
      !CreatePipe(&output_read.value, &output_write.value, &security, 0) ||
      !SetHandleInformation(input_write.value, HANDLE_FLAG_INHERIT, 0) ||
      !SetHandleInformation(output_read.value, HANDLE_FLAG_INHERIT, 0))
    throw std::runtime_error("cannot create endpoint pipes");
  SIZE_T size = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
  std::vector<uint8_t> storage(size);
  auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  if (!InitializeProcThreadAttributeList(attributes, 1, 0, &size))
    throw std::runtime_error("cannot initialize process attributes");
  HANDLE inherited[] = {input_read.value, output_write.value};
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited,
                                 sizeof(inherited), nullptr, nullptr)) {
    DeleteProcThreadAttributeList(attributes);
    throw std::runtime_error("cannot set endpoint handles");
  }
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = input_read.value;
  startup.StartupInfo.hStdOutput = startup.StartupInfo.hStdError = output_write.value;
  startup.lpAttributeList = attributes;
  auto executable = root / L"runtime" / id / L"bin/endpoint_service.exe";
  std::wstring command = Quote(executable.wstring()) + L" --node-root=" + Quote(root.wstring());
  PROCESS_INFORMATION process{};
  bool created = CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
                                EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW, nullptr,
                                root.c_str(), &startup.StartupInfo, &process) != FALSE;
  DeleteProcThreadAttributeList(attributes);
  if (!created)
    throw std::runtime_error("cannot start endpoint");
  Handle child(process.hProcess), thread(process.hThread);
  CloseHandle(input_read.Release());
  CloseHandle(output_write.Release());
  std::thread output([&] {
    try {
      std::array<uint8_t, 16384> bytes;
      DWORD count = 0;
      while (ReadFile(output_read.value, bytes.data(), static_cast<DWORD>(bytes.size()), &count,
                      nullptr) &&
             count)
        endpoint_log.Write(std::span(bytes).first(count));
    } catch (...) {
      SetEvent(stop);
    }
  });
  log.Line("started endpoint PID " + std::to_string(process.dwProcessId));
  HANDLE waits[] = {stop, child.value};
  DWORD result = WaitForMultipleObjects(2, waits, FALSE, INFINITE);
  if (result == WAIT_OBJECT_0 || result == WAIT_FAILED) {
    CloseHandle(input_write.Release());
    if (WaitForSingleObject(child.value, 30000) != WAIT_OBJECT_0) {
      TerminateProcess(child.value, 1);
      WaitForSingleObject(child.value, INFINITE);
    }
  }
  CancelSynchronousIo(output.native_handle());
  output.join();
  DWORD code = 1;
  GetExitCodeProcess(child.value, &code);
  log.Line("endpoint exit " + std::to_string(code));
  return code;
}
}  // namespace
int Supervise(const fs::path& root, HANDLE stop, bool service) {
  fs::create_directories(root);
  std::error_code ec;
  fs::remove(root / L"remotekit_node.exe.old", ec);
  Log log(root / L"logs/supervisor.log"), endpoint_log(root / L"logs/endpoint.log");
  auto config = cluster::LoadNodeFiles(root);
  if (!config) {
    log.Line(config.error().message);
    return 1;
  }
  unsigned backoff = 1;
  unsigned update_attempt = 0;
  bool update = ReadCurrent(root).empty();
  while (!Stopping(stop)) {
    if (update) {
      auto result = Update(root, stop, log, service);
      if (!result) {
        log.Line(result.error().message);
        const auto delay = result.error().code == ErrorCode::kUnavailable ||
                                   result.error().code == ErrorCode::kBusy
                               ? RetryDelay(result.error(), update_attempt++)
                               : std::nullopt;
        if (!delay) {
          if (result.error().code != ErrorCode::kRejected &&
              result.error().code != ErrorCode::kInternal)
            return 1;
        }
        if (Delay(stop, delay ? static_cast<DWORD>(delay->count()) : 30000))
          break;
        continue;
      }
      if (result.value())
        return service ? 1 : 0;
      update_attempt = 0;
      update = false;
    }
    auto id = ReadCurrent(root);
    if (id.empty()) {
      update = true;
      continue;
    }
    auto started = GetTickCount64();
    DWORD code = 1;
    try {
      code = RunEndpoint(root, id, stop, log, endpoint_log);
    } catch (const std::exception& error) {
      log.Line(error.what());
    }
    if (Stopping(stop))
      break;
    if (GetTickCount64() - started >= 60000)
      backoff = 1;
    if (code == 3) {
      update = true;
      continue;
    }
    if (code == 4)
      continue;
    log.Line("restart delay " + std::to_string(backoff) + " s");
    if (Delay(stop, backoff * 1000))
      break;
    backoff = std::min(backoff * 2, 30u);
  }
  log.Line("supervisor stopped");
  return 0;
}
}  // namespace remotekit::updater
