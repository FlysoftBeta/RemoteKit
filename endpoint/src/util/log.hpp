#pragma once
#include "util/common.hpp"
#include "util/error.hpp"
#include <string_view>
namespace remotekit {
enum class LogLevel { kDebug, kInfo, kWarn, kError };
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
