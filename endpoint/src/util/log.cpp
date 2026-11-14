#include "util/log.hpp"
#include <windows.h>
#include <bcrypt.h>
#include <array>
#include <cstdio>
#include <mutex>
#include <stdexcept>
#include <ctime>
#include <set>
#include <fstream>
#include "crash/crash.hpp"

namespace remotekit {
namespace {
std::mutex output_mutex;
std::mutex error_mutex;
std::unique_ptr<DailyLog> writer;
std::string process_name = "endpoint";
const char* LevelName(LogLevel level) {
  switch (level) {
    case LogLevel::kDebug:
      return "debug";
    case LogLevel::kInfo:
      return "info";
    case LogLevel::kWarn:
      return "warn";
    case LogLevel::kError:
      return "error";
  }
  std::terminate();
}
}  // namespace
std::string LocalLogDate(LogClock::time_point now) {
  const auto time = LogClock::to_time_t(now);
  std::tm local{};
  localtime_s(&local, &time);
  char date[16];
  strftime(date, sizeof(date), "%Y-%m-%d", &local);
  return date;
}
bool ValidLogDate(std::string_view date) {
  if (date.size() != 10 || date[4] != '-' || date[7] != '-')
    return false;
  for (size_t i = 0; i < date.size(); ++i)
    if (i != 4 && i != 7 && (date[i] < '0' || date[i] > '9'))
      return false;
  const auto number = [](std::string_view text) { return std::stoi(std::string(text)); };
  return std::chrono::year_month_day(std::chrono::year(number(date.substr(0, 4))),
                                     std::chrono::month(number(date.substr(5, 2))),
                                     std::chrono::day(number(date.substr(8, 2))))
      .ok();
}
std::string FormatLogRecord(LogLevel level, std::string_view event, Json fields) {
  SYSTEMTIME now{};
  GetSystemTime(&now);
  char timestamp[32];
  snprintf(timestamp, sizeof(timestamp), "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ", now.wYear,
           now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond, now.wMilliseconds);
  if (!fields.is_object())
    fields = Json::object();
  fields["ts"] = timestamp;
  fields["lvl"] = LevelName(level);
  fields["ev"] = event;
  if (!fields.contains("proc"))
    fields["proc"] = process_name;
  if (!fields.contains("pid"))
    fields["pid"] = GetCurrentProcessId();
  return fields.dump(-1, ' ', false, Json::error_handler_t::replace) + "\n";
}
DailyLog::DailyLog(fs::path root,
                   std::string proc,
                   uint32_t pid,
                   std::function<LogClock::time_point()> clock,
                   uint64_t part_limit,
                   uint64_t daily_limit)
    : root_(std::move(root)),
      proc_(std::move(proc)),
      pid_(pid),
      clock_(std::move(clock)),
      part_limit_(part_limit),
      daily_limit_(daily_limit) {}
void DailyLog::Write(LogLevel level, std::string_view event, Json fields) {
  if (level == LogLevel::kDebug)
    return;
  std::lock_guard lock(mutex_);
  const auto date = LocalLogDate(clock_());
  const auto directory = root_ / date;
  const auto path = [&] {
    return directory / (proc_ + (part_ ? "." + std::to_string(part_) : "") + ".jsonl");
  };
  std::error_code error;
  fs::create_directories(directory, error);
  if (error)
    return;
  if (date != date_) {
    date_ = date;
    total_ = size_ = part_ = 0;
    exhausted_ = false;
    for (;;) {
      const auto bytes = fs::file_size(path(), error);
      if (error)
        break;
      size_ = bytes;
      total_ += bytes;
      ++part_;
    }
    if (part_)
      --part_;
    // The budget marker survives a process restart in the same day.
    std::ifstream tail(path(), std::ios::binary);
    if (tail && size_) {
      tail.seekg(static_cast<std::streamoff>(size_ > 4096 ? size_ - 4096 : 0));
      std::string text((std::istreambuf_iterator<char>(tail)), {});
      exhausted_ = daily_limit_ != UINT64_MAX &&
                   text.find("\"ev\":\"log.budget_exhausted\"") != std::string::npos;
    }
  }
  if (exhausted_)
    return;
  if (!fields.is_object())
    fields = Json::object();
  if (!fields.contains("proc"))
    fields["proc"] = proc_;
  if (!fields.contains("pid"))
    fields["pid"] = pid_;
  auto line = FormatLogRecord(level, event, std::move(fields));
  const auto marker =
      FormatLogRecord(LogLevel::kWarn, "log.budget_exhausted", {{"proc", proc_}, {"pid", pid_}});
  if (total_ + line.size() + marker.size() > daily_limit_) {
    exhausted_ = true;
    line = marker;
    if (total_ + line.size() > daily_limit_)
      return;
  }
  if (size_ && size_ + line.size() > part_limit_) {
    ++part_;
    size_ = 0;
  }
  if (AppendLogRecord(path(), line)) {
    size_ += line.size();
    total_ += line.size();
  }
}
bool AppendLogRecord(const fs::path& path, std::string_view line) {
  const auto file = CreateFileW(path.c_str(), FILE_APPEND_DATA,
                                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                                OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE)
    return false;
  DWORD written = 0;
  const bool ok = WriteFile(file, line.data(), static_cast<DWORD>(line.size()), &written, nullptr);
  CloseHandle(file);
  return ok && written == line.size();
}

void InitLog(const fs::path& logs_root, std::string proc) {
  std::lock_guard lock(output_mutex);
  if (writer)
    return;
  process_name = std::move(proc);
  writer = std::make_unique<DailyLog>(logs_root, process_name, GetCurrentProcessId());
}
void LogEvent(LogLevel level, std::string_view event, Json fields) {
  std::lock_guard lock(output_mutex);
  if (writer) {
    writer->Write(level, event, std::move(fields));
    return;
  }
  if (level == LogLevel::kDebug)
    return;
  const auto line = FormatLogRecord(level, event, std::move(fields));
  fwrite(line.data(), 1, line.size(), stderr);
  fflush(stderr);
}
void PruneLogs(const fs::path& root,
               unsigned retention_days,
               std::string today,
               const std::set<std::string>& active_crashpad_sessions) {
  if (!ValidLogDate(today))
    return;
  std::tm bound{};
  bound.tm_year = std::stoi(today.substr(0, 4)) - 1900;
  bound.tm_mon = std::stoi(today.substr(5, 2)) - 1;
  bound.tm_mday = std::stoi(today.substr(8, 2)) - static_cast<int>(retention_days);
  bound.tm_isdst = -1;
  const auto cutoff = LogClock::from_time_t(mktime(&bound));
  const auto date = LocalLogDate(cutoff);
  std::set<std::pair<std::string, int>> failures;
  const auto report = [&](const char* kind, const std::error_code& error) {
    if (error && failures.emplace(kind, error.value()).second)
      LogError(LogLevel::kWarn, "log.prune_failed",
               WithOsError(ErrorCode::kUnavailable, kind, OsError::Kind::kWin32, error.value()));
  };
  const auto reparse = [&](const fs::path& path) {
    const auto attributes = GetFileAttributesW(path.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES) {
      const auto code = GetLastError();
      if (code != ERROR_FILE_NOT_FOUND && code != ERROR_PATH_NOT_FOUND)
        report("attributes", std::error_code(code, std::system_category()));
      return true;
    }
    return (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
  };
  // Enumerate each directory independently so a locked entry cannot stop other deletions.
  const auto remove_tree = [&](auto&& self, const fs::path& directory) -> void {
    std::error_code error;
    for (fs::directory_iterator it(directory, error), end; !error && it != end;
         it.increment(error)) {
      const auto path = it->path();
      if (reparse(path))
        continue;
      if (it->is_directory(error))
        self(self, path);
      else {
        fs::remove(path, error);
        report("remove_file", error);
        error.clear();
      }
    }
    report("enumerate", error);
    fs::remove(directory, error);
    report("remove_directory", error);
  };
  std::error_code error;
  if (reparse(root))
    return;
  for (fs::directory_iterator it(root, error), end; !error && it != end; it.increment(error)) {
    const auto name = it->path().filename().string();
    if (ValidLogDate(name) && name < date && !reparse(it->path()) && it->is_directory(error))
      remove_tree(remove_tree, it->path());
  }
  report("enumerate", error);
  const auto crashes = root / "crashes";
  if (reparse(crashes))
    return;
  const auto prune_crashes = [&](auto&& self, const fs::path& directory, bool crashpad) -> void {
    std::error_code ec;
    for (fs::directory_iterator it(directory, ec), end; !ec && it != end; it.increment(ec)) {
      if (reparse(it->path()))
        continue;
      if (it->is_directory(ec)) {
        const auto name = it->path().filename().string();
        const bool database =
            crashpad || (directory == crashes && active_crashpad_sessions.contains(name));
        self(self, it->path(), database);
      } else if (!crashpad || it->path().extension() == ".dmp" ||
                 it->path().filename() == "events.jsonl") {
        const auto time = it->last_write_time(ec);
        if (!ec && std::chrono::clock_cast<LogClock>(time) < cutoff) {
          fs::remove(it->path(), ec);
          report("remove_crash", ec);
        }
        report("inspect_crash", ec);
        ec.clear();
      }
    }
    report("enumerate_crashes", ec);
  };
  prune_crashes(prune_crashes, crashes, false);
}
void LogProcessExit(std::string_view child, uint32_t pid, uint32_t code, bool record_crash) {
  if (!code)
    return;
  Json fields{{"code", code}};
  if (record_crash && code >= 0xC0000000) {
    fields.update({{"proc", child}, {"pid", pid}, {"codeName", ExceptionCodeName(code)}});
    LogEvent(LogLevel::kError, "process.crashed", std::move(fields));
  } else {
    fields.update({{"child", child}, {"childPid", pid}});
    if (code >= 0xC0000000 || code == EXCEPTION_BREAKPOINT)
      fields["codeName"] = ExceptionCodeName(code);
    LogEvent(LogLevel::kWarn, "process.exited", std::move(fields));
  }
}
ProcessOutput::ProcessOutput(std::string child, uint32_t pid, std::string stream)
    : child_(std::move(child)), stream_(std::move(stream)), pid_(pid) {}
ProcessOutput::~ProcessOutput() {
  Flush();
}
void ProcessOutput::Append(std::string_view bytes) {
  pending_.append(bytes);
  size_t end;
  while ((end = pending_.find('\n')) != std::string::npos) {
    auto text = pending_.substr(0, end);
    if (!text.empty() && text.back() == '\r')
      text.pop_back();
    LogEvent(LogLevel::kWarn, "process.output",
             {{"child", child_}, {"childPid", pid_}, {"stream", stream_}, {"text", text}});
    pending_.erase(0, end + 1);
  }
}
void ProcessOutput::Flush() {
  if (pending_.empty())
    return;
  LogEvent(LogLevel::kWarn, "process.output",
           {{"child", child_}, {"childPid", pid_}, {"stream", stream_}, {"text", pending_}});
  pending_.clear();
}
Json LogErrorFields(const Error& error, Json fields) {
  if (fields.is_null())
    fields = Json::object();
  Json detail = {{"code", ErrorCodeName(error.code)}, {"message", error.message}};
  if (error.reason)
    detail["reason"] = ErrorReasonName(*error.reason);
  if (!error.error_id.empty())
    detail["errorId"] = error.error_id;
  if (error.os) {
    const char* kind = error.os->kind == OsError::Kind::kWin32     ? "win32"
                       : error.os->kind == OsError::Kind::kHresult ? "hresult"
                                                                   : "sqlite";
    detail["os"] = {{"kind", kind}, {"value", error.os->value}};
  }
  fields["err"] = std::move(detail);
  return fields;
}
void LogError(LogLevel level, std::string_view event, const Error& error, Json fields) {
  LogEvent(level, event, LogErrorFields(error, std::move(fields)));
}
std::string NewErrorId() {
  std::array<unsigned char, 5> bytes{};
  if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()),
                      BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0)
    throw std::runtime_error("cannot generate error id");
  constexpr char digits[] = "0123456789abcdef";
  std::string result = "e-";
  for (const auto byte : bytes) {
    result += digits[byte >> 4];
    result += digits[byte & 15];
  }
  return result;
}
Json RequestLogFields(const Json& request, Json fields) {
  if (!request.is_object())
    return fields;
  const auto method = request.find("method");
  if (method != request.end() && method->is_string())
    fields["method"] = *method;
  else if (request.value("type", Json()).is_string())
    fields["method"] = request["type"];
  if (request.value("action", Json()).is_object() &&
      request["action"].value("type", Json()).is_string())
    fields["method"] = request["action"]["type"];
  for (const auto* name : {"tenantId", "sessionId", "viewId"})
    if (!fields.contains(name) && request.contains(name) && request[name].is_string())
      fields[name] = request[name];
  return fields;
}
bool ValidErrorId(std::string_view id) {
  if (id.size() != 12 || (id[0] != 'c' && id[0] != 'e') || id[1] != '-')
    return false;
  for (const auto c : id.substr(2))
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')))
      return false;
  return true;
}
void ReportError(const Error& error, std::string_view event, Json fields) {
  if (error.code != ErrorCode::kInternal && error.code != ErrorCode::kOutcomeUnknown &&
      error.code != ErrorCode::kUnavailable)
    return;
  std::lock_guard lock(error_mutex);
  if (!error.error_id.empty())
    return;
  error.error_id = NewErrorId();
  LogError(LogLevel::kError, event, error, std::move(fields));
}
}  // namespace remotekit
