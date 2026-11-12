#include "persistence/session_migrations.hpp"
#include "persistence/strict_json.hpp"
#include "util/result_macros.hpp"
#include <algorithm>
#include <array>
#include <chrono>

namespace remotekit {
namespace {
constexpr int64_t kVersion = 3;
constexpr std::array<SessionMigration, 0> kMigrations{};
constexpr auto kBaseline = R"sql(
CREATE TABLE views(view_id TEXT PRIMARY KEY, config TEXT NOT NULL,position INTEGER NOT NULL);
CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,type TEXT NOT NULL,body TEXT NOT NULL);
CREATE TABLE event_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),stream_id TEXT NOT NULL,acked_through INTEGER NOT NULL);
INSERT INTO event_state VALUES(1,lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),0);
CREATE TABLE retired_views(view_id TEXT PRIMARY KEY,event_id TEXT NOT NULL);
CREATE TABLE download_imports(event_id TEXT PRIMARY KEY, incarnation TEXT NOT NULL, download TEXT NOT NULL,
 result TEXT, attempt INTEGER, error TEXT, retry_at INTEGER);
CREATE TABLE coordination_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),placement_epoch INTEGER NOT NULL,desired_revision TEXT NOT NULL);
INSERT INTO coordination_state VALUES(1,0,'0');
CREATE TABLE view_runtime(view_id TEXT PRIMARY KEY,resume_url TEXT,original_browser TEXT);
CREATE TABLE navigation_recovery(view_id TEXT PRIMARY KEY, navigation_revision INTEGER NOT NULL, state BLOB NOT NULL);
CREATE TABLE library_assets(asset_id TEXT PRIMARY KEY, size INTEGER NOT NULL, type TEXT, width INTEGER, height INTEGER);
CREATE TABLE library_drafts(upload_id TEXT PRIMARY KEY, operation TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
 size INTEGER NOT NULL, expires INTEGER NOT NULL, sealed TEXT NOT NULL);
CREATE TABLE library_selections(selection_id TEXT PRIMARY KEY, state TEXT NOT NULL, document TEXT NOT NULL);
CREATE TABLE library_derivatives(asset_id TEXT NOT NULL, format TEXT NOT NULL, derived_id TEXT NOT NULL, PRIMARY KEY(asset_id, format));
PRAGMA user_version=3;
)sql";
Result<int64_t> Version(sqlite::Database& db) {
  RK_ASSIGN_OR_RETURN(query, db.Prepare("PRAGMA user_version"));
  RK_ASSIGN_OR_RETURN(row, query.Step());
  if (!row)
    return CorruptState("missing session store version");
  return query.Int64(0);
}
Result<void> Backup(sqlite::Database& db,
                    const fs::path& directory,
                    const std::string& build,
                    int64_t from,
                    int64_t to) {
  const auto backups = directory / "backups";
  fs::create_directories(backups);
  const auto stamp = std::chrono::system_clock::now().time_since_epoch().count();
  const auto name = "session-v" + std::to_string(from) + "-to-v" + std::to_string(to) + "-" +
                    build + "-" + std::to_string(stamp) + ".db";
  const auto path = backups / name;
  {
    RK_ASSIGN_OR_RETURN(query, db.Prepare("VACUUM INTO ?"));
    const auto utf8 = path.u8string();
    RK_RETURN_IF_ERROR(query.Bind(1, std::string(utf8.begin(), utf8.end())));
    RK_ASSIGN_OR_RETURN(row, query.Step());
    if (row)
      return CorruptState("unexpected backup row");
  }
  sqlite::Database copy;
  RK_RETURN_IF_ERROR(copy.OpenReadOnly(path, false));
  RK_ASSIGN_OR_RETURN(version, Version(copy));
  RK_ASSIGN_OR_RETURN(check, copy.Prepare("PRAGMA integrity_check"));
  RK_ASSIGN_OR_RETURN(row, check.Step());
  if (!row || check.Text(0) != "ok" || version != from)
    return CorruptState("session migration backup verification failed");
  std::vector<fs::directory_entry> files;
  for (const auto& file : fs::directory_iterator(backups))
    if (file.is_regular_file() && file.path().filename().string().starts_with("session-v") &&
        file.path().extension() == ".db")
      files.push_back(file);
  std::sort(files.begin(), files.end(), [](const auto& a, const auto& b) {
    return a.last_write_time() != b.last_write_time() ? a.last_write_time() > b.last_write_time()
                                                      : a.path() > b.path();
  });
  for (size_t i = 3; i < files.size(); ++i)
    fs::remove(files[i].path());
  return {};
}
}  // namespace
Result<void> CheckSessionDb(sqlite::Database& db, int64_t expected_version) {
  RK_ASSIGN_OR_RETURN(version, Version(db));
  if (version != expected_version)
    return CorruptState("invalid session schema version");
  RK_ASSIGN_OR_RETURN(query, db.Prepare("PRAGMA quick_check"));
  RK_ASSIGN_OR_RETURN(row, query.Step());
  if (!row || query.Text(0) != "ok")
    return CorruptState("session integrity check failed");
  RK_ASSIGN_OR_RETURN(foreign, db.Prepare("PRAGMA foreign_key_check"));
  RK_ASSIGN_OR_RETURN(invalid, foreign.Step());
  if (invalid)
    return CorruptState("session foreign key check failed");
  return {};
}
Result<void> MigrateSessionDb(sqlite::Database& db,
                              const fs::path& directory,
                              const std::string& build,
                              std::span<const SessionMigration> steps) {
  try {
    if (steps.empty())
      steps = kMigrations;
    {
      RK_ASSIGN_OR_RETURN(
          tables,
          db.Prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"));
      RK_ASSIGN_OR_RETURN(present, tables.Step());
      if (!present) {
        sqlite::Transaction transaction(db);
        RK_RETURN_IF_ERROR(transaction.Begin());
        RK_RETURN_IF_ERROR(db.Execute(kBaseline));
        RK_RETURN_IF_ERROR(transaction.Commit());
      }
    }
    RK_ASSIGN_OR_RETURN(version, Version(db));
    const auto target = steps.empty() ? kVersion : steps.back().version;
    const bool pending = std::any_of(steps.begin(), steps.end(),
                                     [&](const auto& step) { return step.version > version; });
    if (pending)
      RK_RETURN_IF_ERROR(Backup(db, directory, build, version, target));
    sqlite::Transaction transaction(db);
    RK_RETURN_IF_ERROR(transaction.Begin());
    for (const auto& step : steps) {
      if (step.version <= version)
        continue;
      if (step.version != version + 1)
        return CorruptState("session migration numbers must be consecutive");
      RK_RETURN_IF_ERROR(step.up(db));
      version = step.version;
      const auto sql = "PRAGMA user_version=" + std::to_string(version);
      RK_RETURN_IF_ERROR(db.Execute(sql.c_str()));
    }
    if (version != target)
      return CorruptState("invalid session schema version");
    RK_RETURN_IF_ERROR(transaction.Commit());
    return CheckSessionDb(db, target);
  } catch (const std::exception& error) {
    return CorruptState(error.what());
  }
}
}  // namespace remotekit
