#pragma once
#include "persistence/format_migrations.hpp"
#include "objects/store.hpp"
#include "util/result_macros.hpp"
#include <set>

namespace remotekit::checkpoint_formats {
inline constexpr uint64_t kChunk = 1024 * 1024;
inline bool SafePath(const std::string& text) {
  if (text.empty() || text.find('\\') != std::string::npos || text.find(':') != std::string::npos ||
      text.find('\0') != std::string::npos || text.back() == '/')
    return false;
  const auto path = Utf8Path(text);
  if (path.is_absolute() || path.has_root_path())
    return false;
  for (const auto& part : path)
    if (part == "." || part == ".." || part.empty() || part.native().back() == L'.' ||
        part.native().back() == L' ')
      return false;
  return text.find("//") == std::string::npos;
}
inline void ObjectId(const Json& value) {
  persisted::Require(objects::ValidId(persisted::Text(value)), "invalid object ID");
}
inline void ValidateCopy(const Json& value) {
  using namespace persisted;
  Keys(value,
       {"version", "sessionId", "placementEpoch", "base", "state", "stoppedCleanly", "changesAt",
        "lastCommit"},
       {"lastVersion"});
  Version(value.at("version"), 1);
  const auto& session = Text(value.at("sessionId"), 1, 128);
  Require(session.find_first_of("/\\:\0", 0, 4) == std::string::npos, "invalid session ID");
  Unsigned(value.at("placementEpoch"), 1);
  if (!value.at("base").is_null())
    ObjectId(value.at("base"));
  Enum(value.at("state"), {"clean", "dirty", "restoring"});
  Boolean(value.at("stoppedCleanly"));
  Unsigned(value.at("changesAt"));
  const auto& commit = value.at("lastCommit");
  if (!commit.is_null()) {
    Keys(commit, {"requestId", "manifestId"});
    Text(commit.at("requestId"), 1, 128);
    ObjectId(commit.at("manifestId"));
  }
  if (value.contains("lastVersion")) {
    const auto& version = value.at("lastVersion");
    Keys(version, {"manifestId", "takenAt", "kind"});
    ObjectId(version.at("manifestId"));
    Unsigned(version.at("takenAt"));
    Enum(version.at("kind"), {"running", "stopped"});
  }
}
inline void ValidateChanges(const Json& value) {
  using namespace persisted;
  Keys(value, {"version", "at", "paths", "removed", "subtrees", "continuous"});
  Version(value.at("version"), 1);
  Unsigned(value.at("at"));
  Boolean(value.at("continuous"));
  for (const auto name : {"paths", "removed", "subtrees"}) {
    Array(value.at(name), 1024 * 1024);
    std::set<std::string> paths;
    for (const auto& item : value.at(name)) {
      const auto& path = Text(item, 1, 32768);
      Require(SafePath(path) && paths.insert(path).second, "invalid or duplicate change path");
    }
  }
}
inline void ValidateManifest(const Json& value) {
  using namespace persisted;
  Keys(value, {"version", "buildId", "files", "directories"});
  Version(value.at("version"), 2);
  Text(value.at("buildId"), 1, 64);
  Array(value.at("files"), 1024 * 1024);
  Array(value.at("directories"), 1024 * 1024);
  std::set<std::string> paths;
  const auto path = [&](const Json& item) {
    const auto& name = Text(item, 1, 32768);
    Require(SafePath(name) && paths.insert(name).second, "invalid or duplicate checkpoint path");
  };
  for (const auto& item : value.at("directories"))
    path(item);
  for (const auto& file : value.at("files")) {
    Keys(file, {"path", "size", "chunks"});
    path(file.at("path"));
    const auto size = Unsigned(file.at("size"));
    Array(file.at("chunks"), 32768);
    Require(file.at("chunks").size() == std::max<uint64_t>(1, size / kChunk + (size % kChunk != 0)),
            "invalid checkpoint chunk count");
    for (const auto& id : file.at("chunks"))
      ObjectId(id);
  }
}
inline void ValidateEntries(const Json& value) {
  using namespace persisted;
  Require(value.is_object() && value.size() <= 1024 * 1024, "invalid index entries");
  for (const auto& [name, entry] : value.items()) {
    Require(SafePath(name), "invalid index path");
    if (entry.contains("directory")) {
      Keys(entry, {"directory"});
      Require(Boolean(entry.at("directory")), "invalid directory marker");
      continue;
    }
    Keys(entry, {"size", "mtime", "fileId"}, {"chunks", "objects"});
    const auto size = Unsigned(entry.at("size"));
    Unsigned(entry.at("mtime"), 0, UINT64_MAX);
    Text(entry.at("fileId"), 1, 128);
    if (entry.contains("chunks")) {
      Array(entry.at("chunks"), 32768);
      Require(
          entry.at("chunks").size() == std::max<uint64_t>(1, size / kChunk + (size % kChunk != 0)),
          "invalid index chunk count");
      for (const auto& id : entry.at("chunks"))
        ObjectId(id);
    }
    if (entry.contains("objects")) {
      Array(entry.at("objects"), 32768);
      Require(entry.contains("chunks") && entry.at("objects").size() == entry.at("chunks").size(),
              "invalid index objects");
      for (size_t i = 0; i < entry.at("objects").size(); ++i) {
        const auto& item = entry.at("objects")[i];
        Keys(item, {"objectId", "size", "storedSize", "storedSha256"});
        Require(item.at("objectId") == entry.at("chunks")[i], "index object mismatch");
        Unsigned(item.at("size"), 0, kChunk);
        Unsigned(item.at("storedSize"));
        ObjectId(item.at("storedSha256"));
      }
    }
  }
}
inline bool ValidEntries(const Json& value) {
  try {
    ValidateEntries(value);
    return true;
  } catch (const std::exception&) {
    return false;
  }
}
using Validator = void (*)(const Json&);
inline Result<Json> Decode(std::string_view bytes, Validator validate, persisted::Store store) {
  try {
    auto value = persisted::MigrateFormat(store, Json::parse(bytes));
    validate(value);
    return value;
  } catch (const std::exception& error) {
    return CorruptState(error.what());
  }
}
inline Result<std::string> Encode(const Json& value, Validator validate) {
  try {
    validate(value);
    return value.dump();
  } catch (const std::exception& error) {
    return CorruptState(error.what());
  }
}
// This index is a rebuildable cache. Invalid bytes return a null index.
inline Json DecodeIndex(std::string_view bytes) {
  try {
    const auto value = Json::parse(bytes);
    persisted::Keys(value, {"version", "entries"});
    persisted::Version(value.at("version"), 1);
    ValidateEntries(value.at("entries"));
    return value.at("entries");
  } catch (const std::exception&) {
    return Json();
  }
}
inline Result<Json> EncodeIndex(const Json& entries) {
  try {
    ValidateEntries(entries);
    return Json{{"version", 1}, {"entries", entries}};
  } catch (const std::exception& error) {
    return CorruptState(error.what());
  }
}
}  // namespace remotekit::checkpoint_formats
