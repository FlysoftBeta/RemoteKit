#include "util/log.hpp"
#include "documents/tool_process.hpp"

#include <windows.h>
#include <bcrypt.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdio>
#include <fstream>
#include <map>
#include <regex>
#include <stdexcept>
#include <thread>

namespace remotekit::documents {
namespace {
struct Handle {
  HANDLE value = nullptr;
  ~Handle() {
    if (value && value != INVALID_HANDLE_VALUE)
      CloseHandle(value);
  }
};

std::wstring Quote(std::wstring_view argument) {
  std::wstring result = L"\"";
  size_t slashes = 0;
  for (wchar_t c : argument) {
    if (c == L'\\') {
      ++slashes;
      continue;
    }
    result.append(slashes * (c == L'"' ? 2 : 1), L'\\');
    if (c == L'"')
      result += L'\\';
    result += c;
    slashes = 0;
  }
  result.append(slashes * 2, L'\\');
  return result + L'"';
}

Bytes ReadLog(const std::filesystem::path& path) {
  std::ifstream file(path, std::ios::binary | std::ios::ate);
  if (!file)
    return {};
  const auto size = file.tellg();
  file.seekg(std::max<std::streamoff>(0, static_cast<std::streamoff>(size) - 65536));
  Bytes bytes(65536);
  file.read(reinterpret_cast<char*>(bytes.data()), bytes.size());
  bytes.resize(static_cast<size_t>(file.gcount()));
  return bytes;
}

std::string StderrTail(const std::filesystem::path& log) {
  auto bytes = ReadLog(log);
  std::string output(bytes.begin(), bytes.end());
  while (!output.empty() && (output.back() == '\n' || output.back() == '\r'))
    output.pop_back();
  size_t start = output.size();
  for (size_t lines = 0; start && lines < 8; ++lines) {
    auto newline = output.rfind('\n', start - 1);
    if (newline == output.npos) {
      start = 0;
      break;
    }
    start = newline;
  }
  if (start)
    ++start;
  output.erase(0, start);
  // Import/parser diagnostics can quote document text or include staged paths.
  static const std::regex private_values(
      R"regex(<[^>]*>|"[^"]*"|'[^'\r\n]*'|(?:[A-Za-z]:[\\/]|file:/|/)[^\s]*)regex");
  output = std::regex_replace(output, private_values, "[redacted]");
  std::string tail;
  size_t position = 0;
  while (position < output.size()) {
    auto end = output.find('\n', position);
    auto line = output.substr(position, end == output.npos ? end : end - position);
    // Lines without a diagnostic prefix can be excerpts from the source file.
    const bool diagnostic = line.starts_with("Error") || line.starts_with("Warning") ||
                            line.starts_with("Syntax Error") ||
                            line.starts_with("Syntax Warning") || line.starts_with("I/O Error") ||
                            line.starts_with("warn:");
    if (!tail.empty())
      tail += " | ";
    if (diagnostic) {
      for (unsigned char c : line) {
        if (c >= 32 && c < 127)
          tail += static_cast<char>(c);
      }
    } else {
      tail += "[redacted]";
    }
    if (end == output.npos)
      break;
    position = end + 1;
  }
  if (tail.size() > 2048)
    tail.erase(0, tail.size() - 2048);
  return tail;
}

void LogToolFailure(const std::filesystem::path& executable,
                    std::string_view exit_code,
                    const std::filesystem::path& log,
                    std::string_view reason) {
  const auto tool = executable.filename().string();
  const auto tail = StderrTail(log);
  LogEvent(LogLevel::kWarn, "document.tool_failed",
           {{"tool", tool},
            {"exitCode", std::string(exit_code)},
            {"reason", std::string(reason)},
            {"stderrTail", tail}});
}

}  // namespace

Error ToolOutputFailure(const std::filesystem::path& log,
                        const std::filesystem::path& executable,
                        uint32_t exit_code) {
  auto bytes = ReadLog(log);
  std::string output(bytes.begin(), bytes.end());
  std::transform(output.begin(), output.end(), output.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  const auto reason =
      output.find("password") != output.npos || output.find("encrypted") != output.npos
          ? "password-protected document"
          : "corrupt document or conversion failed";
  LogToolFailure(executable, std::to_string(exit_code), log, reason);
  return {ErrorCode::kRejected, reason,
          output.find("password") != output.npos || output.find("encrypted") != output.npos
              ? ErrorReason::kDocumentEncrypted
              : ErrorReason::kDocumentCorrupt};
}

std::filesystem::path DefaultToolsDirectory() {
  std::wstring path(32768, L'\0');
  DWORD length = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
  if (!length || length == path.size())
    throw std::runtime_error("cannot locate document runtimes");
  path.resize(length);
  return std::filesystem::path(path).parent_path() / "documents";
}

std::string Sha256Hex(std::span<const uint8_t> bytes) {
  std::array<uint8_t, 32> hash{};
  if (BCryptHash(BCRYPT_SHA256_ALG_HANDLE, nullptr, 0, const_cast<PUCHAR>(bytes.data()),
                 static_cast<ULONG>(bytes.size()), hash.data(),
                 static_cast<ULONG>(hash.size())) < 0)
    throw std::runtime_error("SHA-256 failed");
  std::string hex;
  for (uint8_t byte : hash) {
    hex += "0123456789abcdef"[byte >> 4];
    hex += "0123456789abcdef"[byte & 15];
  }
  return hex;
}

std::wstring FileUrl(const std::filesystem::path& path) {
  auto utf8 = std::filesystem::absolute(path).generic_u8string();
  std::wstring url = utf8.starts_with(u8"//") ? L"file:" : L"file:///";
  for (uint8_t c : utf8) {
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '/' ||
        c == ':' || c == '-' || c == '_' || c == '.' || c == '~') {
      url += c;
    } else {
      url += L'%';
      url += L"0123456789ABCDEF"[c >> 4];
      url += L"0123456789ABCDEF"[c & 15];
    }
  }
  return url;
}

TemporaryDirectory::TemporaryDirectory(const std::filesystem::path& parent) {
  std::filesystem::create_directories(parent);
  std::array<uint8_t, 16> random{};
  if (BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()),
                      BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0)
    throw std::runtime_error("temporary directory entropy failed");
  path_ = parent / Sha256Hex(random).substr(0, 32);
  if (!std::filesystem::create_directory(path_))
    throw std::runtime_error("temporary directory collision");
}

TemporaryDirectory::~TemporaryDirectory() {
  std::error_code ignored;
  std::filesystem::remove_all(path_, ignored);
}

Result<void> RunTool(const std::filesystem::path& executable,
                     const std::vector<std::wstring>& arguments,
                     const std::filesystem::path& working_directory,
                     const Environment& environment,
                     std::chrono::milliseconds timeout) {
  const auto unavailable = [&](std::string message) -> Result<void> {
    LogToolFailure(executable, "not_started", {}, message);
    return Error{ErrorCode::kUnavailable, std::move(message)};
  };
  if (!std::filesystem::is_regular_file(executable))
    return unavailable("document tool missing");
  auto log = working_directory / "tool.log";
  SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
  Handle input{CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &security,
                           OPEN_EXISTING, 0, nullptr)};
  Handle output{CreateFileW((working_directory / "tool.stdout.log").c_str(), GENERIC_WRITE,
                            FILE_SHARE_READ | FILE_SHARE_WRITE, &security, CREATE_ALWAYS,
                            FILE_ATTRIBUTE_NORMAL, nullptr)};
  Handle error_output{CreateFileW(log.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                  &security, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr)};
  Handle job{CreateJobObjectW(nullptr, nullptr)};
  if (input.value == INVALID_HANDLE_VALUE || output.value == INVALID_HANDLE_VALUE ||
      error_output.value == INVALID_HANDLE_VALUE || !job.value)
    return unavailable("cannot create document tool job");
  Handle notifications{CreateIoCompletionPort(INVALID_HANDLE_VALUE, nullptr, 0, 1)};
  JOBOBJECT_ASSOCIATE_COMPLETION_PORT association{nullptr, notifications.value};
  if (!notifications.value ||
      !SetInformationJobObject(job.value, JobObjectAssociateCompletionPortInformation, &association,
                               sizeof(association)))
    return unavailable("Cannot monitor document tool job limits");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_JOB_MEMORY;
  limits.JobMemoryLimit = 2ULL * 1024 * 1024 * 1024;
  JOBOBJECT_BASIC_UI_RESTRICTIONS ui{0xff};
  if (!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits,
                               sizeof(limits)) ||
      !SetInformationJobObject(job.value, JobObjectBasicUIRestrictions, &ui, sizeof(ui)))
    return unavailable("cannot limit document tool job");

  SIZE_T attribute_size = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attribute_size);
  std::vector<uint8_t> attributes(attribute_size);
  auto* list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
  if (!InitializeProcThreadAttributeList(list, 1, 0, &attribute_size))
    return unavailable("cannot initialize tool handles");
  struct AttributeCleanup {
    LPPROC_THREAD_ATTRIBUTE_LIST list;
    ~AttributeCleanup() { DeleteProcThreadAttributeList(list); }
  } cleanup{list};
  HANDLE handles[] = {input.value, output.value, error_output.value};
  if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles,
                                 sizeof(handles), nullptr, nullptr))
    return unavailable("cannot isolate tool handles");
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  startup.StartupInfo.wShowWindow = SW_HIDE;
  startup.StartupInfo.hStdInput = input.value;
  startup.StartupInfo.hStdOutput = output.value;
  startup.StartupInfo.hStdError = error_output.value;
  startup.lpAttributeList = list;
  std::wstring command = Quote(executable.wstring());
  for (const auto& argument : arguments)
    command += L" " + Quote(argument);

  struct LessEnvironment {
    bool operator()(const std::wstring& a, const std::wstring& b) const {
      return _wcsicmp(a.c_str(), b.c_str()) < 0;
    }
  };
  std::map<std::wstring, std::wstring, LessEnvironment> values;
  wchar_t* inherited = GetEnvironmentStringsW();
  if (!inherited)
    return unavailable("cannot read tool environment");
  for (const wchar_t* item = inherited; *item; item += wcslen(item) + 1) {
    std::wstring entry(item);
    auto equals = entry.find(L'=', 1);
    if (equals != entry.npos)
      values[entry.substr(0, equals)] = entry.substr(equals + 1);
  }
  FreeEnvironmentStringsW(inherited);
  for (const auto& [name, value] : environment)
    values[name] = value;
  std::wstring block;
  for (const auto& [name, value] : values) {
    block += name + L"=" + value;
    block += L'\0';
  }
  block += L'\0';
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
                      CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT |
                          EXTENDED_STARTUPINFO_PRESENT,
                      block.data(), working_directory.c_str(), &startup.StartupInfo, &process))
    return unavailable("cannot start document tool");
  Handle process_handle{process.hProcess};
  Handle thread{process.hThread};
  if (!AssignProcessToJobObject(job.value, process.hProcess) ||
      ResumeThread(process.hThread) == -1) {
    TerminateProcess(process.hProcess, 1);
    WaitForSingleObject(process.hProcess, INFINITE);
    return unavailable("cannot assign document tool job");
  }
  DWORD waited = WaitForSingleObject(process.hProcess, static_cast<DWORD>(timeout.count()));
  DWORD code = 1;
  TerminateJobObject(job.value, 1);
  WaitForSingleObject(process.hProcess, INFINITE);
  GetExitCodeProcess(process.hProcess, &code);
  // soffice.com owns a child soffice.bin. Wait for the entire job before
  // releasing its temporary input and output files.
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
  while (QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &accounting,
                                   sizeof(accounting), nullptr) &&
         accounting.ActiveProcesses) {
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  bool memory_exceeded = false;
  DWORD notification = 0;
  ULONG_PTR key = 0;
  LPOVERLAPPED data = nullptr;
  while (GetQueuedCompletionStatus(notifications.value, &notification, &key, &data, 0))
    memory_exceeded |= notification == JOB_OBJECT_MSG_JOB_MEMORY_LIMIT;
  if (memory_exceeded)
    return Error{ErrorCode::kRejected, "Document conversion exceeded job memory budget",
                 ErrorReason::kDocumentTooComplex};
  if (waited == WAIT_TIMEOUT) {
    LogToolFailure(executable, std::to_string(code), log, "timeout");
    return Error{ErrorCode::kRejected, "Document conversion exceeded compute budget",
                 ErrorReason::kDocumentTooComplex};
  }
  if (waited != WAIT_OBJECT_0)
    return Error{ErrorCode::kUnavailable, "Cannot wait for document tool"};
  if (code == STATUS_NO_MEMORY || code == ERROR_NOT_ENOUGH_MEMORY)
    return Error{ErrorCode::kRejected, "Document conversion exceeded memory budget",
                 ErrorReason::kDocumentTooComplex};
  if (code != 0)
    return ToolOutputFailure(log, executable, code);
  return {};
}
}  // namespace remotekit::documents
