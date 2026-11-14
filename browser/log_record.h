#pragma once

#include <string>

#include "base/logging.h"
#include "base/values.h"

namespace remotekit {
inline const char* LogSeverityName(int severity) {
  switch (severity) {
    case logging::LOGGING_INFO:
      return "INFO";
    case logging::LOGGING_WARNING:
      return "WARNING";
    case logging::LOGGING_ERROR:
      return "ERROR";
    case logging::LOGGING_FATAL:
      return "FATAL";
    default:
      return "VERBOSE";
  }
}

inline base::DictValue ChromiumLogFields(int severity,
                                         const char* file,
                                         int line,
                                         size_t message_start,
                                         const std::string& formatted) {
  auto message = formatted.substr(message_start);
  if (!message.empty() && message.back() == '\n')
    message.pop_back();
  return base::DictValue()
      .Set("severity", LogSeverityName(severity))
      .Set("file", file)
      .Set("line", line)
      .Set("message", std::move(message));
}
}  // namespace remotekit
