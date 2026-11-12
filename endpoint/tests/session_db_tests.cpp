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
      {session_documents::View, TestView(), "url"},
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
      {{4, "future-test", [](sqlite::Database& store) -> Result<void> {
          RK_RETURN_IF_ERROR(store.Execute("CREATE TABLE future_step(value TEXT)"));
          return CorruptState("injected migration failure");
        }}}};
  Check(!MigrateSessionDb(db, path, "dev", steps), "future step fails");
  {
    auto query = Take(db.Prepare("PRAGMA user_version"));
    Take(query.Step());
    Check(query.Int64(0) == 3, "migration rollback preserves schema version");
  }
  Check(std::distance(fs::directory_iterator(path / "backups"), fs::directory_iterator()) == 1,
        "verified pre-migration backup retained");
  const std::array<SessionMigration, 1> success{
      {{4, "future-test", [](sqlite::Database& store) -> Result<void> {
          return store.Execute("CREATE TABLE future_step(value TEXT)");
        }}}};
  Take(MigrateSessionDb(db, path, "dev", success));
  Take(CheckSessionDb(db, 4));
  Take(db.Close());
}
void Transactions(const fs::path& path) {
  SessionDb store(path);
  Take(store.Open());
  auto views = store.Views();
  auto recovery = store.Recovery();
  const auto config = TestView("1", "old");
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
  const auto dropped = Take(reopened.Events().Append(
      "clipboard.changed",
      {{"text", std::string(1024 * 1024 + 1, 'x')}, {"html", ""}, {"excludeFromHistory", false}},
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
