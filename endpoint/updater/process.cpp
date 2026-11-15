#include "process.hpp"
#include <algorithm>
namespace remotekit::updater {
ChildProcess::ChildProcess(const fs::path& executable,
                           const std::wstring& arguments,
                           const fs::path& root,
                           std::string child,
                           bool job,
                           const std::wstring& environment,
                           bool capture_stdout)
    : child_name_(std::move(child)) {
  SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
  Handle input_read, output_write, error_write;
  if (!CreatePipe(&input_read.value, &input_.value, &security, 0) ||
      !CreatePipe(&output_.value, &output_write.value, &security, 0) ||
      !CreatePipe(&error_.value, &error_write.value, &security, 0) ||
      !SetHandleInformation(error_.value, HANDLE_FLAG_INHERIT, 0) ||
      !SetHandleInformation(input_.value, HANDLE_FLAG_INHERIT, 0) ||
      !SetHandleInformation(output_.value, HANDLE_FLAG_INHERIT, 0))
    throw std::runtime_error("cannot create child pipes");
  if (!capture_stdout) {
    CloseHandle(output_write.Release());
    output_write.value = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                     &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (output_write.value == INVALID_HANDLE_VALUE)
      throw std::runtime_error("cannot open child stdout");
  }
  SIZE_T size = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
  std::vector<uint8_t> storage(size);
  auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  if (!InitializeProcThreadAttributeList(attributes, 1, 0, &size))
    throw std::runtime_error("cannot initialize child attributes");
  HANDLE inherited[] = {input_read.value, output_write.value, error_write.value};
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited,
                                 sizeof(inherited), nullptr, nullptr)) {
    DeleteProcThreadAttributeList(attributes);
    throw std::runtime_error("cannot set child handles");
  }
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = input_read.value;
  startup.StartupInfo.hStdOutput = output_write.value;
  startup.StartupInfo.hStdError = error_write.value;
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
  CloseHandle(error_write.Release());
  const auto forward = [this](HANDLE pipe, const char* stream) {
    ProcessOutput output(child_name_, Pid(), stream);
    std::array<char, 16384> bytes;
    DWORD count = 0;
    while (ReadFile(pipe, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr) && count)
      output.Append(std::string_view(bytes.data(), count));
  };
  try {
    if (capture_stdout)
      forwarding_ = std::thread(forward, output_.value, "stdout");
    errors_ = std::thread(forward, error_.value, "stderr");
  } catch (...) {
    TerminateProcess(child_.value, 1);
    if (forwarding_.joinable())
      forwarding_.join();
    throw;
  }
}
ChildProcess::~ChildProcess() {
  Terminate();
  if (job_.value)
    TerminateJobObject(job_.value, 1);
  for (auto* forwarding : {&forwarding_, &errors_}) {
    if (!forwarding->joinable())
      continue;
    const auto thread = forwarding->native_handle();
    while (WaitForSingleObject(thread, 100) == WAIT_TIMEOUT)
      CancelSynchronousIo(thread);
    forwarding->join();
  }
  switch (ending_) {
    case Ending::kSelf:
      LogProcessExit(child_name_, Pid(), ExitCode(), child_name_ == "control");
      break;
    case Ending::kTerminated:
      LogEvent(LogLevel::kInfo, "process.terminated",
               {{"child", child_name_}, {"childPid", Pid()}});
      break;
    case Ending::kStopTimedOut:
      LogEvent(LogLevel::kWarn, "process.stop_timed_out",
               {{"child", child_name_}, {"childPid", Pid()}});
      break;
  }
}

void ChildProcess::Stop(DWORD timeout) {
  if (input_.value)
    CloseHandle(input_.Release());
  if (child_.value && WaitForSingleObject(child_.value, timeout) != WAIT_OBJECT_0) {
    ending_ = Ending::kStopTimedOut;
    Kill();
  }
}
void ChildProcess::Terminate() {
  if (input_.value)
    CloseHandle(input_.Release());
  if (child_.value && WaitForSingleObject(child_.value, 0) != WAIT_OBJECT_0) {
    ending_ = Ending::kTerminated;
    Kill();
  }
}
void ChildProcess::Kill() {
  if (job_.value)
    TerminateJobObject(job_.value, 1);
  else
    TerminateProcess(child_.value, 1);
  WaitForSingleObject(child_.value, INFINITE);
}
DWORD ChildProcess::ExitCode() const {
  DWORD code = 1;
  GetExitCodeProcess(child_.value, &code);
  return code;
}
}  // namespace remotekit::updater
