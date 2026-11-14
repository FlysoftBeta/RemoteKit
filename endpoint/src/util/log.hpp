#pragma once
#include "util/common.hpp"
#include "util/error.hpp"
#include <string_view>
#include <functional>
#include <memory>
#include <mutex>
#include <chrono>
#include <set>
namespace remotekit {
enum class LogLevel { kDebug, kInfo, kWarn, kError };
using LogClock = std::chrono::system_clock;
std::string LocalLogDate(LogClock::time_point now = LogClock::now());
bool ValidLogDate(std::string_view date);
class DailyLog {
 public:
  DailyLog(fs::path root,
           std::string proc,
           uint32_t pid,
           std::function<LogClock::time_point()> clock = LogClock::now,
           uint64_t part_limit = 64 * 1024 * 1024,
           uint64_t daily_limit = 1024 * 1024 * 1024);
  void Write(LogLevel level, std::string_view event, Json fields = Json::object());

 private:
  fs::path root_;
  std::string proc_, date_;
  uint32_t pid_;
  std::function<LogClock::time_point()> clock_;
  uint64_t part_limit_, daily_limit_, total_ = 0, size_ = 0;
  unsigned part_ = 0;
  bool exhausted_ = false;
  std::mutex mutex_;
};
bool AppendLogRecord(const fs::path& path, std::string_view line);
void InitLog(const fs::path& logs_root, std::string proc);
void PruneLogs(const fs::path& root,
               unsigned retention_days,
               std::string today = LocalLogDate(),
               const std::set<std::string>& active_crashpad_sessions = {});
void LogProcessExit(std::string_view child, uint32_t pid, uint32_t code, bool record_crash = false);
class ProcessOutput {
 public:
  ProcessOutput(std::string child, uint32_t pid, std::string stream);
  ~ProcessOutput();
  void Append(std::string_view bytes);
  void Flush();

 private:
  std::string child_, stream_, pending_;
  uint32_t pid_;
};
std::string FormatLogRecord(LogLevel level, std::string_view event, Json fields = Json::object());
void LogEvent(LogLevel level, std::string_view event, Json fields = Json::object());
Json LogErrorFields(const Error& error, Json fields = Json::object());
void LogError(LogLevel level,
              std::string_view event,
              const Error& error,
              Json fields = Json::object());
std::string NewErrorId();
void ReportError(const Error& error, std::string_view event, Json fields = Json::object());
Json RequestLogFields(const Json& request, Json fields = Json::object());
bool ValidErrorId(std::string_view id);
}  // namespace remotekit
