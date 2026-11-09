#pragma once
#include "logging.hpp"
namespace remotekit::updater {
struct Service {
  const wchar_t* name;
  const wchar_t* display_name;
  const wchar_t* executable;
  int (*supervise)(const fs::path&, HANDLE, bool);
};
int RunService(const fs::path& root, const Service& service);
Result<void> InstallService(const fs::path& root, const Service& service);
Result<void> UninstallService(const Service& service);
}  // namespace remotekit::updater
