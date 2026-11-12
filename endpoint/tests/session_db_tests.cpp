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
Json Download(bool ack = true) {
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
                 {"browserAck", ack},
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
  Check(Take(views.Events()).empty() && Take(views.Load()) == Json::array({config}) &&
            Take(recovery.Contains("1")),
        "close rollback preserves every table");
  auto updated = config;
  updated["url"] = "new";
  Check(!views.Navigate("1", updated), "navigation failure");
  Check(Take(views.Load()) == Json::array({config}) && Take(recovery.Contains("1")),
        "navigation rollback");
  Take(inject.Execute("DROP TRIGGER fail_recovery"));
  Take(views.Navigate("1", updated));
  Check(!Take(recovery.Contains("1")) && Take(views.Load()) == Json::array({updated}),
        "navigation commits both tables");
  Take(recovery.Save("1", Recovery()));
  const auto event = Take(views.Close("1", "requested"));
  Check(Take(views.Load()).empty() && !Take(recovery.Contains("1")) &&
            Take(views.Events()).size() == 1,
        "close removes recovery and view");
  Take(store.Downloads().Save(Download()));
  Take(
      inject.Execute("CREATE TRIGGER fail_ack BEFORE DELETE ON download_imports BEGIN SELECT "
                     "RAISE(ABORT,'injected failure'); END"));
  Check(!views.Acknowledge({event.at("eventId"), "download-event"}), "ack failure");
  Check(
      Take(views.Events()).size() == 1 && Take(store.Downloads().Load()).at("records").size() == 1,
      "ack rollback");
  Take(inject.Execute("DROP TRIGGER fail_ack"));
  Take(views.Acknowledge({event.at("eventId"), "download-event"}));
  Check(Take(views.Events()).empty() && Take(store.Downloads().Load()).at("records").empty(),
        "ack transaction");
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
  Check(Take(reopened.Views().Events()).empty(), "reopen committed state");
}
void Write(const fs::path& path, const Json& value) {
  fs::create_directories(path.parent_path());
  std::ofstream(path) << value.dump();
}
void Legacy(const fs::path& path) {
  const std::string asset(64, 'a'), upload(32, 'b'), selection(32, 'c');
  Write(path / "browser.log", "legacy Browser log");
  Write(path / "crashes/events.jsonl", "legacy crash event");
  Write(path / "views.json", Json::array({{{"viewId", "1"}, {"url", "https://example.test"}}}));
  Write(path / "events.json", {{"next", 42},
                               {"events", Json::array({{{"eventId", "41"},
                                                        {"type", "view.closed"},
                                                        {"viewId", "2"},
                                                        {"reason", "requested"}}})}});
  Write(path / "download-imports.json", Download());
  Write(path / "site-preferences.json", {{"site", "discarded"}});
  Write(path / "recovery/1.json", Recovery());
  Write(path / "file-library/metadata" / (asset + ".json"),
        {{"assetId", asset}, {"size", 3}, {"type", "text/plain"}});
  Write(path / "file-library/drafts" / (upload + ".json"), {{"operation", "op"},
                                                            {"name", "a"},
                                                            {"type", "text/plain"},
                                                            {"size", 3},
                                                            {"expires", 2000000000},
                                                            {"sealed", ""}});
  fs::create_directories(path / "file-library/incoming");
  std::ofstream(path / "file-library/incoming" / upload) << "abc";
  Write(path / "file-library/selections" / (selection + ".json"), Selection());
  Write(path / "file-library/derivatives" / (asset + "-png.json"), {{"assetId", asset}});
  std::ofstream(path / "views.json.new") << "incomplete";
  {
    SessionDb store(path);
    Take(store.Open());
    Check(Take(store.Views().Load()).size() == 1 && Take(store.Views().Events()).size() == 1,
          "legacy views/events");
    Check(Take(store.Recovery().Load("1")) == Recovery(), "legacy recovery");
    Check(Take(store.Downloads().Load()) == Download(), "legacy downloads");
    for (const auto table : {LibraryTable::kAssets, LibraryTable::kDrafts,
                             LibraryTable::kSelections, LibraryTable::kDerivatives})
      Check(Take(store.Library().Load(table)).size() == 1, "legacy library");
    Check(Take(store.Views().Close("1", "requested")).at("eventId") == "42",
          "legacy event sequence");
  }
  Check(!fs::exists(path / "browser.log") && !fs::exists(path / "crashes"), "legacy logs removed");
  Check(!fs::exists(path / "views.json") && !fs::exists(path / "events.json") &&
            !fs::exists(path / "download-imports.json") &&
            !fs::exists(path / "site-preferences.json") && !fs::exists(path / "views.json.new") &&
            !fs::exists(path / "recovery") && !fs::exists(path / "file-library/metadata") &&
            !fs::exists(path / "file-library/drafts") &&
            !fs::exists(path / "file-library/selections") &&
            !fs::exists(path / "file-library/derivatives"),
        "legacy files deleted after commit");
  Check(fs::exists(path / "file-library/incoming" / upload), "legacy payload retained");
  const auto invalid = path / "invalid";
  Write(invalid / "views.json", Json::array({{{"viewId", "1"}}}));
  std::ofstream(invalid / "events.json") << "{";
  SessionDb bad(invalid);
  auto result = bad.Open();
  Check(!result && result.error().reason == ErrorReason::kCorruptState &&
            result.error().message.find("events.json") != std::string::npos,
        "invalid legacy classification");
  Check(fs::exists(invalid / "views.json") && fs::exists(invalid / "events.json") &&
            !fs::exists(invalid / "session.db"),
        "invalid legacy untouched");
  const auto unavailable = path / "unavailable";
  Write(unavailable / "views.json", Json::array({{{"viewId", "1"}}}));
  const auto file = CreateFileW((unavailable / "views.json").c_str(), GENERIC_READ, 0, nullptr,
                                OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  Check(file != INVALID_HANDLE_VALUE, "hold legacy file");
  SessionDb locked(unavailable);
  auto failed = locked.Open();
  CloseHandle(file);
  Check(!failed && failed.error().code == ErrorCode::kUnavailable,
        "unreadable legacy classification");
  Check(fs::exists(unavailable / "views.json") && !fs::exists(unavailable / "session.db"),
        "unreadable legacy untouched");
  Take(locked.Open());
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
  Take(db.Execute("PRAGMA user_version=2"));
  Take(db.Close());
  fs::create_directory(path / "unsupported");
  fs::rename(path / "unsupported.db", path / "unsupported/session.db");
  SessionDb unsupported(path / "unsupported");
  auto result = unsupported.Open();
  Check(!result && result.error().reason == ErrorReason::kCorruptState &&
            result.error().message == "unsupported session store version",
        "unsupported schema classification");
}
}  // namespace
int wmain(int argc, wchar_t** argv) {
  if (argc != 2)
    return 2;
  const auto root = fs::path(argv[1]) / (L"session-db-" + std::to_wstring(GetCurrentProcessId()));
  try {
    fs::remove_all(root);
    Transactions(root / "transactions");
    Legacy(root / "legacy");
    Reads(root / "reads");
    fs::remove_all(root);
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
