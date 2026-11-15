#pragma once
#include "platform.hpp"
#include "util/log.hpp"
#include "../release/current.hpp"
#include "util/retry_unit.hpp"
namespace remotekit::updater {
Result<void> InstallBundled(const fs::path& root, const fs::path& package);
Result<release::CurrentState> ReadCurrent(const fs::path& root);
Json DecodeNodeRelease(std::string_view text);
// A node runtime directory is complete only after extraction; until then nothing may start from it.
bool RuntimeInstalled(const fs::path& runtime, const std::string& id);
struct DiscoverRelease {};
struct DownloadedRelease {
  Json descriptor;
  fs::path archive;
};
using UpdateStage = std::variant<DiscoverRelease, DownloadedRelease>;
// True means self-replacement launched a successor (or requests service recovery).
Result<bool> Update(const fs::path& root,
                    HANDLE stop,
                    bool service,
                    RetryUnit& retry,
                    UpdateStage& stage);
}  // namespace remotekit::updater
