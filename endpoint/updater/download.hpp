#pragma once
#include "logging.hpp"
namespace remotekit::updater {
Result<void> InstallBundled(const fs::path& root, const fs::path& package);
std::string ReadCurrent(const fs::path& root);
// True means self-replacement launched a successor (or requests service recovery).
Result<bool> Update(const fs::path& root, HANDLE stop, Log& log, bool service);
}  // namespace remotekit::updater
