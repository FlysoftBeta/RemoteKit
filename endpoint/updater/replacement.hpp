#pragma once
#include "platform.hpp"
#include "util/log.hpp"
namespace remotekit::updater {
Result<bool> ReplaceExecutable(const fs::path& installed,
                               const fs::path& replacement,
                               const fs::path& root,
                               const std::wstring& arguments,
                               bool service);
void CleanupRuntime(const fs::path& root, const std::string& current, bool downloads);
void CleanupRuntimeBestEffort(const fs::path& root, const std::string& current) noexcept;
}  // namespace remotekit::updater
