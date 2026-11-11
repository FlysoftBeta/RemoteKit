#include "util/log.hpp"
#include <windows.h>
#include <bcrypt.h>
#include <array>
#include <cstdio>
#include <mutex>
#include <stdexcept>

namespace remotekit {
namespace {
std::mutex output_mutex;
std::mutex error_mutex;
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
std::string FormatLogRecord(LogLevel level, std::string_view event, Json fields) {
  SYSTEMTIME now{};
  GetSystemTime(&now);
  char timestamp[32];
  snprintf(timestamp, sizeof(timestamp), "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ", now.wYear,
           now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond, now.wMilliseconds);
  if (fields.is_null())
    fields = Json::object();
  fields["ts"] = timestamp;
  fields["lvl"] = LevelName(level);
  fields["ev"] = event;
  return fields.dump(-1, ' ', false, Json::error_handler_t::replace) + "\n";
}
void LogEvent(LogLevel level, std::string_view event, Json fields) {
  const auto line = FormatLogRecord(level, event, std::move(fields));
  std::lock_guard lock(output_mutex);
  fwrite(line.data(), 1, line.size(), stderr);
  fflush(stderr);
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
