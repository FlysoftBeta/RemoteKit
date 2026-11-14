#include "browser/sdk/sdk_logging.h"

#include <atomic>
#include <string>

#include "base/json/json_writer.h"
#include "base/logging/logging_settings.h"
#include "browser/log_record.h"

namespace remotekit::sdk {
namespace {
std::atomic<remotekit_sdk_log_fn> sink{nullptr};
void* sink_context = nullptr;

bool ChromiumLog(int severity,
                 const char* file,
                 int line,
                 size_t start,
                 const std::string& message) {
  const int level = severity < 0                           ? REMOTEKIT_SDK_LOG_DEBUG
                    : severity == logging::LOGGING_INFO    ? REMOTEKIT_SDK_LOG_INFO
                    : severity == logging::LOGGING_WARNING ? REMOTEKIT_SDK_LOG_WARN
                                                           : REMOTEKIT_SDK_LOG_ERROR;
  LogEvent(level, "chromium.log", ChromiumLogFields(severity, file, line, start, message));
  return true;
}

// Install at DLL load so records before set_log_sink are dropped as well.
[[maybe_unused]] const bool logging_installed = [] {
  logging::SetLogMessageHandler(ChromiumLog);
  logging::LoggingSettings settings;
  settings.logging_dest = logging::LOG_NONE;
  return logging::InitLogging(settings);
}();
}  // namespace

bool HasLogSink() {
  return sink.load(std::memory_order_acquire) != nullptr;
}

void InstallLogSink(remotekit_sdk_log_fn callback, void* context) {
  sink_context = context;
  sink.store(callback, std::memory_order_release);
}

void LogEvent(int level, std::string_view event, base::DictValue fields) {
  const auto callback = sink.load(std::memory_order_acquire);
  if (!callback)
    return;
  const auto json =
      base::WriteJsonWithOptions(fields, base::JSONWriter::OPTIONS_OMIT_DOUBLE_TYPE_PRESERVATION);
  if (json) {
    const std::string event_name(event);
    callback(sink_context, level, event_name.c_str(), json->c_str());
  }
}
}  // namespace remotekit::sdk
