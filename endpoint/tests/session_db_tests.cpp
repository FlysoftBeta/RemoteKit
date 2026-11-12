#include "persistence/session_db.hpp"
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
  return {{"records",
           Json::array(
               {{{"incarnation", "browser"},
                 {"eventId", "download-event"},
                 {"download",
                  {{"guid", "guid"},
                   {"eventId", "browser-event"},
                   {"fileReference", "downloads/a"},
                   {"name", "a"},
                   {"mimeType", "text/plain"},
                   {"size", "3"},
                   {"origin", ""}}},
                 {"result", {{"type", "download.imported"}, {"eventId", "download-event"}}}}})}};
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
void Transactions(const fs::path& path) {
  SessionDb store(path);
  Take(store.Open());
  auto views = store.Views();
  auto recovery = store.Recovery();
  const auto config = Json{{"viewId", "1"}, {"url", "old"}};
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
  sqlite::Database db;
  Take(db.Open(path / "unsupported.db"));
  Take(db.Execute("PRAGMA user_version=4"));
  Take(db.Close());
  fs::create_directory(path / "unsupported");
  fs::rename(path / "unsupported.db", path / "unsupported/session.db");
  SessionDb unsupported(path / "unsupported");
  auto result = unsupported.Open();
  Check(!result && result.error().reason == ErrorReason::kCorruptState &&
            result.error().message == "unsupported session store version",
        "unsupported schema classification");
}
void StableMigration(const fs::path& root) {
  const auto first = root / "one" / std::string(32, 'a');
  const auto second = root / "two" / std::string(32, 'a');
  fs::create_directories(first);
  fs::create_directories(second);
  sqlite::Database seed;
  Take(seed.Open(first / "session.db"));
  Take(seed.Execute(R"sql(
CREATE TABLE views(view_id TEXT PRIMARY KEY,config TEXT NOT NULL);
CREATE TABLE closed_events(event_id INTEGER PRIMARY KEY,view_id TEXT NOT NULL,reason TEXT NOT NULL);
INSERT INTO closed_events VALUES(1,'9','script');
CREATE TABLE download_imports(event_id TEXT PRIMARY KEY,incarnation TEXT NOT NULL,download TEXT NOT NULL,result TEXT,browser_ack INTEGER NOT NULL,attempt INTEGER,error TEXT,retry_at INTEGER);
PRAGMA user_version=1;
)sql"));
  Take(seed.Close());
  fs::copy_file(first / "session.db", second / "session.db");
  SessionDb migrated(first), restored(second);
  Take(migrated.Open());
  Take(restored.Open());
  const auto original = Take(migrated.Events().Load()).at(0);
  const auto replayed = Take(restored.Events().Load()).at(0);
  Check(original.at("eventId") == replayed.at("eventId"),
        "checkpoint migration preserves source event identity");
  Check(Take(migrated.Events().State()).at("streamId") !=
            Take(restored.Events().State()).at("streamId"),
        "restored migrations get separate streams");
  Check(Take(restored.Views().Retired()) == Json::array({"9"}),
        "migration retains close retirement");
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
  Take(events.Append(
      "clipboard.changed",
      {{"baseRevision", "9"}, {"browserSequence", "3"}, {"text", "native"}, {"html", ""}}, "second",
      "browser"));
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
    Transactions(root / "transactions");
    EventTransactions(root / "events");
    StableMigration(root / "migration");
    Reads(root / "reads");
    fs::remove_all(root);
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
