#pragma once

#include <string_view>

#include "base/values.h"
#include "remotekit/sdk/include/remotekit_sdk.h"

namespace remotekit::sdk {
bool HasLogSink();
void InstallLogSink(remotekit_sdk_log_fn sink, void* context);
void LogEvent(int level, std::string_view event, base::DictValue fields);
}  // namespace remotekit::sdk
