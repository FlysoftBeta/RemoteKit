#pragma once

#include <windows.h>

#include <string_view>

#include "base/files/file_path.h"
#include "base/values.h"

namespace remotekit::browser {
bool InitializeDiagnosticLog();
// The launcher owns this inheritable duplicate until CreateProcess completes.
HANDLE DuplicateDiagnosticLogHandle(base::FilePath* path);
void LogEvent(std::string_view level, std::string_view event, base::DictValue fields = {});
}  // namespace remotekit::browser
