#pragma once
#include "platform.hpp"
namespace remotekit::updater {
int RunService(const fs::path& root);
Result<void> InstallService(const fs::path& root);
Result<void> UninstallService();
}  // namespace remotekit::updater
