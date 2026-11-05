#include "platform/process.hpp"
#include <iomanip>
#include <sstream>

namespace remotekit {
namespace {
Error ProcessError(const char* message) {
  return {ErrorCode::kUnavailable,
          std::string(message) + " Windows " + std::to_string(GetLastError())};
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
Result<void> BrowserProcess::Launch(const fs::path& executable, std::wstring command) {
  if (Present())
    return Error{ErrorCode::kConflict, "browser process is retained"};
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
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESHOWWINDOW;
  startup.wShowWindow = SW_HIDE;
  PROCESS_INFORMATION info{};
  if (!CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE,
                      CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr,
                      executable.parent_path().c_str(), &startup, &info)) {
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
  if (job_ && !TerminateJobObject(job_, 0))
    std::fprintf(stderr, "producer job termination Windows %lu\n", GetLastError());
  if (process_) {
    if (!assigned_ && Alive() && !TerminateProcess(process_, 1))
      std::fprintf(stderr, "unassigned producer termination Windows %lu\n", GetLastError());
    if (WaitForSingleObject(process_, 5000) != WAIT_OBJECT_0)
      return Error{ErrorCode::kOutcomeUnknown,
                   "producer termination not confirmed; process retained"};
  }
  state_ = State::kExited;
  return {};
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
