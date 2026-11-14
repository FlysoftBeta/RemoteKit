#pragma once
#include "logging.hpp"
#include "../release/current.hpp"
#include "util/retry_unit.hpp"
namespace remotekit::updater {
Result<void> InstallBundled(const fs::path& root, const fs::path& package);
Result<release::CurrentState> ReadCurrent(const fs::path& root);
Json DecodeNodeRelease(std::string_view text);
struct DiscoverRelease {};
struct DownloadedRelease {
  Json descriptor;
  fs::path archive;
};
using UpdateStage = std::variant<DiscoverRelease, DownloadedRelease>;
// True means self-replacement launched a successor (or requests service recovery).
Result<bool> Update(const fs::path& root,
                    HANDLE stop,
                    Log& log,
                    bool service,
                    RetryUnit& retry,
                    UpdateStage& stage);
}  // namespace remotekit::updater
