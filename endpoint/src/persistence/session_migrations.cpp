#include "persistence/session_migrations.hpp"
#include "persistence/strict_json.hpp"
#include "persistence/session_documents.hpp"
#include "persistence/derivative_records.hpp"
#include "util/result_macros.hpp"
#include <algorithm>
#include <array>
#include <chrono>

namespace remotekit {
namespace {
constexpr auto kDerivativeSchema = R"sql(
CREATE TABLE file_derivatives(
 source_id TEXT NOT NULL, kind TEXT NOT NULL, parameters TEXT NOT NULL,
 asset_id TEXT NOT NULL, metadata TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>=0),
 PRIMARY KEY(source_id,kind,parameters)
) STRICT;
)sql";
// v4: download imports keep their retry-unit state, and a selection persisted as "submitted"
// (dispatch possibly delivered) becomes "unknown", which reconciliation resolves.
Result<void> UpgradeToVersion4(sqlite::Database& db) {
  RK_RETURN_IF_ERROR(db.Execute("ALTER TABLE download_imports ADD COLUMN retry TEXT"));
  return db.Execute(
      "UPDATE library_selections SET state='unknown', "
      "document=json_set(document,'$.state','unknown') WHERE state='submitted'");
}
Result<void> UpgradeToVersion5(sqlite::Database& db) {
  RK_RETURN_IF_ERROR(db.Execute(kDerivativeSchema));
  // JPEG/PNG keys identify selection transcoding. WebP keys lack purpose,
  // parameters, algorithm version and processing metadata, so cannot be preserved.
  // Invalid IDs and unknown formats cannot form a valid derivative key either.
  RK_RETURN_IF_ERROR(
      db.Execute("INSERT INTO file_derivatives "
                 "SELECT asset_id,'selection-transcode',format,derived_id,'{}',"
                 "ROW_NUMBER() OVER(ORDER BY asset_id,format) FROM library_derivatives "
                 "WHERE typeof(asset_id)='text' AND length(CAST(asset_id AS BLOB))=64 "
                 "AND asset_id NOT GLOB '*[^0-9a-f]*' AND typeof(derived_id)='text' "
                 "AND length(CAST(derived_id AS BLOB))=64 AND derived_id NOT GLOB '*[^0-9a-f]*' "
                 "AND format IN ('jpeg','png') ORDER BY asset_id,format"));
  RK_RETURN_IF_ERROR(derivative_records::Trim(db));
  return db.Execute("DROP TABLE library_derivatives");
}
Result<void> UpgradeToVersion6(sqlite::Database& db) {
  RK_ASSIGN_OR_RETURN(query, db.Prepare("SELECT view_id,config FROM views"));
  std::vector<std::pair<std::string, Json>> views;
  for (;;) {
    RK_ASSIGN_OR_RETURN(row, query.Step());
    if (!row)
      break;
    auto config = session_documents::ViewTopology(Json::parse(query.Text(1)));
    if (config.at("viewId") != query.Text(0))
      return CorruptRecord("mismatched views.view_id");
    views.emplace_back(query.Text(0), std::move(config));
  }
  for (const auto& [id, config] : views) {
    RK_ASSIGN_OR_RETURN(update, db.Prepare("UPDATE views SET config=? WHERE view_id=?"));
    RK_RETURN_IF_ERROR(update.Bind(1, config.dump()));
    RK_RETURN_IF_ERROR(update.Bind(2, id));
    RK_ASSIGN_OR_RETURN(row, update.Step());
    if (row)
      return CorruptState("unexpected view migration row");
  }
  return db.Execute("ALTER TABLE views DROP COLUMN position");
}
// The baseline creates the latest schema directly; these steps upgrade existing stores.
constexpr std::array<SessionMigration, 3> kMigrations{{
    {4, "retry_state_and_uncertain_selections", UpgradeToVersion4},
    {5, "unified_file_derivatives", UpgradeToVersion5},
    {6, "transient_view_geometry", UpgradeToVersion6},
}};
constexpr auto kBaseline = R"sql(
CREATE TABLE views(view_id TEXT PRIMARY KEY, config TEXT NOT NULL);
CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,type TEXT NOT NULL,body TEXT NOT NULL);
CREATE TABLE event_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),stream_id TEXT NOT NULL,acked_through INTEGER NOT NULL);
INSERT INTO event_state VALUES(1,lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),0);
CREATE TABLE retired_views(view_id TEXT PRIMARY KEY,event_id TEXT NOT NULL);
CREATE TABLE download_imports(event_id TEXT PRIMARY KEY, incarnation TEXT NOT NULL, download TEXT NOT NULL,
 result TEXT, attempt INTEGER, error TEXT, retry_at INTEGER, retry TEXT);
CREATE TABLE coordination_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),placement_epoch INTEGER NOT NULL,desired_revision TEXT NOT NULL);
INSERT INTO coordination_state VALUES(1,0,'0');
CREATE TABLE view_runtime(view_id TEXT PRIMARY KEY,resume_url TEXT,original_browser TEXT);
CREATE TABLE navigation_recovery(view_id TEXT PRIMARY KEY, navigation_revision INTEGER NOT NULL, state BLOB NOT NULL);
CREATE TABLE library_assets(asset_id TEXT PRIMARY KEY, size INTEGER NOT NULL, type TEXT, width INTEGER, height INTEGER);
CREATE TABLE library_drafts(upload_id TEXT PRIMARY KEY, operation TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
 size INTEGER NOT NULL, expires INTEGER NOT NULL, sealed TEXT NOT NULL);
CREATE TABLE library_selections(selection_id TEXT PRIMARY KEY, state TEXT NOT NULL, document TEXT NOT NULL);
PRAGMA user_version=6;
)sql";
Result<int64_t> Version(sqlite::Database& db) {
  RK_ASSIGN_OR_RETURN(query, db.Prepare("PRAGMA user_version"));
  RK_ASSIGN_OR_RETURN(row, query.Step());
  if (!row)
    return CorruptState("missing session store version");
  return query.Int64(0);
}
Result<void> CheckViews(sqlite::Database& db) {
  try {
    RK_ASSIGN_OR_RETURN(query, db.Prepare("SELECT view_id,config FROM views"));
    for (;;) {
      RK_ASSIGN_OR_RETURN(row, query.Step());
      if (!row)
        return {};
      const auto config = Json::parse(query.Text(1));
      session_documents::View(config);
      if (config.at("viewId") != query.Text(0))
        return CorruptRecord("mismatched views.view_id");
    }
  } catch (const std::exception& error) {
    return CorruptRecord(std::string("views.config: ") + error.what());
  }
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
  if (expected_version >= 6)
    RK_RETURN_IF_ERROR(CheckViews(db));
  return derivative_records::CheckStore(db);
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
        RK_RETURN_IF_ERROR(db.Execute(kDerivativeSchema));
        RK_RETURN_IF_ERROR(transaction.Commit());
      }
    }
    RK_ASSIGN_OR_RETURN(version, Version(db));
    const auto target = steps.empty() ? kSessionDbVersion : steps.back().version;
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
    RK_RETURN_IF_ERROR(CheckSessionDb(db, target));
    return transaction.Commit();
  } catch (const std::exception& error) {
    return CorruptState(error.what());
  }
}
}  // namespace remotekit
