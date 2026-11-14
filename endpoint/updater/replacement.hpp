#pragma once
#include "logging.hpp"
namespace remotekit::updater {
Result<bool> ReplaceExecutable(const fs::path& installed,
                               const fs::path& replacement,
                               const fs::path& root,
                               const std::wstring& arguments,
                               bool service,
                               Log& log);
void CleanupRuntime(const fs::path& root, const std::string& current, bool downloads);
void CleanupRuntimeBestEffort(const fs::path& root, const std::string& current, Log& log) noexcept;
}  // namespace remotekit::updater
