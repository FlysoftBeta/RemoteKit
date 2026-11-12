#pragma once
#include "persistence/checkpoint.hpp"

namespace remotekit {
inline bool VersionDue(bool running,
                       const DirectoryChanges& changes,
                       int64_t now,
                       int64_t last_version_or_open,
                       int64_t interval = 300000) {
  return running && (!changes.continuous || !changes.paths.empty()) &&
         now - last_version_or_open >= interval;
}
inline int64_t VersionNow() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}
inline Result<Json> SnapshotEntries(const Json& files, const std::string& prefix) {
  Json entries = Json::object();
  for (auto item : files) {
    const auto path = item.at("path").get<std::string>();
    if (!path.starts_with(prefix + "/") || item.value("missing", false))
      continue;
    const auto name = path.substr(prefix.size() + 1);
    const auto relative = Utf8Path(name);
    bool excluded = false;
    fs::path partial;
    for (const auto& part : relative) {
      partial /= part;
      excluded |=
          Checkpoints::Excluded(partial, partial != relative || item.value("directory", false));
    }
    if (excluded)
      continue;
    item.erase("path");
    entries[name] = std::move(item);
  }
  return entries;
}
}  // namespace remotekit
