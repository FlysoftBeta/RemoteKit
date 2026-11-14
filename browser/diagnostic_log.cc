#include "browser/diagnostic_log.h"

#include <mutex>
#include <string>

#include "base/command_line.h"
#include "base/json/json_writer.h"
#include "base/logging/logging_settings.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/stringprintf.h"
#include "base/time/time.h"
#include "base/win/scoped_handle.h"
#include "browser/log_record.h"

namespace remotekit::browser {
namespace {
constexpr int64_t kPartBytes = 64ll * 1024 * 1024;
constexpr uint64_t kDayBytes = 1024ull * 1024 * 1024;

std::string LocalDay(base::Time now) {
  base::Time::Exploded exploded;
  now.LocalExplode(&exploded);
  return base::StringPrintf("%04d-%02d-%02d", exploded.year, exploded.month, exploded.day_of_month);
}

// Logging also runs on threads where Chromium disallows ordinary file work.
// Keep file operations on the same Win32 append path as the writes themselves.
bool CreateLogDirectory(const base::FilePath& path) {
  if (CreateDirectoryW(path.value().c_str(), nullptr))
    return true;
  const auto error = GetLastError();
  if (error == ERROR_ALREADY_EXISTS)
    return true;
  if (error != ERROR_PATH_NOT_FOUND || path == path.DirName() ||
      !CreateLogDirectory(path.DirName()))
    return false;
  return CreateDirectoryW(path.value().c_str(), nullptr) || GetLastError() == ERROR_ALREADY_EXISTS;
}

class DiagnosticLog {
 public:
  bool Initialize() {
    const auto& command = *base::CommandLine::ForCurrentProcess();
    root_ = command.GetSwitchValuePath("log-dir");
    session_ = command.GetSwitchValueASCII("tenant-id");
    process_ = command.GetSwitchValueASCII("type");
    child_ = !process_.empty();
    if (!child_)
      process_ = "browser";
    else if (process_ == "gpu-process")
      process_ = "gpu";
    if (child_) {
      uint64_t handle = 0;
      if (!base::StringToUint64(command.GetSwitchValueASCII("log-handle"), &handle) || !handle)
        return true;
      file_.Set(reinterpret_cast<HANDLE>(static_cast<uintptr_t>(handle)));
      return true;
    }
    if (root_.empty())
      return true;
    if (!root_.IsAbsolute() || session_.empty() ||
        session_.find_first_not_of(
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_") !=
            std::string::npos)
      return false;
    std::lock_guard lock(mutex_);
    return SelectFile(base::Time::Now());
  }

  void Append(std::string_view level, std::string_view event, base::DictValue fields) {
    std::lock_guard lock(mutex_);
    const auto now = base::Time::Now();
    const auto day = LocalDay(now);
    if (child_) {
      if (day != day_) {
        day_ = day;
        bytes_ = 0;
        exhausted_ = false;
      }
    } else if (!root_.empty() && !SelectFile(now)) {
      return;
    }
    if (!file_.is_valid() || exhausted_)
      return;
    auto record = Record(now, level, event, std::move(fields));
    // base::Value has no 64-bit integer; pids, codes and byte counts are integral doubles.
    auto json =
        base::WriteJsonWithOptions(record, base::JSONWriter::OPTIONS_OMIT_DOUBLE_TYPE_PRESERVATION);
    if (!json)
      return;
    json->push_back('\n');
    if (bytes_ + json->size() > kDayBytes) {
      exhausted_ = true;
      auto budget =
          base::WriteJsonWithOptions(Record(now, "warn", "log.budget_exhausted", {}),
                                     base::JSONWriter::OPTIONS_OMIT_DOUBLE_TYPE_PRESERVATION);
      if (budget) {
        budget->push_back('\n');
        Write(*budget);
      }
      return;
    }
    Write(*json);
    bytes_ += json->size();
  }

  HANDLE Duplicate(base::FilePath* path) {
    std::lock_guard lock(mutex_);
    if (!root_.empty() && !SelectFile(base::Time::Now()))
      return nullptr;
    HANDLE handle = nullptr;
    if (file_.is_valid()) {
      *path = path_;
      DuplicateHandle(GetCurrentProcess(), file_.get(), GetCurrentProcess(), &handle, 0, TRUE,
                      DUPLICATE_SAME_ACCESS);
    }
    return handle;
  }

 private:
  base::DictValue Record(base::Time now,
                         std::string_view level,
                         std::string_view event,
                         base::DictValue fields) {
    base::Time::Exploded utc;
    now.UTCExplode(&utc);
    fields.Set("ts", base::StringPrintf("%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", utc.year, utc.month,
                                        utc.day_of_month, utc.hour, utc.minute, utc.second,
                                        utc.millisecond));
    fields.Set("lvl", level);
    fields.Set("ev", event);
    fields.Set("proc", "browser");
    if (!fields.contains("pid"))
      fields.Set("pid", static_cast<double>(GetCurrentProcessId()));
    fields.Set("sessionId", session_);
    if (!fields.contains("process"))
      fields.Set("process", process_);
    return fields;
  }

  bool SelectFile(base::Time now) {
    const auto day = LocalDay(now);
    if (day != day_) {
      day_ = day;
      part_ = 0;
      bytes_ = 0;
      exhausted_ = false;
      file_.Close();
      directory_ = root_.AppendASCII(day);
      if (!CreateLogDirectory(directory_))
        return false;
      const auto pattern = directory_.AppendASCII("browser-" + session_ + "*.jsonl");
      WIN32_FIND_DATAW info{};
      const auto search = FindFirstFileW(pattern.value().c_str(), &info);
      if (search != INVALID_HANDLE_VALUE) {
        do {
          if (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
            continue;
          const auto name = base::FilePath(info.cFileName).RemoveExtension().AsUTF8Unsafe();
          const auto stem = "browser-" + session_;
          unsigned part = 0;
          if (name != stem && (!name.starts_with(stem + ".") ||
                               !base::StringToUint(name.substr(stem.size() + 1), &part)))
            continue;
          part_ = std::max(part_, part);
          bytes_ += (static_cast<uint64_t>(info.nFileSizeHigh) << 32) | info.nFileSizeLow;
        } while (FindNextFileW(search, &info));
        FindClose(search);
      }
    }
    LARGE_INTEGER size{};
    if (file_.is_valid() && GetFileSizeEx(file_.get(), &size) && size.QuadPart < kPartBytes)
      return true;
    if (file_.is_valid()) {
      ++part_;
      file_.Close();
    }
    for (;;) {
      auto name = "browser-" + session_;
      if (part_)
        name += "." + base::NumberToString(part_);
      const auto path = directory_.AppendASCII(name + ".jsonl");
      path_ = path;
      file_.Set(CreateFileW(path.value().c_str(),
                            FILE_APPEND_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                            OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
      if (!file_.is_valid())
        return false;
      if (!GetFileSizeEx(file_.get(), &size) || size.QuadPart < kPartBytes)
        return true;
      file_.Close();
      ++part_;
    }
  }

  void Write(const std::string& line) {
    DWORD written = 0;
    WriteFile(file_.get(), line.data(), static_cast<DWORD>(line.size()), &written, nullptr);
  }

  std::mutex mutex_;
  base::win::ScopedHandle file_;
  base::FilePath root_, directory_, path_;
  std::string session_, process_, day_;
  unsigned part_ = 0;
  uint64_t bytes_ = 0;
  bool child_ = false;
  bool exhausted_ = false;
};

DiagnosticLog& Writer() {
  static base::NoDestructor<DiagnosticLog> writer;
  return *writer;
}

bool ChromiumLog(int severity,
                 const char* file,
                 int line,
                 size_t start,
                 const std::string& message) {
  const char* level = severity < 0                           ? "debug"
                      : severity == logging::LOGGING_INFO    ? "info"
                      : severity == logging::LOGGING_WARNING ? "warn"
                                                             : "error";
  LogEvent(level, "chromium.log", ChromiumLogFields(severity, file, line, start, message));
  return true;
}
}  // namespace

bool InitializeDiagnosticLog() {
  logging::SetLogMessageHandler(ChromiumLog);
  logging::LoggingSettings settings;
  settings.logging_dest = logging::LOG_NONE;
  logging::InitLogging(settings);
  return Writer().Initialize();
}

HANDLE DuplicateDiagnosticLogHandle(base::FilePath* path) {
  return Writer().Duplicate(path);
}

void LogEvent(std::string_view level, std::string_view event, base::DictValue fields) {
  Writer().Append(level, event, std::move(fields));
}
}  // namespace remotekit::browser
