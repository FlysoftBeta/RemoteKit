#pragma once
#include "util/common.hpp"
#include "util/error.hpp"
#include "protocol/limits.hpp"
#include <cstdint>
#include <vector>
namespace remotekit {
inline constexpr uint64_t kLogWindowBytes = limits::logWindowBytes;
Result<Json> SearchErrorLogs(const fs::path& node_root, const std::string& error_id);
Result<Json> NodeLogDays(const fs::path& logs_root);
Result<Json> NodeLogList(const fs::path& logs_root, const std::string& date);
// The returned data member is a JSON binary value; send it as the frame payload.
Result<Json> ReadNodeLog(const fs::path& logs_root, const Json& params);
Result<fs::path> ValidateLogPath(const fs::path& logs_root, const std::string& relative);
Result<void> DeleteSessionLogs(const fs::path& node_root, const std::string& session_id);
std::vector<fs::path> RecentCrashDumps(const fs::path& directory);
std::string LastBrowserFatal(const fs::path& logs_root, const std::string& session_id);
}  // namespace remotekit
