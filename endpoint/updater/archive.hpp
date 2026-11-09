#pragma once
#include "cluster/noise.hpp"
#include <functional>
namespace remotekit::updater {
using ArchiveRead = std::function<size_t(std::span<uint8_t>)>;
using ArchiveWrite = std::function<void(std::span<const uint8_t>)>;
struct ArchiveEntry {
  std::string name;
  std::filesystem::path path;
  char type;
  uint64_t size;
  std::span<const uint8_t> raw_header;
};
using ArchiveRootRule = std::function<bool(std::string_view)>;
// CopyRaw consumes the complete record, including PAX, data and original padding.
// It must be called before reading data. Both readers are valid only during the visit.
using ArchiveCopy = std::function<void(const ArchiveWrite&)>;
using ArchiveVisitor =
    std::function<void(const ArchiveEntry&, const ArchiveRead&, const ArchiveCopy&)>;
Result<void> WalkTar(const ArchiveRead& read,
                     const ArchiveRootRule& root_rule,
                     const ArchiveVisitor& visitor);
std::filesystem::path ExtendedPath(const std::filesystem::path& path);
// The destination must be a new, empty directory owned by the caller.
Result<void> ExtractTar(const ArchiveRead& read, const std::filesystem::path& destination);
Result<void> ExtractArchive(const std::filesystem::path& archive,
                            const std::filesystem::path& destination);
}  // namespace remotekit::updater
