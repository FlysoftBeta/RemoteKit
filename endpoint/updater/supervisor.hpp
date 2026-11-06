#pragma once
#include "platform.hpp"
namespace remotekit::updater {
int Supervise(const fs::path& root, HANDLE stop, bool service);
}  // namespace remotekit::updater
