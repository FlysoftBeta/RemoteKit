#include "util/log.hpp"
#include "platform/process.hpp"
#include <algorithm>
#include <iomanip>
#include <sstream>
#include <vector>
#include <chrono>
#include <thread>
#include <set>
#include "persistence/phase_timing.hpp"

namespace remotekit {
namespace {
Error ProcessError(const char* message) {
  const auto code = GetLastError();
  return WithOsError(ErrorCode::kUnavailable,
                     std::string(message) + " Windows " + std::to_string(code),
                     OsError::Kind::kWin32, code);
}
std::vector<ULONG_PTR> JobProcessIds(HANDLE job) {
  if (!job)
    return {};
  std::vector<ULONG_PTR> memory(16);
  for (;;) {
    auto* ids = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(memory.data());
    if (QueryInformationJobObject(job, JobObjectBasicProcessIdList, ids,
                                  static_cast<DWORD>(memory.size() * sizeof(ULONG_PTR)), nullptr))
      return {ids->ProcessIdList, ids->ProcessIdList + ids->NumberOfProcessIdsInList};
    if (GetLastError() != ERROR_MORE_DATA)
      return {};
    memory.resize(ids->NumberOfAssignedProcesses + 2);
  }
}
}  // namespace
std::string DescribeExitCode(DWORD code) {
  std::ostringstream detail;
  detail << "0x" << std::uppercase << std::hex << std::setw(8) << std::setfill('0') << code;
  switch (code) {
    case 0xC0000135:
      detail << "（缺少 DLL）";
      break;
    case 0xC0000139:
      detail << "（DLL 入口点缺失）";
      break;
    case 0xC0000142:
      detail << "（DLL 初始化失败）";
      break;
    case 0xC0000005:
      detail << "（访问冲突崩溃）";
      break;
    case 0x80000003:
      detail << "（断言/CHECK 失败）";
      break;
    case 0xC0000409:
      detail << "（栈缓冲区检查/快速失败）";
      break;
    case 0xC0000417:
      detail << "（CRT 无效参数）";
      break;
  }
  return detail.str();
}
BrowserProcess::~BrowserProcess() {
  if (Present())
    (void)Terminate();
  if (job_)
    CloseHandle(job_);
  if (process_)
    CloseHandle(process_);
}
std::wstring BrowserProcess::Quote(const std::wstring& value) {
  std::wstring result = L"\"";
  size_t slashes = 0;
  for (auto c : value) {
    if (c == L'\\') {
      ++slashes;
      continue;
    }
    result.append(c == L'"' ? slashes * 2 + 1 : slashes, L'\\');
    result += c;
    slashes = 0;
  }
  result.append(slashes * 2, L'\\');
  return result + L"\"";
}
Result<void> BrowserProcess::Launch(const fs::path& executable,
                                    std::wstring command,
                                    std::span<const uint8_t, 32> profile_key) {
  if (Present())
    return Error{ErrorCode::kConflict, "browser process is retained"};
  struct Pipe {
    HANDLE read = nullptr, write = nullptr;
    ~Pipe() {
      if (read)
        CloseHandle(read);
      if (write)
        CloseHandle(write);
    }
  } pipe;
  SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
  if (!CreatePipe(&pipe.read, &pipe.write, &security, 32) ||
      !SetHandleInformation(pipe.write, HANDLE_FLAG_INHERIT, 0))
    return ProcessError("profile key pipe failed");
  DWORD written = 0;
  if (!WriteFile(pipe.write, profile_key.data(), 32, &written, nullptr) || written != 32)
    return ProcessError("profile key write failed");
  CloseHandle(pipe.write);
  pipe.write = nullptr;
  command += L" --profile-key-handle=" + std::to_wstring(reinterpret_cast<uintptr_t>(pipe.read));
  SIZE_T size = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
  std::vector<uint8_t> storage(size);
  auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  if (!InitializeProcThreadAttributeList(attributes, 1, 0, &size))
    return ProcessError("process attribute initialization failed");
  struct Attributes {
    LPPROC_THREAD_ATTRIBUTE_LIST value;
    ~Attributes() { DeleteProcThreadAttributeList(value); }
  } cleanup{attributes};
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &pipe.read,
                                 sizeof(pipe.read), nullptr, nullptr))
    return ProcessError("profile key inheritance failed");
  state_ = State::kLaunching;
  job_ = CreateJobObjectW(nullptr, nullptr);
  if (!job_) {
    state_ = State::kStopped;
    return ProcessError("CreateJobObject failed");
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job_, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    auto error = ProcessError("job limits failed");
    CloseHandle(job_);
    job_ = nullptr;
    state_ = State::kStopped;
    return error;
  }
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESHOWWINDOW;
  startup.StartupInfo.wShowWindow = SW_HIDE;
  startup.lpAttributeList = attributes;
  PROCESS_INFORMATION info{};
  const bool created =
      CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
                     CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, nullptr,
                     executable.parent_path().c_str(), &startup.StartupInfo, &info) != FALSE;
  const auto launch_error = GetLastError();
  CloseHandle(pipe.read);
  pipe.read = nullptr;
  if (!created) {
    SetLastError(launch_error);
    auto error = ProcessError("browser launch failed");
    CloseHandle(job_);
    job_ = nullptr;
    state_ = State::kStopped;
    return error;
  }
  process_ = info.hProcess;
  if (!AssignProcessToJobObject(job_, process_)) {
    auto error = ProcessError("browser job assignment failed");
    CloseHandle(info.hThread);
    (void)Terminate();
    return error;
  }
  assigned_ = true;
  if (ResumeThread(info.hThread) == DWORD(-1)) {
    auto error = ProcessError("browser resume failed");
    CloseHandle(info.hThread);
    (void)Terminate();
    return error;
  }
  CloseHandle(info.hThread);
  state_ = State::kRunning;
  return {};
}
BrowserProcess::State BrowserProcess::state() const {
  if (state_ == State::kRunning && Exited())
    state_ = State::kExited;
  return state_;
}
bool BrowserProcess::Alive() const {
  return process_ && WaitForSingleObject(process_, 0) == WAIT_TIMEOUT;
}
bool BrowserProcess::Exited() const {
  return process_ && WaitForSingleObject(process_, 0) == WAIT_OBJECT_0;
}
std::optional<DWORD> BrowserProcess::ExitCode() const {
  DWORD code = 0;
  if (!Exited() || !GetExitCodeProcess(process_, &code))
    return std::nullopt;
  return code;
}
Result<void> BrowserProcess::Terminate() {
  if (!Present()) {
    state_ = State::kStopped;
    return {};
  }
  state_ = State::kStopping;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
  struct Processes {
    std::vector<HANDLE> handles;
    ~Processes() {
      for (const auto handle : handles)
        CloseHandle(handle);
    }
    size_t Remaining() const {
      return std::count_if(handles.begin(), handles.end(), [](HANDLE handle) {
        return WaitForSingleObject(handle, 0) != WAIT_OBJECT_0;
      });
    }
  } processes;
  for (const auto pid : JobProcessIds(job_))
    if (auto handle = OpenProcess(SYNCHRONIZE, FALSE, static_cast<DWORD>(pid)))
      processes.handles.push_back(handle);
  if (job_ && !TerminateJobObject(job_, 0))
    LogError(LogLevel::kWarn, "process.job_termination_failed",
             WithOsError(ErrorCode::kUnavailable, "producer termination failed",
                         OsError::Kind::kWin32, GetLastError()));
  if (process_) {
    if (!assigned_ && Alive() && !TerminateProcess(process_, 1))
      LogError(LogLevel::kWarn, "process.termination_failed",
               WithOsError(ErrorCode::kUnavailable, "producer termination failed",
                           OsError::Kind::kWin32, GetLastError()));
  }
  // Job accounting can reach zero before process handle and file cleanup completes.
  while ((!Exited() && process_) || !JobEmpty() || processes.Remaining()) {
    if (std::chrono::steady_clock::now() >= deadline) {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
      const bool queried =
          job_ && QueryInformationJobObject(job_, JobObjectBasicAccountingInformation, &accounting,
                                            sizeof(accounting), nullptr);
      LogEvent(LogLevel::kWarn, "browser.job_not_empty",
               {{"pid", Pid()},
                {"remaining",
                 queried ? Json(std::max<size_t>(accounting.ActiveProcesses, processes.Remaining()))
                         : Json(nullptr)}});
      return Error{ErrorCode::kOutcomeUnknown,
                   "producer termination not confirmed; process retained"};
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }
  state_ = State::kExited;
  return {};
}
bool BrowserProcess::JobEmpty() const {
  if (!job_)
    return !process_ || Exited();
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
  return QueryInformationJobObject(job_, JobObjectBasicAccountingInformation, &accounting,
                                   sizeof(accounting), nullptr) &&
         accounting.ActiveProcesses == 0;
}
bool BrowserProcess::WaitCleanExit(uint32_t timeout_ms, Json* timing) {
  const auto started = PhaseClock::now();
  std::set<ULONG_PTR> observed, recorded;
  if (timing)
    (*timing)["processes"] = Json::array();
  auto sample = [&] {
    if (!timing || !job_)
      return;
    const auto ids = JobProcessIds(job_);
    const std::set<ULONG_PTR> current(ids.begin(), ids.end());
    observed.insert(current.begin(), current.end());
    observed.insert(Pid());
    for (const auto pid : observed)
      if (!current.contains(pid) && recorded.insert(pid).second)
        (*timing)["processes"].push_back({{"pid", pid}, {"ms", PhaseMs(started)}});
  };
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  do {
    sample();
    if (Exited() && JobEmpty()) {
      state_ = State::kExited;
      return ExitCode() == 0;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  } while (std::chrono::steady_clock::now() < deadline);
  return false;
}
void BrowserProcess::ReleaseExited() {
  if (state_ != State::kExited)
    return;
  if (process_)
    CloseHandle(process_);
  if (job_)
    CloseHandle(job_);
  process_ = job_ = nullptr;
  assigned_ = false;
  state_ = State::kStopped;
}
std::string BrowserProcess::Diagnostic() const {
  if (!process_)
    return "process=absent";
  std::ostringstream detail;
  detail << "pid=" << Pid() << " process="
         << (Alive()    ? "running"
             : Exited() ? "exited"
                        : "query-failed");
  if (const auto code = ExitCode())
    detail << " exit_code=" << DescribeExitCode(*code);
  return detail.str();
}
}  // namespace remotekit
