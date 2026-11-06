#pragma once
#include "cluster/noise.hpp"
#include <functional>
namespace remotekit::updater {
using ArchiveRead = std::function<size_t(std::span<uint8_t>)>;
std::filesystem::path ExtendedPath(const std::filesystem::path& path);
// The destination must be a new, empty directory owned by the caller.
Result<void> ExtractTar(const ArchiveRead& read, const std::filesystem::path& destination);
Result<void> ExtractArchive(const std::filesystem::path& archive,
                            const std::filesystem::path& destination);
}  // namespace remotekit::updater
