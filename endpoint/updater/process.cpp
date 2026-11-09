#include "process.hpp"
#include <algorithm>
namespace remotekit::updater {
ChildProcess::ChildProcess(const fs::path& executable,
                           const std::wstring& arguments,
                           const fs::path& root,
                           Log& log,
                           bool job,
                           const std::wstring& environment) {
  SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
  Handle input_read, output_write;
  if (!CreatePipe(&input_read.value, &input_.value, &security, 0) ||
      !CreatePipe(&output_.value, &output_write.value, &security, 0) ||
      !SetHandleInformation(input_.value, HANDLE_FLAG_INHERIT, 0) ||
      !SetHandleInformation(output_.value, HANDLE_FLAG_INHERIT, 0))
    throw std::runtime_error("cannot create child pipes");
  SIZE_T size = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
  std::vector<uint8_t> storage(size);
  auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  if (!InitializeProcThreadAttributeList(attributes, 1, 0, &size))
    throw std::runtime_error("cannot initialize child attributes");
  HANDLE inherited[] = {input_read.value, output_write.value};
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited,
                                 sizeof(inherited), nullptr, nullptr)) {
    DeleteProcThreadAttributeList(attributes);
    throw std::runtime_error("cannot set child handles");
  }
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = input_read.value;
  startup.StartupInfo.hStdOutput = startup.StartupInfo.hStdError = output_write.value;
  startup.lpAttributeList = attributes;
  std::vector<wchar_t> block;
  if (!environment.empty()) {
    std::vector<std::wstring> entries;
    auto key = environment.substr(0, environment.find(L'=') + 1);
    auto original = GetEnvironmentStringsW();
    if (!original) {
      DeleteProcThreadAttributeList(attributes);
      throw std::runtime_error("cannot read child environment");
    }
    for (auto at = original; *at; at += wcslen(at) + 1)
      if (_wcsnicmp(at, key.c_str(), key.size()) != 0)
        entries.emplace_back(at);
    FreeEnvironmentStringsW(original);
    entries.push_back(environment);
    std::sort(entries.begin(), entries.end(),
              [](const auto& a, const auto& b) { return _wcsicmp(a.c_str(), b.c_str()) < 0; });
    for (auto& entry : entries) {
      block.insert(block.end(), entry.begin(), entry.end());
      block.push_back(0);
    }
    block.push_back(0);
  }
  if (job) {
    job_.value = CreateJobObjectW(nullptr, nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!job_.value || !SetInformationJobObject(job_.value, JobObjectExtendedLimitInformation,
                                                &limits, sizeof(limits))) {
      DeleteProcThreadAttributeList(attributes);
      throw std::runtime_error("cannot create child job");
    }
  }
  auto command = Quote(executable.wstring()) + L" " + arguments;
  PROCESS_INFORMATION process{};
  bool created = CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
                                EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW | CREATE_SUSPENDED |
                                    CREATE_UNICODE_ENVIRONMENT,
                                block.empty() ? nullptr : block.data(), root.c_str(),
                                &startup.StartupInfo, &process) != FALSE;
  DeleteProcThreadAttributeList(attributes);
  if (!created)
    throw std::runtime_error("cannot start child process");
  child_.value = process.hProcess;
  Handle thread(process.hThread);
  if ((job && !AssignProcessToJobObject(job_.value, child_.value)) ||
      ResumeThread(thread.value) == static_cast<DWORD>(-1)) {
    TerminateProcess(child_.value, 1);
    throw std::runtime_error("cannot activate child process");
  }
  CloseHandle(input_read.Release());
  CloseHandle(output_write.Release());
  try {
    forwarding_ = std::thread([this, &log] {
      try {
        std::array<uint8_t, 16384> bytes;
        DWORD count = 0;
        while (ReadFile(output_.value, bytes.data(), static_cast<DWORD>(bytes.size()), &count,
                        nullptr) &&
               count)
          log.Write(std::span(bytes).first(count));
      } catch (...) {
      }
    });
  } catch (...) {
    TerminateProcess(child_.value, 1);
    throw;
  }
}
ChildProcess::~ChildProcess() {
  Stop(0);
  if (job_.value)
    TerminateJobObject(job_.value, 1);
  if (forwarding_.joinable()) {
    auto thread = forwarding_.native_handle();
    while (WaitForSingleObject(thread, 100) == WAIT_TIMEOUT)
      CancelSynchronousIo(thread);
    forwarding_.join();
  }
}
void ChildProcess::Stop(DWORD timeout) {
  if (input_.value)
    CloseHandle(input_.Release());
  if (child_.value && WaitForSingleObject(child_.value, timeout) != WAIT_OBJECT_0) {
    if (job_.value)
      TerminateJobObject(job_.value, 1);
    else
      TerminateProcess(child_.value, 1);
    WaitForSingleObject(child_.value, INFINITE);
  }
}
DWORD ChildProcess::ExitCode() const {
  DWORD code = 1;
  GetExitCodeProcess(child_.value, &code);
  return code;
}
}  // namespace remotekit::updater
