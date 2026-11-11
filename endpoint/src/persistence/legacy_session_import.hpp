#pragma once
#include "util/error.hpp"
#include <filesystem>
namespace remotekit {
Result<void> ImportLegacySession(const std::filesystem::path& directory);
}
