#pragma once
#include "manifest.hpp"
namespace remotekit::release {
std::string PayloadBuildId(const fs::path& tar);
// kMove takes the manager's own work file; kCopy leaves an operator-supplied tar in place.
enum class PayloadSource { kMove, kCopy };
fs::path InstallPayload(const fs::path& root,
                        const fs::path& tar,
                        const std::string& expected,
                        PayloadSource source);
}  // namespace remotekit::release
