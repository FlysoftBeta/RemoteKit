#pragma once
#include "release/common.hpp"
namespace remotekit::manager {
updater::Handle Lock(const release::fs::path& root, HANDLE stop = nullptr, DWORD timeout = 0);
std::string Current(const release::fs::path& root);
void Cleanup(const release::fs::path& root, const std::string& current);
int Supervise(const release::fs::path& root, HANDLE stop, bool service);
}  // namespace remotekit::manager
