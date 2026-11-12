#include "persistence/session_db.hpp"
#include "session/view_configuration.hpp"
#include "files/dc_file_services.hpp"
#include "util/file_io.hpp"
#include "util/result_macros.hpp"
#include <charconv>
#include <limits>
namespace remotekit {
namespace {
Result<int64_t> Decimal(const Json& value) {
  if (!value.is_string())
    return CorruptState("invalid session store decimal");
  const auto& text = value.get_ref<const std::string&>();
  int64_t number = 0;
  const auto parsed = std::from_chars(text.data(), text.data() + text.size(), number);
  if (parsed.ec != std::errc{} || parsed.ptr != text.data() + text.size() || number < 0)
    return CorruptState("invalid session store decimal");
  return number;
}
Result<void> Done(sqlite::Statement& statement) {
  RK_ASSIGN_OR_RETURN(row, statement.Step());
  if (row)
    return Error{ErrorCode::kInternal, "unexpected session store row"};
  return {};
}
Result<void> View(const Json& view) {
  RK_RETURN_IF_ERROR(ValidateViewConfiguration(view));
  if (!view.contains("viewId"))
    return CorruptState("missing viewId");
  if (!view.at("viewId").is_string())
    return CorruptState("invalid viewId");
  const auto& text = view.at("viewId").get_ref<const std::string&>();
  uint64_t id = 0;
  const auto parsed = std::from_chars(text.data(), text.data() + text.size(), id);
  if (text.empty() || text.front() == '0' || !id || parsed.ec != std::errc{} ||
      parsed.ptr != text.data() + text.size())
    return CorruptState("invalid viewId");
  return {};
}
const char* TableName(LibraryTable table) {
  switch (table) {
    case LibraryTable::kAssets:
      return "library_assets";
    case LibraryTable::kDrafts:
      return "library_drafts";
    case LibraryTable::kSelections:
      return "library_selections";
    case LibraryTable::kDerivatives:
      return "library_derivatives";
  }
  std::terminate();
}
}  // namespace
Result<void> SessionDb::Open() {
  std::lock_guard lock(mutex_);
  if (closed_)
    return Error{ErrorCode::kInternal, "session store opened after checkpoint close"};
  RK_RETURN_IF_ERROR(CreateDirectories(directory_));
  return OpenFile(directory_ / "session.db");
}
Result<void> SessionDb::OpenReadOnly(bool immutable) {
  std::lock_guard lock(mutex_);
  RK_RETURN_IF_ERROR(db_.OpenReadOnly(directory_ / "session.db", immutable));
  closed_ = true;
  return {};
}
Result<void> SessionDb::OpenFile(const fs::path& path) {
  RK_RETURN_IF_ERROR(db_.Open(path));
  int64_t version = 0;
  {
    RK_ASSIGN_OR_RETURN(statement, db_.Prepare("PRAGMA user_version"));
    RK_ASSIGN_OR_RETURN(row, statement.Step());
    if (!row)
      return CorruptState("missing session store version");
    version = statement.Int64(0);
  }
  if (version == 3)
    return {};
  if (version == 1 || version == 2)
    return Write([&]() -> Result<void> {
      if (version == 1) {
        RK_RETURN_IF_ERROR(db_.Execute(R"sql(
CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,type TEXT NOT NULL,body TEXT NOT NULL);
CREATE TABLE event_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),stream_id TEXT NOT NULL,acked_through INTEGER NOT NULL);
INSERT INTO event_state VALUES(1,lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),0);
CREATE TABLE retired_views(view_id TEXT PRIMARY KEY,event_id TEXT NOT NULL);
)sql"));
      }
      RK_RETURN_IF_ERROR(db_.Execute(R"sql(
INSERT INTO retired_views(view_id,event_id)
 SELECT view_id,'closed-'||(SELECT stream_id FROM event_state)||'-'||event_id FROM closed_events;
INSERT INTO events(event_id,type,body)
 SELECT r.event_id,'view.closed',json_object('browserIncarnation',NULL,'body',json_object('viewId',c.view_id,'reason',c.reason))
 FROM closed_events c JOIN retired_views r ON r.view_id=c.view_id ORDER BY c.event_id;
DROP TABLE closed_events;
INSERT INTO events(event_id,type,body)
 SELECT event_id,json_extract(result,'$.type'),json_object('browserIncarnation',incarnation,'body',json(json_remove(result,'$.type','$.eventId')))
 FROM download_imports WHERE browser_ack=1;
DELETE FROM download_imports WHERE browser_ack=1;
ALTER TABLE download_imports DROP COLUMN browser_ack;
ALTER TABLE views ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
CREATE TABLE coordination_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),placement_epoch INTEGER NOT NULL,desired_revision TEXT NOT NULL);
INSERT INTO coordination_state VALUES(1,0,'0');
CREATE TABLE view_runtime(view_id TEXT PRIMARY KEY,resume_url TEXT,original_browser TEXT);
PRAGMA user_version=3;
)sql"));
      return {};
    });
  if (version != 0)
    return CorruptState("unsupported session store version");
  {
    RK_ASSIGN_OR_RETURN(statement, db_.Prepare("SELECT count(*) FROM sqlite_master"));
    RK_ASSIGN_OR_RETURN(row, statement.Step());
    if (!row || statement.Int64(0))
      return CorruptState("unsupported session store version");
  }
  return Write([&]() -> Result<void> {
    return db_.Execute(R"sql(
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
CREATE TABLE library_assets(asset_id TEXT PRIMARY KEY, size INTEGER NOT NULL, type TEXT NOT NULL, width INTEGER, height INTEGER);
CREATE TABLE library_drafts(upload_id TEXT PRIMARY KEY, operation TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
 size INTEGER NOT NULL, expires INTEGER NOT NULL, sealed TEXT NOT NULL);
CREATE TABLE library_selections(selection_id TEXT PRIMARY KEY, state TEXT NOT NULL, document TEXT NOT NULL);
CREATE TABLE library_derivatives(asset_id TEXT NOT NULL, format TEXT NOT NULL, derived_id TEXT NOT NULL, PRIMARY KEY(asset_id, format));
PRAGMA user_version=3;
)sql");
  });
}
Result<void> SessionDb::Close() {
  std::lock_guard lock(mutex_);
  RK_RETURN_IF_ERROR(db_.Close());
  closed_ = true;
  return {};
}
Result<void> SessionDb::Write(const std::function<Result<void>()>& action) {
  std::lock_guard lock(mutex_);
  if (closed_)
    return Error{ErrorCode::kInternal, "session store write after checkpoint close"};
  if (writing_)
    return action();
  sqlite::Transaction transaction(db_);
  RK_RETURN_IF_ERROR(transaction.Begin());
  writing_ = true;
  struct Finish {
    bool& writing;
    ~Finish() { writing = false; }
  } finish{writing_};
  RK_RETURN_IF_ERROR(action());
  return transaction.Commit();
}
Result<void> SessionDb::Delete(const char* sql, const std::string& id) {
  RK_ASSIGN_OR_RETURN(statement, db_.Prepare(sql));
  RK_RETURN_IF_ERROR(statement.Bind(1, id));
  return Done(statement);
}
Result<Json> ViewStore::Load() {
  std::lock_guard lock(db_.mutex_);
  RK_ASSIGN_OR_RETURN(
      statement, db_.db_.Prepare("SELECT config,view_id FROM views ORDER BY position,view_id"));
  Json views = Json::array();
  for (;;) {
    RK_ASSIGN_OR_RETURN(row, statement.Step());
    if (!row)
      break;
    auto config = Json::parse(statement.Text(0), nullptr, false);
    if (config.is_discarded())
      return CorruptState("invalid views.config");
    auto valid = View(config);
    if (!valid)
      return CorruptState("invalid views.config: " + valid.error().message);
    if (config.at("viewId") != statement.Text(1))
      return CorruptState("mismatched views.view_id");
    views.push_back(std::move(config));
  }
  return views;
}
Result<void> ViewStore::Save(const Json& views) {
  if (!views.is_array())
    return CorruptState("invalid views.config collection");
  return db_.Write([&]() -> Result<void> {
    RK_RETURN_IF_ERROR(db_.db_.Execute("DELETE FROM views"));
    int64_t position = 0;
    for (const auto& view : views) {
      auto valid = View(view);
      if (!valid)
        return CorruptState("invalid views.config: " + valid.error().message);
      RK_ASSIGN_OR_RETURN(statement, db_.db_.Prepare("INSERT INTO views VALUES(?,?,?)"));
      RK_RETURN_IF_ERROR(statement.Bind(1, view.at("viewId").get<std::string>()));
      RK_RETURN_IF_ERROR(statement.Bind(2, view.dump()));
      RK_RETURN_IF_ERROR(statement.Bind(3, position++));
      RK_RETURN_IF_ERROR(Done(statement));
    }
    return {};
  });
}
Result<void> ViewStore::SaveDesired(const Json& views,
                                    uint64_t epoch,
                                    const std::string& revision) {
  return db_.Write([&]() -> Result<void> {
    RK_RETURN_IF_ERROR(db_.Events().BeginPlacement(epoch));
    RK_RETURN_IF_ERROR(Save(views));
    RK_RETURN_IF_ERROR(db_.db_.Execute(
        "DELETE FROM retired_views WHERE view_id NOT IN (SELECT view_id FROM views); DELETE FROM "
        "view_runtime WHERE view_id NOT IN (SELECT view_id FROM views)"));
    RK_ASSIGN_OR_RETURN(
        statement,
        db_.db_.Prepare("UPDATE coordination_state SET desired_revision=? WHERE singleton=1"));
    RK_RETURN_IF_ERROR(statement.Bind(1, revision));
    return Done(statement);
  });
}
Result<Json> ViewStore::Retired() {
  std::lock_guard lock(db_.mutex_);
  RK_ASSIGN_OR_RETURN(statement,
                      db_.db_.Prepare("SELECT view_id FROM retired_views ORDER BY view_id"));
  Json result = Json::array();
  for (;;) {
    RK_ASSIGN_OR_RETURN(row, statement.Step());
    if (!row)
      return result;
    result.push_back(statement.Text(0));
  }
}
Result<Json> ViewStore::Close(const std::string& view,
                              const std::string& reason,
                              const Json& incarnation) {
  Json event;
  auto result = db_.Write([&]() -> Result<void> {
    {
      RK_ASSIGN_OR_RETURN(existing,
                          db_.db_.Prepare("SELECT event_id FROM retired_views WHERE view_id=?"));
      RK_RETURN_IF_ERROR(existing.Bind(1, view));
      RK_ASSIGN_OR_RETURN(found, existing.Step());
      if (found) {
        event = {{"eventId", existing.Text(0)},
                 {"type", "view.closed"},
                 {"body", {{"viewId", view}, {"reason", reason}}},
                 {"browserIncarnation", incarnation}};
        return {};
      }
    }
    const auto identity = "closed-" + db_.directory_.filename().string() + "-" + view;
    RK_ASSIGN_OR_RETURN(appended,
                        db_.Events().Append("view.closed", {{"viewId", view}, {"reason", reason}},
                                            identity, incarnation));
    event = std::move(appended);
    RK_ASSIGN_OR_RETURN(retire, db_.db_.Prepare("INSERT INTO retired_views VALUES(?,?)"));
    RK_RETURN_IF_ERROR(retire.Bind(1, view));
    RK_RETURN_IF_ERROR(retire.Bind(2, identity));
    RK_RETURN_IF_ERROR(Done(retire));
    RK_RETURN_IF_ERROR(db_.Delete("DELETE FROM view_runtime WHERE view_id=?", view));
    return db_.Delete("DELETE FROM navigation_recovery WHERE view_id=?", view);
  });
  if (!result)
    return result.error();
  return event;
}
Result<void> ViewStore::CommitNavigation(const std::string& view, const std::string& url) {
  return db_.Write([&]() -> Result<void> {
    RK_ASSIGN_OR_RETURN(
        statement,
        db_.db_.Prepare("INSERT INTO view_runtime(view_id,resume_url) VALUES(?,?) ON "
                        "CONFLICT(view_id) DO UPDATE SET resume_url=excluded.resume_url"));
    RK_RETURN_IF_ERROR(statement.Bind(1, view));
    RK_RETURN_IF_ERROR(statement.Bind(2, url));
    return Done(statement);
  });
}
Result<std::string> ViewStore::ResumeUrl(const std::string& view, const std::string& fallback) {
  std::lock_guard lock(db_.mutex_);
  RK_ASSIGN_OR_RETURN(statement,
                      db_.db_.Prepare("SELECT resume_url FROM view_runtime WHERE view_id=?"));
  RK_RETURN_IF_ERROR(statement.Bind(1, view));
  RK_ASSIGN_OR_RETURN(row, statement.Step());
  return row && !statement.IsNull(0) ? statement.Text(0) : fallback;
}
Result<bool> ViewStore::SignInCurrent(const std::string& view, const std::string& incarnation) {
  bool current = false;
  auto result = db_.Write([&]() -> Result<void> {
    RK_ASSIGN_OR_RETURN(
        statement,
        db_.db_.Prepare(
            "INSERT INTO view_runtime(view_id,original_browser) VALUES(?,?) ON CONFLICT(view_id) "
            "DO UPDATE SET original_browser=coalesce(original_browser,excluded.original_browser) "
            "RETURNING original_browser"));
    RK_RETURN_IF_ERROR(statement.Bind(1, view));
    RK_RETURN_IF_ERROR(statement.Bind(2, incarnation));
    RK_ASSIGN_OR_RETURN(row, statement.Step());
    current = row && statement.Text(0) == incarnation;
    return Done(statement);
  });
  if (!result)
    return result.error();
  return current;
}
Result<bool> RecoveryStore::Contains(const std::string& view) {
  std::lock_guard lock(db_.mutex_);
  RK_ASSIGN_OR_RETURN(statement,
                      db_.db_.Prepare("SELECT 1 FROM navigation_recovery WHERE view_id=?"));
  RK_RETURN_IF_ERROR(statement.Bind(1, view));
  return statement.Step();
}
Result<Json> RecoveryStore::Load(const std::string& view) {
  std::lock_guard lock(db_.mutex_);
  RK_ASSIGN_OR_RETURN(
      statement,
      db_.db_.Prepare("SELECT navigation_revision,state FROM navigation_recovery WHERE view_id=?"));
  RK_RETURN_IF_ERROR(statement.Bind(1, view));
  RK_ASSIGN_OR_RETURN(row, statement.Step());
  if (!row)
    return Error{ErrorCode::kNotFound, "navigation recovery not found"};
  const auto bytes = statement.Blob(1);
  if (bytes.empty() || bytes.size() > 64 * 1024 * 1024 || statement.Int64(0) < 0)
    return CorruptState("invalid navigation recovery state");
  Json chunks = Json::array();
  constexpr size_t chunk_size = 256 * 1024;
  for (size_t offset = 0; offset < bytes.size(); offset += chunk_size) {
    std::vector<uint8_t> chunk(bytes.begin() + offset,
                               bytes.begin() + std::min(bytes.size(), offset + chunk_size));
    chunks.push_back({{"data", EncodeFileChunk(chunk)}, {"bytes", chunk.size()}});
  }
  return Json{{"size", std::to_string(bytes.size())},
              {"navigationRevision", std::to_string(statement.Int64(0))},
              {"chunks", std::move(chunks)}};
}
Result<void> RecoveryStore::Save(const std::string& view, const Json& document) {
  try {
    RK_ASSIGN_OR_RETURN(size, Decimal(document.at("size")));
    RK_ASSIGN_OR_RETURN(revision, Decimal(document.at("navigationRevision")));
    if (!size || size > 64 * 1024 * 1024 || !document.at("chunks").is_array() ||
        document.at("chunks").size() > 256)
      return CorruptState("invalid navigation recovery size/chunks");
    std::vector<uint8_t> bytes;
    for (const auto& chunk : document.at("chunks")) {
      auto decoded = DecodeFileChunk(chunk.at("data"), 64 * 1024 * 1024);
      if (!decoded || decoded.value().size() != chunk.at("bytes").get<uint64_t>() ||
          decoded.value().size() > static_cast<uint64_t>(size) - bytes.size())
        return CorruptState("invalid navigation recovery chunk");
      bytes.insert(bytes.end(), decoded.value().begin(), decoded.value().end());
    }
    if (bytes.size() != size)
      return CorruptState("invalid navigation recovery length");
    return db_.Write([&]() -> Result<void> {
      RK_ASSIGN_OR_RETURN(
          statement, db_.db_.Prepare("INSERT OR REPLACE INTO navigation_recovery VALUES(?,?,?)"));
      RK_RETURN_IF_ERROR(statement.Bind(1, view));
      RK_RETURN_IF_ERROR(statement.Bind(2, revision));
      RK_RETURN_IF_ERROR(statement.Bind(3, std::span<const uint8_t>(bytes)));
      return Done(statement);
    });
  } catch (const std::exception& error) {
    return CorruptState(std::string("invalid navigation recovery: ") + error.what());
  }
}
Result<void> RecoveryStore::Erase(const std::string& view) {
  return db_.Write(
      [&] { return db_.Delete("DELETE FROM navigation_recovery WHERE view_id=?", view); });
}
Result<void> ValidateDownloadState(const Json& state) {
  try {
    if (!state.at("records").is_array())
      return CorruptState("invalid download imports");
    std::set<std::string> ids;
    for (const auto& row : state.at("records")) {
      if (row.at("incarnation").get<std::string>().empty() || !row.at("download").is_object() ||
          !ids.insert(row.at("eventId").get<std::string>()).second)
        return CorruptState("invalid download import row");
      const auto& download = row.at("download");
      for (const auto* key :
           {"guid", "eventId", "fileReference", "name", "mimeType", "size", "origin"})
        download.at(key).get<std::string>();
      if (row.contains("result")) {
        const auto& result = row.at("result");
        if (!result.is_object() || result.at("eventId") != row.at("eventId"))
          return CorruptState("invalid download result");
        result.at("type").get<std::string>();
      }
      if (row.contains("attempt"))
        row.at("attempt").get<unsigned>();
      if (row.contains("retryAt"))
        row.at("retryAt").get<int64_t>();
      if (row.contains("error") && !row.at("error").is_object())
        return CorruptState("invalid download error");
    }
    return {};
  } catch (const std::exception& error) {
    return CorruptState(std::string("invalid download imports: ") + error.what());
  }
}
Result<Json> DownloadStore::Load() {
  std::lock_guard lock(db_.mutex_);
  RK_ASSIGN_OR_RETURN(
      statement,
      db_.db_.Prepare("SELECT event_id,incarnation,download,result,attempt,error,retry_at FROM "
                      "download_imports ORDER BY rowid"));
  Json records = Json::array();
  for (;;) {
    RK_ASSIGN_OR_RETURN(row, statement.Step());
    if (!row)
      break;
    auto download = Json::parse(statement.Text(2), nullptr, false);
    if (download.is_discarded())
      return CorruptState("invalid download_imports.download");
    Json value = {
        {"eventId", statement.Text(0)}, {"incarnation", statement.Text(1)}, {"download", download}};
    for (const auto [column, name] : {std::pair{3, "result"}, {5, "error"}}) {
      if (!statement.IsNull(column)) {
        auto document = Json::parse(statement.Text(column), nullptr, false);
        if (document.is_discarded())
          return CorruptState("invalid download import document");
        value[name] = std::move(document);
      }
    }
    if (!statement.IsNull(4))
      value["attempt"] = statement.Int64(4);
    if (!statement.IsNull(6))
      value["retryAt"] = statement.Int64(6);
    records.push_back(std::move(value));
  }
  Json state = {{"records", std::move(records)}};
  RK_RETURN_IF_ERROR(ValidateDownloadState(state));
  return state;
}
Result<void> DownloadStore::Save(const Json& state) {
  RK_RETURN_IF_ERROR(ValidateDownloadState(state));
  return db_.Write([&]() -> Result<void> {
    RK_RETURN_IF_ERROR(db_.db_.Execute("DELETE FROM download_imports"));
    for (const auto& row : state.at("records")) {
      RK_ASSIGN_OR_RETURN(statement,
                          db_.db_.Prepare("INSERT INTO download_imports VALUES(?,?,?,?,?,?,?)"));
      RK_RETURN_IF_ERROR(statement.Bind(1, row.at("eventId").get<std::string>()));
      RK_RETURN_IF_ERROR(statement.Bind(2, row.at("incarnation").get<std::string>()));
      RK_RETURN_IF_ERROR(statement.Bind(3, row.at("download").dump()));
      for (const auto [column, name] : {std::pair{4, "result"}, {6, "error"}}) {
        if (row.contains(name)) {
          RK_RETURN_IF_ERROR(statement.Bind(column, row.at(name).dump()));
        } else {
          RK_RETURN_IF_ERROR(statement.BindNull(column));
        }
      }
      for (const auto [column, name] : {std::pair{5, "attempt"}, {7, "retryAt"}}) {
        if (row.contains(name)) {
          RK_RETURN_IF_ERROR(statement.Bind(column, row.at(name).get<int64_t>()));
        } else {
          RK_RETURN_IF_ERROR(statement.BindNull(column));
        }
      }
      RK_RETURN_IF_ERROR(Done(statement));
    }
    return {};
  });
}
Result<void> DownloadStore::Complete(const std::string& event_id) {
  return db_.Write([&]() -> Result<void> {
    Json result;
    std::string incarnation;
    {
      RK_ASSIGN_OR_RETURN(
          statement,
          db_.db_.Prepare("SELECT result,incarnation FROM download_imports WHERE event_id=?"));
      RK_RETURN_IF_ERROR(statement.Bind(1, event_id));
      RK_ASSIGN_OR_RETURN(row, statement.Step());
      if (!row || statement.IsNull(0))
        return CorruptState("download result missing at handoff");
      result = Json::parse(statement.Text(0), nullptr, false);
      incarnation = statement.Text(1);
    }
    if (!result.is_object() || !result.contains("type"))
      return CorruptState("invalid download handoff");
    const auto type = result["type"].get<std::string>();
    result.erase("type");
    result.erase("eventId");
    RK_ASSIGN_OR_RETURN(event, db_.Events().Append(type, result, event_id, incarnation));
    return db_.Delete("DELETE FROM download_imports WHERE event_id=?", event_id);
  });
}
Result<std::map<std::string, Json>> LibraryStore::Load(LibraryTable table) {
  std::lock_guard lock(db_.mutex_);
  auto query = std::string("SELECT * FROM ") + TableName(table);
  RK_ASSIGN_OR_RETURN(statement, db_.db_.Prepare(query.c_str()));
  std::map<std::string, Json> result;
  for (;;) {
    RK_ASSIGN_OR_RETURN(row, statement.Step());
    if (!row)
      break;
    std::string id = statement.Text(0);
    Json value;
    switch (table) {
      case LibraryTable::kAssets:
        value = {{"assetId", id}, {"size", statement.Int64(1)}, {"type", statement.Text(2)}};
        if (!statement.IsNull(3))
          value["width"] = statement.Int64(3);
        if (!statement.IsNull(4))
          value["height"] = statement.Int64(4);
        break;
      case LibraryTable::kDrafts:
        value = {{"operation", statement.Text(1)}, {"name", statement.Text(2)},
                 {"type", statement.Text(3)},      {"size", statement.Int64(4)},
                 {"expires", statement.Int64(5)},  {"sealed", statement.Text(6)}};
        break;
      case LibraryTable::kSelections:
        value = Json::parse(statement.Text(2), nullptr, false);
        if (value.is_discarded() || !value.is_object() || !value.contains("state") ||
            !value["state"].is_string() || value["state"] != statement.Text(1))
          return CorruptState("invalid library selection");
        break;
      case LibraryTable::kDerivatives:
        id += "-" + statement.Text(1);
        value = {{"assetId", statement.Text(2)}};
        break;
    }
    result.emplace(std::move(id), std::move(value));
  }
  return result;
}
Result<void> SessionDb::PutLibrary(LibraryTable table, const std::string& id, const Json& value) {
  const char* query = table == LibraryTable::kAssets
                          ? "INSERT OR REPLACE INTO library_assets VALUES(?,?,?,?,?)"
                      : table == LibraryTable::kDrafts
                          ? "INSERT OR REPLACE INTO library_drafts VALUES(?,?,?,?,?,?,?)"
                      : table == LibraryTable::kSelections
                          ? "INSERT OR REPLACE INTO library_selections VALUES(?,?,?)"
                          : "INSERT OR REPLACE INTO library_derivatives VALUES(?,?,?)";
  RK_ASSIGN_OR_RETURN(statement, db_.Prepare(query));
  if (table == LibraryTable::kDerivatives) {
    const auto dash = id.find('-');
    if (dash == std::string::npos)
      return CorruptState("invalid derivative key");
    RK_RETURN_IF_ERROR(statement.Bind(1, id.substr(0, dash)));
    RK_RETURN_IF_ERROR(statement.Bind(2, id.substr(dash + 1)));
    RK_RETURN_IF_ERROR(statement.Bind(3, value.at("assetId").get<std::string>()));
  } else {
    RK_RETURN_IF_ERROR(statement.Bind(1, id));
    if (table == LibraryTable::kAssets) {
      RK_RETURN_IF_ERROR(statement.Bind(2, value.at("size").get<int64_t>()));
      RK_RETURN_IF_ERROR(statement.Bind(3, value.at("type").get<std::string>()));
      for (const auto [column, name] : {std::pair{4, "width"}, {5, "height"}}) {
        if (value.contains(name)) {
          RK_RETURN_IF_ERROR(statement.Bind(column, value.at(name).get<int64_t>()));
        } else {
          RK_RETURN_IF_ERROR(statement.BindNull(column));
        }
      }
    } else if (table == LibraryTable::kDrafts) {
      int column = 2;
      for (const auto* name : {"operation", "name", "type"}) {
        RK_RETURN_IF_ERROR(statement.Bind(column++, value.at(name).get<std::string>()));
      }
      RK_RETURN_IF_ERROR(statement.Bind(5, value.at("size").get<int64_t>()));
      RK_RETURN_IF_ERROR(statement.Bind(6, value.at("expires").get<int64_t>()));
      RK_RETURN_IF_ERROR(statement.Bind(7, value.at("sealed").get<std::string>()));
    } else {
      RK_RETURN_IF_ERROR(statement.Bind(2, value.at("state").get<std::string>()));
      RK_RETURN_IF_ERROR(statement.Bind(3, value.dump()));
    }
  }
  return Done(statement);
}
Result<void> LibraryStore::Save(LibraryTable table, const std::string& id, const Json& value) {
  return db_.Write([&] { return db_.PutLibrary(table, id, value); });
}
Result<void> LibraryStore::Erase(LibraryTable table, const std::string& id) {
  const char* key = table == LibraryTable::kAssets   ? "asset_id"
                    : table == LibraryTable::kDrafts ? "upload_id"
                                                     : "selection_id";
  if (table == LibraryTable::kDerivatives)
    return Error{ErrorCode::kInternal, "invalid library erase"};
  auto sql = std::string("DELETE FROM ") + TableName(table) + " WHERE " + key + "=?";
  return db_.Write([&] { return db_.Delete(sql.c_str(), id); });
}
Result<void> LibraryStore::ClearDrafts() {
  return db_.Write([&] { return db_.db_.Execute("DELETE FROM library_drafts"); });
}
Result<void> LibraryStore::Selections(const std::map<std::string, Json>& documents) {
  return db_.Write([&]() -> Result<void> {
    for (const auto& [id, value] : documents) {
      RK_RETURN_IF_ERROR(db_.PutLibrary(LibraryTable::kSelections, id, value));
    }
    return {};
  });
}
Result<void> LibraryStore::Seal(const std::string& asset,
                                const Json& metadata,
                                const std::string& upload,
                                const Json& draft,
                                const std::string& derivative) {
  return db_.Write([&]() -> Result<void> {
    RK_RETURN_IF_ERROR(db_.PutLibrary(LibraryTable::kAssets, asset, metadata));
    if (!upload.empty()) {
      RK_RETURN_IF_ERROR(db_.PutLibrary(LibraryTable::kDrafts, upload, draft));
    }
    if (!derivative.empty()) {
      RK_RETURN_IF_ERROR(
          db_.PutLibrary(LibraryTable::kDerivatives, derivative, {{"assetId", asset}}));
    }
    return {};
  });
}
}  // namespace remotekit
