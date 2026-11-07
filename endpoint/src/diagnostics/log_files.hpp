#pragma once
#include "util/common.hpp"
#include "util/error.hpp"
#include <cstdint>
#include <optional>
namespace remotekit {
inline constexpr uint64_t kLogWindowBytes = 512 * 1024;
// Reads [max(0, end - max_bytes), end) of a log another process may still be
// appending to or rotating. `end` defaults to the size observed at open, so a
// caller walking backwards from that size reads one consistent prefix.
// Reply: {exists, size, start, end, data(base64)}; a missing file is exists=false.
Result<Json> ReadLogWindow(const fs::path& path, std::optional<uint64_t> end, uint64_t max_bytes);
}  // namespace remotekit
