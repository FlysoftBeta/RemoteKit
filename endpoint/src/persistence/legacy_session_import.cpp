#include "persistence/legacy_session_import.hpp"
#include "persistence/session_db.hpp"
#include "files/library_records.hpp"
#include "session/view_configuration.hpp"
#include "util/file_io.hpp"
#include "util/result_macros.hpp"
#include <windows.h>
#include <charconv>
namespace remotekit {
namespace {
struct LegacyFile {
  fs::path path;
  std::string kind, id;
};
Result<Json> ReadLegacy(const fs::path& path) {
  RK_ASSIGN_OR_RETURN(bytes, ReadFileIfExists(path));
  if (!bytes)
    return Error{ErrorCode::kUnavailable, "legacy session file disappeared: " + path.string()};
  auto value = Json::parse(*bytes, nullptr, false);
  if (value.is_discarded())
    return CorruptState("invalid legacy session file: " + path.string());
  return value;
}
Result<int64_t> EventId(const Json& value) {
  const auto& text = value.get_ref<const std::string&>();
  int64_t id = 0;
  const auto parsed = std::from_chars(text.data(), text.data() + text.size(), id);
  if (parsed.ec != std::errc{} || parsed.ptr != text.data() + text.size() || id <= 0 ||
      text.front() == '0')
    return CorruptState("invalid legacy event id");
  return id;
}
}  // namespace
Result<void> ImportLegacySession(const fs::path& directory) {
  RK_ASSIGN_OR_RETURN(present, FileExists(directory / "session.db"));
  std::vector<LegacyFile> files;
  std::vector<fs::path> temporary;
  for (const auto* name :
       {"views.json", "events.json", "download-imports.json", "site-preferences.json"}) {
    RK_ASSIGN_OR_RETURN(exists, FileExists(directory / name));
    if (exists)
      files.push_back({directory / name, name, {}});
    RK_ASSIGN_OR_RETURN(temp, FileExists(directory / (std::string(name) + ".new")));
    if (temp)
      temporary.push_back(directory / (std::string(name) + ".new"));
  }
  for (const auto* kind : {"recovery", "metadata", "drafts", "selections", "derivatives"}) {
    const auto folder =
        std::string(kind) == "recovery" ? directory / kind : directory / "file-library" / kind;
    RK_ASSIGN_OR_RETURN(exists, FileExists(folder));
    if (!exists)
      continue;
    RK_ASSIGN_OR_RETURN(entries, DirectoryEntries(folder));
    for (const auto& entry : entries) {
      if (entry.path().extension() == ".new")
        temporary.push_back(entry.path());
      else if (entry.path().extension() != ".json" || !entry.is_regular_file())
        return CorruptState("invalid legacy session file: " + entry.path().string());
      else
        files.push_back({entry.path(), kind, entry.path().stem().string()});
    }
  }
  if (!present && !files.empty()) {
    const auto staging = directory / "session.db.import";
    RK_RETURN_IF_ERROR(RemoveFile(staging));
    RK_RETURN_IF_ERROR(RemoveFile(staging.wstring() + L"-wal"));
    RK_RETURN_IF_ERROR(RemoveFile(staging.wstring() + L"-shm"));
    SessionDb imported(directory);
    RK_RETURN_IF_ERROR(imported.OpenFile(staging));
    auto result = imported.Write([&]() -> Result<void> {
      for (const auto& file : files) {
        if (file.kind == "site-preferences.json") {
          RK_ASSIGN_OR_RETURN(ignored, ReadFileIfExists(file.path));
          if (!ignored)
            return Error{ErrorCode::kUnavailable,
                         "legacy session file disappeared: " + file.path.string()};
          continue;
        }
        auto insert = [&]() -> Result<void> {
          RK_ASSIGN_OR_RETURN(value, ReadLegacy(file.path));
          if (file.kind == "views.json") {
            if (!value.is_array())
              return CorruptState("invalid views");
            return imported.Views().Save(value);
          }
          if (file.kind == "events.json") {
            if (!value.at("next").is_number_integer() || value.at("next") < 1 ||
                !value.at("events").is_array() || value.at("events").size() > 256)
              return CorruptState("invalid events");
            int64_t maximum = 0;
            for (const auto& event : value.at("events")) {
              RK_ASSIGN_OR_RETURN(id, EventId(event.at("eventId")));
              if (event.at("type") != "view.closed" ||
                  event.at("viewId").get<std::string>().empty())
                return CorruptState("invalid event");
              RK_ASSIGN_OR_RETURN(statement,
                                  imported.db_.Prepare("INSERT INTO closed_events VALUES(?,?,?)"));
              RK_RETURN_IF_ERROR(statement.Bind(1, id));
              RK_RETURN_IF_ERROR(statement.Bind(2, event.at("viewId").get<std::string>()));
              RK_RETURN_IF_ERROR(statement.Bind(3, event.at("reason").get<std::string>()));
              RK_ASSIGN_OR_RETURN(row, statement.Step());
              maximum = std::max(maximum, id);
            }
            const auto next = value.at("next").get<int64_t>();
            if (next <= maximum)
              return CorruptState("invalid next event id");
            RK_RETURN_IF_ERROR(
                imported.db_.Execute("DELETE FROM sqlite_sequence WHERE name='closed_events'"));
            RK_ASSIGN_OR_RETURN(
                statement,
                imported.db_.Prepare("INSERT INTO sqlite_sequence VALUES('closed_events',?)"));
            RK_RETURN_IF_ERROR(statement.Bind(1, next - 1));
            RK_ASSIGN_OR_RETURN(row, statement.Step());
            return {};
          }
          if (file.kind == "download-imports.json")
            return imported.Downloads().Save(value);
          if (file.kind == "recovery")
            return imported.Recovery().Save(file.id, value);
          const auto table = file.kind == "metadata"     ? LibraryTable::kAssets
                             : file.kind == "drafts"     ? LibraryTable::kDrafts
                             : file.kind == "selections" ? LibraryTable::kSelections
                                                         : LibraryTable::kDerivatives;
          RK_RETURN_IF_ERROR(library_records::Validate(table, file.id, value));
          if (table == LibraryTable::kDrafts && value.at("sealed") == "") {
            RK_ASSIGN_OR_RETURN(exists, FileExists(directory / "file-library/incoming" / file.id));
            if (!exists)
              return CorruptState("missing draft payload");
            RK_ASSIGN_OR_RETURN(size, FileSize(directory / "file-library/incoming" / file.id));
            if (size > value.at("size").get<uint64_t>())
              return CorruptState("invalid draft payload");
          }
          return imported.Library().Save(table, file.id, value);
        };
        try {
          auto saved = insert();
          if (!saved) {
            if (saved.error().code == ErrorCode::kUnavailable)
              return saved.error();
            return CorruptState("invalid legacy session file " + file.path.string() + ": " +
                                saved.error().message);
          }
        } catch (const std::exception& error) {
          return CorruptState("invalid legacy session file " + file.path.string() + ": " +
                              error.what());
        }
      }
      // Resolve an interrupted legacy close before publishing the imported store.
      RK_RETURN_IF_ERROR(imported.db_.Execute(
          "DELETE FROM views WHERE view_id IN (SELECT view_id FROM closed_events)"));
      return imported.db_.Execute(
          "DELETE FROM navigation_recovery WHERE view_id IN (SELECT view_id FROM closed_events)");
    });
    auto closed = imported.Close();
    if (!result) {
      RemoveFile(staging);
      return result.error();
    }
    RK_RETURN_IF_ERROR(closed);
    if (!MoveFileExW(staging.c_str(), (directory / "session.db").c_str(), MOVEFILE_WRITE_THROUGH))
      return WithOsError(ErrorCode::kUnavailable, "cannot publish imported session store",
                         OsError::Kind::kWin32, GetLastError());
  }
  for (const auto& file : files) {
    RK_RETURN_IF_ERROR(RemoveFile(file.path));
  }
  for (const auto& path : temporary) {
    RK_RETURN_IF_ERROR(RemoveTree(path));
  }
  for (const auto* kind : {"recovery", "metadata", "drafts", "selections", "derivatives"}) {
    const auto folder =
        std::string(kind) == "recovery" ? directory / kind : directory / "file-library" / kind;
    RK_RETURN_IF_ERROR(RemoveTree(folder));
  }
  RK_RETURN_IF_ERROR(RemoveFile(directory / "browser.log"));
  RK_RETURN_IF_ERROR(RemoveTree(directory / "crashes"));
  return {};
}
}  // namespace remotekit
