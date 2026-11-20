#include "persistence/session_db.hpp"
#include "persistence/session_documents.hpp"
#include "persistence/session_migrations.hpp"
#include "persistence/checkpoint_formats.hpp"
#include "persistence/config_formats.hpp"
#include "runtime_config_fixture.hpp"
#include "files/library_records.hpp"
#include "persistence/checkpoint.hpp"
#include "util/file_io.hpp"
#include "util/result_macros.hpp"
#include <windows.h>
#include <fstream>
#include <iostream>
#include <iomanip>
#include <sstream>
using namespace remotekit;
namespace {
void Check(bool value, const char* message) {
  if (!value)
    throw std::runtime_error(message);
}
template <class T>
T Take(Result<T> result) {
  if (!result)
    throw std::runtime_error(result.error().message);
  return std::move(result).value();
}
void Take(Result<void> result) {
  if (!result)
    throw std::runtime_error(result.error().message);
}
Json Recovery() {
  return {{"size", "3"},
          {"navigationRevision", "7"},
          {"chunks", Json::array({{{"data", "YWJj"}, {"bytes", 3}}})}};
}
Json Download() {
  return {{"records", Json::array({{{"incarnation", "browser"},
                                    {"eventId", "download-event"},
                                    {"download",
                                     {{"guid", "guid"},
                                      {"eventId", "browser-event"},
                                      {"fileReference", "downloads/a"},
                                      {"name", "a"},
                                      {"mimeType", "text/plain"},
                                      {"size", "3"},
                                      {"origin", ""}}},
                                    {"result",
                                     {{"type", "download.imported"},
                                      {"eventId", "download-event"},
                                      {"name", "a"},
                                      {"origin", ""},
                                      {"assetId", std::string(64, 'a')},
                                      {"mimeType", "text/plain"},
                                      {"size", "3"}}}}})}};
}
Json Selection(const std::string& state = "pending") {
  return {
      {"requestId", "chooser"},
      {"binding",
       {{"browserIncarnation", "browser"},
        {"view", "1"},
        {"instance", "2"},
        {"document", "3"},
        {"request", "4"}}},
      {"state", state},
      {"accept", Json::array()},
      {"limits", {{"maxFileBytes", 10}, {"maxBatchBytes", 10}, {"maxFiles", 1}}},
      {"files",
       Json::array({{{"assetId", std::string(64, 'a')}, {"name", "a"}, {"type", "text/plain"}}})}};
}
void Formats() {
  using Validator = void (*)(const Json&);
  struct Sample {
    Validator validate;
    Json value;
    const char* required;
  };
  const std::string id(64, 'a');
  const std::vector<Sample> samples = {
      {checkpoint_formats::ValidateCopy,
       {{"version", 1},
        {"sessionId", "session"},
        {"placementEpoch", 1},
        {"base", nullptr},
        {"state", "clean"},
        {"stoppedCleanly", true},
        {"changesAt", 0},
        {"lastCommit", nullptr}},
       "state"},
      {checkpoint_formats::ValidateChanges,
       {{"version", 1},
        {"at", 1},
        {"paths", Json::array()},
        {"removed", Json::array()},
        {"subtrees", Json::array()},
        {"continuous", true}},
       "continuous"},
      {checkpoint_formats::ValidateManifest,
       {{"version", 2},
        {"buildId", "dev"},
        {"files", Json::array({{{"path", "file"}, {"size", 1}, {"chunks", Json::array({id})}}})},
        {"directories", Json::array()}},
       "files"},
      {config_formats::Node,
       {{"version", 1},
        {"nodeId", "node"},
        {"privateKey", std::string(43, 'A') + "="},
        {"controlPublicKey", std::string(43, 'A') + "="}},
       "privateKey"},
      {config_formats::Manager,
       {{"version", 1},
        {"manifest", "https://example.test/control.manifest"},
        {"checkIntervalMinutes", 60}},
       "manifest"},
      {config_formats::Owner,
       {{"version", 1}, {"snapshotId", "{01234567-0123-4567-89ab-0123456789ab}"}},
       "snapshotId"},
      {session_documents::View, session_documents::ViewTopology(TestView()), "url"},
      {session_documents::Downloads, Download(), "records"},
      {session_documents::WireError, {{"code", "internal"}, {"message", "failed"}}, "message"},
  };
  for (const auto& sample : samples) {
    const auto encoded = Take(checkpoint_formats::Encode(sample.value, sample.validate));
    Check(Take(checkpoint_formats::Decode(encoded, sample.validate, persisted::Store::kManifest)) ==
              sample.value,
          "format round trip");
    auto missing = sample.value;
    missing.erase(sample.required);
    auto unknown = sample.value;
    unknown["unknown"] = true;
    auto wrong = sample.value;
    wrong[sample.required] = 7;
    for (const auto& bad : {missing, unknown, wrong}) {
      const auto decoded =
          checkpoint_formats::Decode(bad.dump(), sample.validate, persisted::Store::kManifest);
      Check(!decoded && decoded.error().reason == ErrorReason::kCorruptState &&
                ValidErrorId(decoded.error().error_id),
            "strict format rejection");
      Check(!checkpoint_formats::Encode(bad, sample.validate), "strict encoder rejection");
    }
  }
  const auto entries =
      Json{{"file", {{"size", 1}, {"mtime", 1}, {"fileId", "1:2"}, {"chunks", Json::array({id})}}}};
  const auto index = Take(checkpoint_formats::EncodeIndex(entries));
  Check(checkpoint_formats::DecodeIndex(index.dump()) == entries, "index round trip");
  auto missing_index = index;
  missing_index.erase("entries");
  auto unknown_index = index;
  unknown_index["unknown"] = true;
  auto wrong_index = index;
  wrong_index["entries"] = 7;
  for (const auto& bad : {missing_index, unknown_index, wrong_index}) {
    Check(checkpoint_formats::DecodeIndex(bad.dump()).is_null(), "invalid index rebuilds");
  }
}
void MigrationRunner(const fs::path& path) {
  SessionDb initial(path);
  Take(initial.Open());
  Take(initial.Close());
  sqlite::Database db;
  Take(db.Open(path / "session.db"));
  const std::array<SessionMigration, 1> steps{
      {{kSessionDbVersion + 1, "future-test", [](sqlite::Database& store) -> Result<void> {
          RK_RETURN_IF_ERROR(store.Execute("CREATE TABLE future_step(value TEXT)"));
          return CorruptState("injected migration failure");
        }}}};
  Check(!MigrateSessionDb(db, path, "dev", steps), "future step fails");
  {
    auto query = Take(db.Prepare("PRAGMA user_version"));
    Take(query.Step());
    Check(query.Int64(0) == kSessionDbVersion, "migration rollback preserves schema version");
  }
  Check(std::distance(fs::directory_iterator(path / "backups"), fs::directory_iterator()) == 1,
        "verified pre-migration backup retained");
  const std::array<SessionMigration, 1> success{
      {{kSessionDbVersion + 1, "future-test", [](sqlite::Database& store) -> Result<void> {
          return store.Execute("CREATE TABLE future_step(value TEXT)");
        }}}};
  Take(MigrateSessionDb(db, path, "dev", success));
  Take(CheckSessionDb(db, kSessionDbVersion + 1));
  Take(db.Close());
}
// A store written by the previous build (user_version 3, no download retry column) upgrades
// through the migration module instead of being rejected as corrupt.
void UpgradeFromVersion3(const fs::path& path) {
  const std::string selection_id(32, 'a'), draft_id(32, 'b'), asset_id(64, 'a');
  const Json asset{{"assetId", asset_id}, {"size", 3}, {"type", "text/plain"}};
  const Json draft{{"operation", "operation"}, {"name", "a"},
                   {"type", "text/plain"},     {"size", 3},
                   {"expires", 2000000000},    {"sealed", asset_id}};
  auto downloads = Download();
  auto pending = downloads["records"][0];
  pending.erase("result");
  pending["eventId"] = "pending-download";
  pending["attempt"] = 2;
  pending["retryAt"] = 2000000000000LL;
  pending["error"] = {{"code", "outcome_unknown"}, {"message", "reply lost"}};
  downloads["records"].push_back(pending);
  {
    SessionDb initial(path);
    Take(initial.Open());
    Take(initial.Library().Save(LibraryTable::kAssets, asset_id, asset));
    Take(initial.Library().Save(LibraryTable::kDrafts, draft_id, draft));
    Take(initial.Library().Save(LibraryTable::kSelections, selection_id, Selection()));
    Take(initial.Downloads().Save(downloads));
    Take(initial.Close());
  }
  {
    sqlite::Database db;
    Take(db.Open(path / "session.db"));
    Take(db.Execute("ALTER TABLE download_imports DROP COLUMN retry"));
    Take(
        db.Execute("UPDATE library_selections SET state='submitted', "
                   "document=json_set(document,'$.state','submitted')"));
    Take(db.Execute("DROP TABLE file_derivatives"));
    Take(
        db.Execute("CREATE TABLE library_derivatives(asset_id TEXT NOT NULL,format TEXT NOT NULL,"
                   "derived_id TEXT NOT NULL,PRIMARY KEY(asset_id,format))"));
    Take(db.Execute("ALTER TABLE views ADD COLUMN position INTEGER NOT NULL DEFAULT 0"));
    Take(db.Execute("PRAGMA user_version=3"));
    Take(db.Close());
  }
  SessionDb upgraded(path);
  Take(upgraded.Open());
  const auto selections = Take(upgraded.Library().Load(LibraryTable::kSelections));
  Check(selections.at(selection_id) == Selection("unknown"), "v3 selection fully decodes");
  Check(bool(library_records::ParseSelection(selection_id, selections.at(selection_id))),
        "migrated selection decodes through its owner");
  Check(Take(upgraded.Library().Load(LibraryTable::kAssets)).at(asset_id) == asset,
        "v3 asset record decodes unchanged");
  Check(Take(upgraded.Library().Load(LibraryTable::kDrafts)).at(draft_id) == draft,
        "v3 upload draft decodes unchanged");
  Check(Take(upgraded.Downloads().Load()) == downloads,
        "v3 pending and completed downloads retain identity, result and retry metadata");
  Take(upgraded.Close());
  sqlite::Database db;
  Take(db.Open(path / "session.db"));
  Take(CheckSessionDb(db));
  {
    auto column =
        Take(db.Prepare("SELECT 1 FROM pragma_table_info('download_imports') WHERE name='retry'"));
    Check(Take(column.Step()), "v3 store gains the download retry column");
    auto selection = Take(
        db.Prepare("SELECT state, json_extract(document,'$.state') FROM library_selections WHERE "
                   "selection_id='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'"));
    Check(
        Take(selection.Step()) && selection.Text(0) == "unknown" && selection.Text(1) == "unknown",
        "a submitted selection becomes unknown");
  }
  Take(db.Close());
}
int64_t Scalar(sqlite::Database& db, const char* sql) {
  auto query = Take(db.Prepare(sql));
  Check(Take(query.Step()), "scalar query returns a row");
  return query.Int64(0);
}
std::string ObjectId(unsigned value) {
  std::ostringstream text;
  text << std::hex << std::setw(64) << std::setfill('0') << value;
  return text.str();
}
void CreateVersion4(sqlite::Database& db) {
  Take(db.Execute("DROP TABLE file_derivatives"));
  Take(
      db.Execute("CREATE TABLE library_derivatives(asset_id TEXT NOT NULL,format TEXT NOT NULL,"
                 "derived_id TEXT NOT NULL,PRIMARY KEY(asset_id,format))"));
  Take(db.Execute("ALTER TABLE views ADD COLUMN position INTEGER NOT NULL DEFAULT 0"));
  Take(db.Execute("PRAGMA user_version=4"));
}
void InsertVersion4(sqlite::Database& db,
                    const std::string& source,
                    const std::string& format,
                    const std::string& asset) {
  auto insert = Take(db.Prepare("INSERT INTO library_derivatives VALUES(?,?,?)"));
  Take(insert.Bind(1, source));
  Take(insert.Bind(2, format));
  Take(insert.Bind(3, asset));
  Check(!Take(insert.Step()), "insert v4 derivative");
}
void UpgradeDerivatives(const fs::path& path) {
  {
    SessionDb initial(path);
    Take(initial.Open());
    Take(initial.Close());
  }
  sqlite::Database db;
  Take(db.Open(path / "session.db"));
  CreateVersion4(db);
  InsertVersion4(db, ObjectId(1), "jpeg", ObjectId(2));
  InsertVersion4(db, ObjectId(1), "png", ObjectId(3));
  InsertVersion4(db, ObjectId(1), "webp", ObjectId(4));
  InsertVersion4(db, ObjectId(1), "unknown", ObjectId(5));
  InsertVersion4(db, "invalid", "jpeg", ObjectId(6));
  InsertVersion4(db, ObjectId(7), "png", "invalid");
  InsertVersion4(db, ObjectId(8) + std::string("\0extra", 6), "jpeg", ObjectId(9));
  Take(db.Execute("PRAGMA foreign_keys=ON"));
  Take(
      db.Execute("CREATE TABLE migration_guard(source_id TEXT,format TEXT,"
                 "FOREIGN KEY(source_id,format) REFERENCES library_derivatives(asset_id,format))"));
  {
    auto guard = Take(db.Prepare("INSERT INTO migration_guard VALUES(?,'jpeg')"));
    Take(guard.Bind(1, ObjectId(1)));
    Take(guard.Step());
  }
  Check(!MigrateSessionDb(db, path, "dev"), "failure dropping v4 table aborts the migration");
  Check(Scalar(db, "PRAGMA user_version") == 4 &&
            Scalar(db, "SELECT count(*) FROM library_derivatives") == 7 &&
            Scalar(db, "SELECT count(*) FROM sqlite_master WHERE name='file_derivatives'") == 0,
        "migration failure rolls back copied rows, schema and version");
  Check(std::distance(fs::directory_iterator(path / "backups"), fs::directory_iterator()) == 1,
        "failed v4 migration retains its verified backup");
  Take(db.Execute("DROP TABLE migration_guard"));
  Take(MigrateSessionDb(db, path, "dev"));
  Check(
      Scalar(db, "PRAGMA user_version") == kSessionDbVersion &&
          Scalar(db, "SELECT count(*) FROM sqlite_master WHERE name='library_derivatives'") == 0 &&
          Scalar(db, "SELECT count(*) FROM file_derivatives") == 2,
      "v4 JPEG/PNG rows migrate and unrepresentable rows are discarded");
  {
    auto query = Take(
        db.Prepare("SELECT kind,parameters,metadata FROM file_derivatives ORDER BY parameters"));
    Check(Take(query.Step()) && query.Text(0) == "selection-transcode" && query.Text(1) == "jpeg" &&
              query.Text(2) == "{}",
          "JPEG key gains its purpose and empty metadata");
    Check(Take(query.Step()) && query.Text(1) == "png" && !Take(query.Step()),
          "PNG key migrates once");
  }
  Take(db.Close());
  SessionDb reopened(path);
  Take(reopened.Open());
  const auto jpeg =
      Take(reopened.Library().FindDerivative({ObjectId(1), "selection-transcode", "jpeg"}));
  Check(jpeg && jpeg->asset_id == ObjectId(2) && jpeg->metadata == Json::object(),
        "migrated cache is readable through the current owner");
}
void UpgradeDerivativeBounds(const fs::path& path) {
  {
    SessionDb initial(path);
    Take(initial.Open());
    Take(initial.Close());
  }
  sqlite::Database db;
  Take(db.Open(path / "session.db"));
  CreateVersion4(db);
  {
    sqlite::Transaction transaction(db);
    Take(transaction.Begin());
    for (unsigned i = 1; i <= 1025; ++i)
      InsertVersion4(db, ObjectId(i), "jpeg", ObjectId(2048));
    Take(transaction.Commit());
  }
  Take(MigrateSessionDb(db, path, "dev"));
  Check(Scalar(db, "SELECT count(*) FROM file_derivatives") == 1024 &&
            Scalar(db, "SELECT min(sequence) FROM file_derivatives") == 2,
        "migration applies the current cache bound deterministically");
}
Json ProcessingMetadata() {
  return {{"geometry", {{"kind", "unchanged"}, {"cropped", false}}},
          {"quarterTurns", 0},
          {"orientation", {{"turns", 0}, {"state", "confident"}}}};
}
void DerivativeDecoding(const fs::path& path) {
  SessionDb db(path);
  Take(db.Open());
  auto library = db.Library();
  const DerivativeKey photo{ObjectId(1), "photo", "photo-0-v1:webp"};
  const DerivativeRecord record{ObjectId(2), ProcessingMetadata()};
  const std::vector<DerivativeKey> keys{
      {ObjectId(1), "preview", "1280-q80-v1:webp"}, {ObjectId(1), "preview", "2560-q80-v1:webp"},
      {ObjectId(1), "thumbnail", "320-v1:jpeg"},    {ObjectId(1), "selection-transcode", "jpeg"},
      {ObjectId(1), "selection-transcode", "png"},  photo,
      {ObjectId(1), "photo", "scan-auto-v1:webp"}};
  for (const auto& key : keys) {
    const DerivativeRecord expected{ObjectId(2),
                                    key.kind == "photo" ? record.metadata : Json::object()};
    Take(library.SaveDerivative(key, expected));
    const auto found = Take(library.FindDerivative(key));
    Check(found && found->asset_id == expected.asset_id && found->metadata == expected.metadata,
          "typed derivative key and metadata round trip");
  }
  for (const auto& invalid :
       std::vector<DerivativeKey>{{"invalid", "photo", "photo-0-v1:webp"},
                                  {ObjectId(1), "document", "jpeg"},
                                  {ObjectId(1), "preview", "320-q80-v1:webp"},
                                  {ObjectId(1), "preview", "1280-q80-v1:jpeg"},
                                  {ObjectId(1), "photo", "photo-4-v1:webp"},
                                  {ObjectId(1), "photo", "photo-0-v2:webp"},
                                  {ObjectId(1), "thumbnail", "jpeg"},
                                  {ObjectId(1), "selection-transcode", "webp"}}) {
    Check(!library.FindDerivative(invalid) && !library.SaveDerivative(invalid, record),
          "unknown derivative recipe is rejected");
  }
  auto unknown = record.metadata;
  unknown["unknown"] = true;
  auto wrong = record.metadata;
  wrong["quarterTurns"] = 0.0;
  auto missing = record.metadata;
  missing.erase("orientation");
  auto inconsistent = record.metadata;
  inconsistent["orientation"]["turns"] = 1;
  auto invalid_kind = record.metadata;
  invalid_kind["geometry"]["kind"] = "unknown";
  sqlite::Database inject;
  Take(inject.Open(path / "session.db"));
  auto duplicate = record.metadata.dump();
  const auto turn_field = duplicate.find("\"quarterTurns\":0");
  duplicate.replace(turn_field, std::string("\"quarterTurns\":0").size(),
                    "\"quarterTurns\":0,\"quarterTurns\":0");
  const std::vector<std::string> invalid_metadata{"{",
                                                  "[]",
                                                  "{}",
                                                  duplicate,
                                                  unknown.dump(),
                                                  wrong.dump(),
                                                  missing.dump(),
                                                  inconsistent.dump(),
                                                  invalid_kind.dump(),
                                                  std::string(4097, ' ')};
  for (const auto& metadata : invalid_metadata) {
    {
      auto damage =
          Take(inject.Prepare("UPDATE file_derivatives SET metadata=? "
                              "WHERE kind='photo' AND parameters='photo-0-v1:webp'"));
      Take(damage.Bind(1, metadata));
      Take(damage.Step());
    }
    const auto found = library.FindDerivative(photo);
    Check(!found && found.error().reason == ErrorReason::kCorruptRecord,
          "persisted metadata corruption is not interpreted as a cache miss");
    Check(!CheckSessionDb(inject), "startup validation rejects corrupt derivative metadata");
    Take(library.SaveDerivative(photo, record));
    // Duplicate keys exist only in the serialized representation.
    if (metadata != duplicate)
      Check(!library.SaveDerivative(photo, {ObjectId(2), Json::parse(metadata, nullptr, false)}),
            "writer rejects the same invalid metadata");
  }
  Take(inject.Execute("UPDATE file_derivatives SET parameters='invalid' WHERE kind='thumbnail'"));
  Check(!CheckSessionDb(inject), "startup validates stored parameter keys");
  Take(inject.Execute(
      "UPDATE file_derivatives SET parameters='320-v1:jpeg' WHERE kind='thumbnail'"));
  Take(inject.Execute("PRAGMA ignore_check_constraints=ON"));
  Take(inject.Execute("UPDATE file_derivatives SET sequence=-1 WHERE kind='photo'"));
  Check(!library.FindDerivative(photo) && !CheckSessionDb(inject), "negative sequence is corrupt");
  Take(inject.Execute("UPDATE file_derivatives SET sequence=1 WHERE kind='photo'"));
  Take(inject.Execute("PRAGMA ignore_check_constraints=OFF"));
  Take(CheckSessionDb(inject));
  Take(inject.Close());
  Take(db.Close());
  const auto checkpoint = path / "checkpoint";
  fs::create_directories(checkpoint);
  fs::copy_file(path / "session.db", checkpoint / "session.db");
  SessionDb read_only(checkpoint);
  Take(read_only.OpenReadOnly(true));
  Check(Take(read_only.Library().FindDerivative(photo))->metadata == record.metadata,
        "copying session.db alone retains the cache and its strict decoder");
}
void DerivativeFailures(const fs::path& path, const std::string& kind, unsigned limit) {
  SessionDb db(path);
  Take(db.Open());
  auto library = db.Library();
  const auto key = [&](unsigned id) {
    return DerivativeKey{ObjectId(id), kind, kind == "thumbnail" ? "320-v1:jpeg" : "jpeg"};
  };
  const DerivativeRecord record{ObjectId(4096)};
  for (unsigned i = 1; i <= limit; ++i)
    Take(library.SaveDerivative(key(i), record));
  sqlite::Database inject;
  Take(inject.Open(path / "session.db"));
  Take(
      inject.Execute("CREATE TRIGGER fail_cache_insert BEFORE INSERT ON file_derivatives "
                     "BEGIN SELECT RAISE(ABORT,'injected insert'); END"));
  Check(!library.SaveDerivative(key(limit + 1), record), "cache insert failure");
  Take(inject.Execute("DROP TRIGGER fail_cache_insert"));
  Take(
      inject.Execute("CREATE TRIGGER fail_cache_evict BEFORE DELETE ON file_derivatives "
                     "BEGIN SELECT RAISE(ABORT,'injected eviction'); END"));
  Check(!library.SaveDerivative(key(limit + 1), record), "cache eviction failure");
  Check(Scalar(inject, "SELECT count(*) FROM file_derivatives") == limit &&
            Take(library.FindDerivative(key(1))) && !Take(library.FindDerivative(key(limit + 1))),
        "failed eviction rolls back the inserted row and retains the oldest mapping");
  Check(!library.EraseDerivative(key(1)), "mapping erase failure is returned");
  Check(bool(Take(library.FindDerivative(key(1)))), "failed erase retains the mapping");
  Take(inject.Execute("DROP TRIGGER fail_cache_evict"));
  unsigned checks = 0;
  const auto cancelled = [&]() -> Result<void> {
    if (++checks == 2)
      return Error{ErrorCode::kCanceled, "injected admission retirement"};
    return {};
  };
  Check(!library.SaveDerivative(key(limit + 1), record, cancelled), "cancel before cache commit");
  Check(Scalar(inject, "SELECT count(*) FROM file_derivatives") == limit &&
            Take(library.FindDerivative(key(1))) && !Take(library.FindDerivative(key(limit + 1))),
        "cancel rolls back both insertion and eviction");
  checks = 0;
  Check(!library.EraseDerivative(key(1), cancelled) && Take(library.FindDerivative(key(1))),
        "cancel rolls back mapping deletion");
  Take(library.SaveDerivative(key(limit + 1), record));
  Check(Scalar(inject, "SELECT count(*) FROM file_derivatives") == limit &&
            !Take(library.FindDerivative(key(1))) && Take(library.FindDerivative(key(limit + 1))),
        "successful insertion evicts the oldest mapping within its bound");
  Take(inject.Close());
  Take(db.Close());
  Check(!library.SaveDerivative(key(1), record) && !library.EraseDerivative(key(limit + 1)),
        "cache writes cannot reopen a closed checkpoint store");
}
void UpgradeGeometry(const fs::path& path) {
  {
    SessionDb initial(path);
    Take(initial.Open());
    Take(initial.Close());
  }
  sqlite::Database db;
  Take(db.Open(path / "session.db"));
  auto legacy = TestView();
  legacy["visible"] = true;
  legacy["occludedBottom"] = 200;
  legacy["occlusionRevision"] = "99";
  legacy["adopt"] = {{"browserIncarnation", "browser"}, {"provisionalId", "provisional"}};
  legacy["width"] = nullptr;
  legacy["device"] = "discarded geometry";
  auto second = TestView("2");
  second["signIn"] = "changyan";
  Take(db.Execute("ALTER TABLE views ADD COLUMN position INTEGER NOT NULL DEFAULT 0"));
  for (const auto& config : {legacy, second}) {
    auto insert = Take(db.Prepare("INSERT INTO views VALUES(?,?,0)"));
    Take(insert.Bind(1, config.at("viewId").get<std::string>()));
    Take(insert.Bind(2, config.dump()));
    Take(insert.Step());
  }
  Take(db.Execute("PRAGMA user_version=5"));
  Take(
      db.Execute("CREATE TRIGGER fail_geometry_migration BEFORE UPDATE ON views "
                 "WHEN OLD.view_id='2' BEGIN "
                 "SELECT RAISE(ABORT,'injected migration failure'); END"));
  Check(!MigrateSessionDb(db, path, "dev"), "geometry migration reports write failure");
  Check(Scalar(db, "PRAGMA user_version") == 5 &&
            Scalar(db,
                   "SELECT json_extract(config,'$.occludedBottom') FROM views WHERE view_id='1'") ==
                200,
        "failed migration retains both old geometry and schema version");
  Take(db.Execute("DROP TRIGGER fail_geometry_migration"));
  Take(db.Execute("UPDATE views SET config=json_set(config,'$.unknown',true)"));
  Check(!MigrateSessionDb(db, path, "dev") && Scalar(db, "PRAGMA user_version") == 5,
        "migration rejects unknown durable fields and rolls back");
  Take(db.Execute("UPDATE views SET config=json_remove(config,'$.unknown')"));
  Take(MigrateSessionDb(db, path, "dev"));
  {
    auto query = Take(db.Prepare("SELECT config FROM views WHERE view_id='1'"));
    Check(
        Take(query.Step()) && Json::parse(query.Text(0)) == session_documents::ViewTopology(legacy),
        "v5 migration discards geometry and retains adoption topology");
  }
  Check(Scalar(db, "SELECT count(*) FROM pragma_table_info('views') WHERE name='position'") == 0,
        "v6 drops durable presentation order");
  {
    auto query = Take(db.Prepare("SELECT config FROM views WHERE view_id='2'"));
    Check(
        Take(query.Step()) && Json::parse(query.Text(0)) == session_documents::ViewTopology(second),
        "v5 migration retains sign-in topology");
  }
  Take(db.Execute("UPDATE views SET config=json_set(config,'$.visible',false)"));
  Check(!CheckSessionDb(db), "current schema strictly rejects persisted geometry");
  Take(db.Close());
  SessionDb invalid(path);
  Check(!invalid.Open(), "startup rejects a current record containing transient geometry");
}
void PresentationOrderIsVolatile(const fs::path& path) {
  SessionDb store(path);
  Take(store.Open());
  const auto first = TestView("1");
  const auto second = TestView("2");
  Take(store.Views().SaveDesired(Json::array({second, first}), 1, "1"));
  sqlite::Database inject;
  Take(inject.Open(path / "session.db"));
  Take(inject.Execute("BEGIN IMMEDIATE"));
  Take(store.Views().SaveDesired(Json::array({first, second}), 1, "2"));
  Check(Scalar(inject, "SELECT desired_revision FROM coordination_state") == 1,
        "presentation order changes bypass the persistence transaction");
  Take(inject.Execute("ROLLBACK"));
}
void GeometryIsVolatile(const fs::path& path) {
  SessionDb store(path);
  Take(store.Open());
  auto config = TestView();
  config["occludedBottom"] = 120;
  config["occlusionRevision"] = "7";
  Take(store.Views().SaveDesired(Json::array({config}), 1, "1"));
  const auto topology = session_documents::ViewTopology(config);
  sqlite::Database observer;
  Take(observer.Open(path / "session.db"));
  Take(observer.Execute("BEGIN IMMEDIATE"));
  config["occludedBottom"] = 0;
  config["occlusionRevision"] = "8";
  config["width"] = 800;
  config["height"] = 600;
  config["visible"] = true;
  config["device"]["deviceScaleFactor"] = 2;
  Take(store.Views().SaveDesired(Json::array({config}), 1, "2"));
  {
    auto query = Take(observer.Prepare("SELECT config FROM views"));
    Check(Take(query.Step()), "persisted view exists");
    const auto saved = Json::parse(query.Text(0));
    Check(saved == topology, "geometry observations never reach the durable view configuration");
  }
  Check(Scalar(observer, "SELECT desired_revision FROM coordination_state") == 1,
        "geometry does not update the durable revision");
  Take(observer.Execute("ROLLBACK"));
  const auto restored = Take(store.Views().Load());
  Check(restored == Json::array({topology}), "crash recovery has no geometry");
  Take(
      observer.Execute("CREATE TRIGGER fail_views BEFORE DELETE ON views BEGIN "
                       "SELECT RAISE(ABORT,'injected topology failure'); END"));
  config["width"] = 900;
  Take(store.Views().SaveDesired(Json::array({config}), 1, "3"));
  auto changed = config;
  changed["url"] = "https://example.test/new";
  Check(!store.Views().SaveDesired(Json::array({changed}), 1, "4"),
        "topology failure is returned while geometry bypasses writes");
  Check(Take(store.Views().Load()) == restored &&
            Scalar(observer, "SELECT desired_revision FROM coordination_state") == 1,
        "failed topology commit preserves the full durable desired record");
  Check(!store.Views().SaveDesired(Json::array(), 1, "5"), "view removal requires a commit");
  Take(observer.Execute("DROP TRIGGER fail_views"));
  Take(store.Views().SaveDesired(Json::array({changed}), 1, "6"));
  Check(Take(store.Views().Load())[0].at("url") == changed.at("url"),
        "topology commits after the fault clears");
  Take(store.Close());
  SessionDb reopened(path);
  Take(reopened.Open());
  Check(Take(reopened.Views().Load()) == Json::array({session_documents::ViewTopology(changed)}),
        "restart retains topology without any geometry");
}
void Transactions(const fs::path& path) {
  SessionDb store(path);
  Take(store.Open());
  auto views = store.Views();
  auto recovery = store.Recovery();
  const auto config = session_documents::ViewTopology(TestView("1", "old"));
  Take(views.Save(Json::array({config})));
  auto invalid_recovery = Recovery();
  invalid_recovery["chunks"][0]["data"] = "%%%";
  Check(!recovery.Save("1", invalid_recovery), "invalid recovery decode returns error");
  invalid_recovery["size"] = "overflow";
  Check(!recovery.Save("1", invalid_recovery), "invalid recovery decimal returns error");
  Take(recovery.Save("1", Recovery()));
  Check(Take(recovery.Load("1")) == Recovery(), "recovery bytes round trip");
  sqlite::Database inject;
  Take(inject.Open(path / "session.db"));
  Take(
      inject.Execute("CREATE TRIGGER fail_recovery BEFORE DELETE ON navigation_recovery BEGIN "
                     "SELECT RAISE(ABORT,'injected failure'); END"));
  Check(!views.Close("1", "requested"), "close failure");
  Check(Take(store.Events().Load()).empty() && Take(views.Load()) == Json::array({config}) &&
            Take(recovery.Contains("1")),
        "close rollback preserves every table");
  Take(inject.Execute("DROP TRIGGER fail_recovery"));
  Take(views.CommitNavigation("1", "new"));
  Check(Take(views.Load()) == Json::array({config}) &&
            Take(views.ResumeUrl("1", "fallback")) == "new",
        "actual navigation does not mutate desired config");
  const auto event = Take(views.Close("1", "requested"));
  Check(Take(views.Load()) == Json::array({config}) && !Take(recovery.Contains("1")) &&
            Take(views.Retired()) == Json::array({"1"}) && Take(store.Events().Load()).size() == 1,
        "close atomically records retirement and event while retaining desired config");
  Take(store.Downloads().Save(Download()));
  Take(
      inject.Execute("CREATE TRIGGER fail_handoff BEFORE DELETE ON download_imports BEGIN SELECT "
                     "RAISE(ABORT,'injected failure'); END"));
  Check(!store.Downloads().Complete("download-event"), "handoff fault");
  Check(Take(store.Events().Load()).size() == 1 &&
            Take(store.Downloads().Load()).at("records").size() == 1,
        "handoff and journal removal roll back together");
  Take(inject.Execute("DROP TRIGGER fail_handoff"));
  Take(store.Downloads().Complete("download-event"));
  Check(Take(store.Events().Load()).size() == 2 &&
            Take(store.Downloads().Load()).at("records").empty(),
        "handoff commits event and removes journal");
  const auto stream = Take(store.Events().State()).at("streamId").get<std::string>();
  Take(store.Events().Acknowledge(stream, 2));
  const std::string first(32, 'a'), second(32, 'b');
  Take(store.Library().Save(LibraryTable::kSelections, first, Selection()));
  Take(store.Library().Save(LibraryTable::kSelections, second, Selection()));
  Take(
      inject.Execute("CREATE TRIGGER fail_selection BEFORE INSERT ON library_selections WHEN "
                     "NEW.selection_id='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' BEGIN SELECT "
                     "RAISE(ABORT,'injected failure'); END"));
  Check(!store.Library().Selections(
            {{first, Selection("cancelled")}, {second, Selection("cancelled")}}),
        "selection failure");
  Check(Take(store.Library().Load(LibraryTable::kSelections)).at(first).at("state") == "pending",
        "selection rollback");
  Take(inject.Execute("DROP TRIGGER fail_selection"));
  Take(store.Library().Selections(
      {{first, Selection("cancelled")}, {second, Selection("cancelled")}}));
  for (const auto& [id, row] : Take(store.Library().Load(LibraryTable::kSelections)))
    Check(row.at("state") == "cancelled", "selection transaction");
  Take(
      inject.Execute("CREATE TRIGGER fail_draft BEFORE INSERT ON library_drafts BEGIN SELECT "
                     "RAISE(ABORT,'injected failure'); END"));
  const std::string asset(64, 'a');
  const Json draft = {{"operation", "op"}, {"name", "a"},           {"type", "text/plain"},
                      {"size", 3},         {"expires", 2000000000}, {"sealed", asset}};
  Check(!store.Library().Seal(asset, {{"size", 3}, {"type", "text/plain"}}, first, draft),
        "seal failure");
  Check(Take(store.Library().Load(LibraryTable::kAssets)).empty(), "seal rollback");
  Take(inject.Execute("DROP TRIGGER fail_draft"));
  Take(inject.Close());
  Take(store.Close());
  Check(!fs::exists(path / "session.db-wal") && !fs::exists(path / "session.db-shm"),
        "closed database has no sidecars");
  const auto late = views.Save(Json::array());
  Check(!late && late.error().code == ErrorCode::kInternal, "write after checkpoint close");
  SessionDb reopened(path);
  Take(reopened.Open());
  Check(Take(reopened.Events().Load()).empty(), "reopen committed state");
}
void Reads(const fs::path& path) {
  fs::create_directories(path);
  const auto name = path / "read";
  Check(!Take(ReadFileIfExists(name)), "missing file");
  std::ofstream(name) << "hello";
  const auto file = CreateFileW(name.c_str(), GENERIC_READ, 0, nullptr, OPEN_EXISTING,
                                FILE_ATTRIBUTE_NORMAL, nullptr);
  Check(file != INVALID_HANDLE_VALUE, "hold read file");
  auto read = ReadFileIfExists(name);
  CloseHandle(file);
  Check(!read && read.error().code == ErrorCode::kUnavailable &&
            read.error().message.find("Windows 32") != std::string::npos,
        "sharing violation is unavailable");
  Check(Take(ReadFileIfExists(name)).value() == "hello", "read file");
  const auto journal = path / "session.copy.json";
  for (const auto* state : {"clean", "dirty"}) {
    const Json previous{{"version", 1},    {"sessionId", "session"}, {"placementEpoch", 1},
                        {"base", nullptr}, {"state", state},         {"stoppedCleanly", true},
                        {"changesAt", 0},  {"lastCommit", nullptr}};
    std::ofstream(journal) << previous.dump();
    Check(Take(Checkpoints::Copy(path / "session")) == previous,
          "previous copy record decodes through the store format module");
  }
  std::ofstream(journal) << "{";
  const auto malformed = Checkpoints::Copy(path / "session");
  Check(!malformed && malformed.error().reason == ErrorReason::kCorruptState,
        "authoritative copy corruption");
  const auto held_journal = CreateFileW(journal.c_str(), GENERIC_READ, 0, nullptr, OPEN_EXISTING,
                                        FILE_ATTRIBUTE_NORMAL, nullptr);
  const auto unavailable = Checkpoints::Copy(path / "session");
  CloseHandle(held_journal);
  Check(!unavailable && unavailable.error().code == ErrorCode::kUnavailable, "copy I/O error");
}
void EventTransactions(const fs::path& path) {
  SessionDb store(path);
  Take(store.Open());
  auto events = store.Events();
  const auto initial = Take(events.State());
  const auto stream = initial.at("streamId").get<std::string>();
  Check(stream.size() == 36, "event stream identity");
  const auto first = Take(
      events.Append("view.closed", {{"viewId", "1"}, {"reason", "script"}}, "first", "browser"));
  Check(first.at("seq") == "1", "first sequence");
  Check(Take(events.Append("view.closed", {{"viewId", "1"}, {"reason", "script"}}, "first",
                           "browser")) == first,
        "event insertion deduplicates source identity");
  Check(!events.Append("view.closed", {{"viewId", "2"}}, "first", "browser"),
        "event identity conflict");
  Take(events.Append("clipboard.changed",
                     {{"baseRevision", "9"},
                      {"browserSequence", "3"},
                      {"excludeFromHistory", false},
                      {"text", "native"},
                      {"html", ""}},
                     "second", "browser"));
  sqlite::Database inject;
  Take(inject.Open(path / "session.db"));
  Take(
      inject.Execute("CREATE TRIGGER fail_event_ack BEFORE UPDATE ON event_state BEGIN SELECT "
                     "RAISE(ABORT,'injected'); END"));
  Check(!events.Acknowledge(stream, 1), "ack fault");
  Check(Take(events.Load()).size() == 2 && Take(events.State()).at("ackedThrough") == "0",
        "ack deletion and cursor roll back together");
  Take(inject.Execute("DROP TRIGGER fail_event_ack"));
  Take(events.Acknowledge(stream, 1));
  Take(events.Acknowledge(stream, 0));
  Check(Take(events.Load()).size() == 1 && Take(events.State()).at("ackedThrough") == "1",
        "cumulative ack never moves backward");
  Check(!events.Acknowledge(stream, 3), "future ack rejected");
  Take(events.Rotate());
  const auto rotated = Take(events.State());
  Check(rotated.at("streamId") != stream && rotated.at("ackedThrough") == "0",
        "new stream after restore");
  const auto retained = Take(events.Load());
  Check(retained.size() == 1 && retained.at(0).at("eventId") == "second" &&
            retained.at(0).at("seq") == "1",
        "rotation preserves source identity and resequences retained events");
  Check(!events.Acknowledge(stream, 1), "retired stream ack rejected");
  Take(inject.Close());
  Take(store.Close());
  Check(!events.Acknowledge(rotated.at("streamId"), 1), "ack cannot reopen checkpoint database");
  SessionDb reopened(path);
  Take(reopened.Open());
  Check(Take(reopened.Events().Load()) == retained, "outbox survives reopen");
  const auto next = Take(reopened.Events().Append(
      "view.closed", {{"viewId", "2"}, {"reason", "script"}}, "after-restart", "new-browser"));
  Check(std::stoull(next.at("seq").get<std::string>()) >
            std::stoull(retained.at(0).at("seq").get<std::string>()),
        "durable stream sequence advances across Endpoint and Browser restart");
  const auto before_drop = Take(reopened.Events().State());
  // Escaping exceeds the serialized event bound while keeping clipboard fields valid.
  const auto dropped = Take(reopened.Events().Append("clipboard.changed",
                                                     {{"baseRevision", "9"},
                                                      {"browserSequence", "1"},
                                                      {"text", std::string(1024 * 1024, '\x01')},
                                                      {"html", ""},
                                                      {"excludeFromHistory", false}},
                                                     "oversize", "new-browser"));
  Check(dropped.value("dropped", false) && Take(reopened.Events().State()) == before_drop,
        "oversize event is dropped without consuming a durable sequence");
  Check(Take(reopened.Events().State()).at("streamId") == rotated.at("streamId"),
        "process restart retains the durable event stream");
}
}  // namespace
int wmain(int argc, wchar_t** argv) {
  if (argc != 2)
    return 2;
  const auto root = fs::path(argv[1]) / (L"session-db-" + std::to_wstring(GetCurrentProcessId()));
  try {
    fs::remove_all(root);
    Formats();
    MigrationRunner(root / "runner");
    UpgradeFromVersion3(root / "upgrade-v3");
    UpgradeDerivatives(root / "upgrade-derivatives");
    UpgradeDerivativeBounds(root / "upgrade-bounds");
    DerivativeDecoding(root / "derivative-decoding");
    DerivativeFailures(root / "thumbnail-failures", "thumbnail", 256);
    DerivativeFailures(root / "cache-failures", "selection-transcode", 1024);
    UpgradeGeometry(root / "upgrade-geometry");
    GeometryIsVolatile(root / "geometry");
    PresentationOrderIsVolatile(root / "order");
    Transactions(root / "transactions");
    EventTransactions(root / "events");
    Reads(root / "reads");
    fs::remove_all(root);
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
