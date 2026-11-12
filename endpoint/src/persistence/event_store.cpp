#include "persistence/session_db.hpp"
#include "persistence/session_documents.hpp"
#include "management/coordination.hpp"
#include "util/result_macros.hpp"
#include <limits>

namespace remotekit {
namespace {
Result<void> Done(sqlite::Statement& statement) {
  RK_ASSIGN_OR_RETURN(row, statement.Step());
  if (row)
    return CorruptState("unexpected event store row");
  return {};
}
Result<std::string> NewStream(sqlite::Database& db) {
  RK_ASSIGN_OR_RETURN(
      statement,
      db.Prepare(
          "SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||"
          "substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||"
          "lower(hex(randomblob(6)))"));
  RK_ASSIGN_OR_RETURN(row, statement.Step());
  if (!row)
    return CorruptState("missing event stream identity");
  return statement.Text(0);
}
}  // namespace
Result<Json> EventStore::State() {
  std::lock_guard lock(db_.mutex_);
  RK_ASSIGN_OR_RETURN(
      statement,
      db_.db_.Prepare("SELECT stream_id,acked_through,coalesce((SELECT seq FROM sqlite_sequence "
                      "WHERE name='events'),0),"
                      "(SELECT count(*) FROM events) FROM event_state WHERE singleton=1"));
  RK_ASSIGN_OR_RETURN(row, statement.Step());
  if (!row)
    return CorruptState("missing event stream state");
  return Json{{"streamId", statement.Text(0)},
              {"ackedThrough", std::to_string(statement.Int64(1))},
              {"lastSeq", std::to_string(statement.Int64(2))},
              {"pending", statement.Int64(3)}};
}
Result<Json> EventStore::Load(uint64_t after, size_t limit) {
  if (after > std::numeric_limits<int64_t>::max() || limit > coordination::kMaxEvents)
    return Error{ErrorCode::kInvalidRequest, "invalid event read bound"};
  std::lock_guard lock(db_.mutex_);
  RK_ASSIGN_OR_RETURN(
      statement, db_.db_.Prepare(
                     "SELECT seq,event_id,type,body FROM events WHERE seq>? ORDER BY seq LIMIT ?"));
  RK_RETURN_IF_ERROR(statement.Bind(1, static_cast<int64_t>(after)));
  RK_RETURN_IF_ERROR(statement.Bind(2, static_cast<int64_t>(limit)));
  Json result = Json::array();
  for (;;) {
    RK_ASSIGN_OR_RETURN(row, statement.Step());
    if (!row)
      return result;
    auto document = Json::parse(statement.Text(3), nullptr, false);
    try {
      session_documents::Event(statement.Text(2), document);
    } catch (const std::exception& error) {
      return CorruptRecord(std::string("events.body: ") + error.what());
    }
    document["seq"] = std::to_string(statement.Int64(0));
    document["eventId"] = statement.Text(1);
    document["type"] = statement.Text(2);
    result.push_back(std::move(document));
  }
}
Result<Json> EventStore::Append(const std::string& type,
                                const Json& body,
                                const std::string& event_id,
                                const Json& incarnation) {
  Json document{{"body", body}, {"browserIncarnation", incarnation}};
  try {
    persisted::Text(Json(event_id), 1, 128);
    session_documents::Event(type, document);
  } catch (const std::exception& error) {
    return CorruptRecord(std::string("events.body: ") + error.what());
  }
  const auto encoded = document.dump();
  const size_t bound = type == "clipboard.changed" ? coordination::kMaxDocumentBytes : 256 * 1024;
  if (encoded.size() > bound)
    return Error{ErrorCode::kLimitExceeded, "Session event exceeds bound"};
  Json event;
  auto written = db_.Write([&]() -> Result<void> {
    {
      RK_ASSIGN_OR_RETURN(existing,
                          db_.db_.Prepare("SELECT seq,type,body FROM events WHERE event_id=?"));
      RK_RETURN_IF_ERROR(existing.Bind(1, event_id));
      RK_ASSIGN_OR_RETURN(found, existing.Step());
      if (found) {
        if (existing.Text(1) != type || existing.Text(2) != encoded)
          return Error{ErrorCode::kConflict, "Session event identity conflicts"};
        event = document;
        event["seq"] = std::to_string(existing.Int64(0));
        return {};
      }
    }
    {
      RK_ASSIGN_OR_RETURN(
          usage, db_.db_.Prepare(
                     "SELECT count(*),coalesce(sum(length(CAST(body AS BLOB))),0) FROM events"));
      RK_ASSIGN_OR_RETURN(row, usage.Step());
      const bool terminal = type == "view.closed" || type.starts_with("download.");
      const size_t reserve = terminal ? 0 : coordination::kMaxViews;
      if (!row || usage.Int64(0) >= static_cast<int64_t>(coordination::kMaxEvents - reserve) ||
          usage.Int64(1) + encoded.size() > coordination::kMaxEventBytes - reserve * 1024)
        return Error{ErrorCode::kLimitExceeded, "Session event backlog full"};
    }
    RK_ASSIGN_OR_RETURN(
        statement,
        db_.db_.Prepare("INSERT INTO events(event_id,type,body) VALUES(?,?,?) RETURNING seq"));
    RK_RETURN_IF_ERROR(statement.Bind(1, event_id));
    RK_RETURN_IF_ERROR(statement.Bind(2, type));
    RK_RETURN_IF_ERROR(statement.Bind(3, encoded));
    RK_ASSIGN_OR_RETURN(row, statement.Step());
    if (!row || statement.Int64(0) <= 0)
      return CorruptState("missing event sequence");
    event = document;
    event["seq"] = std::to_string(statement.Int64(0));
    return Done(statement);
  });
  if (!written)
    return written.error();
  event["eventId"] = event_id;
  event["type"] = type;
  return event;
}
Result<void> EventStore::Acknowledge(const std::string& stream, uint64_t up_to) {
  return db_.Write([&]() -> Result<void> {
    RK_ASSIGN_OR_RETURN(state, State());
    if (state["streamId"] != stream || up_to > std::stoull(state["lastSeq"].get<std::string>()))
      return Error{ErrorCode::kConflict, "stale event acknowledgment"};
    const auto previous = std::stoull(state["ackedThrough"].get<std::string>());
    if (up_to <= previous)
      return {};
    RK_ASSIGN_OR_RETURN(remove, db_.db_.Prepare("DELETE FROM events WHERE seq<=?"));
    RK_RETURN_IF_ERROR(remove.Bind(1, static_cast<int64_t>(up_to)));
    RK_RETURN_IF_ERROR(Done(remove));
    RK_ASSIGN_OR_RETURN(
        update, db_.db_.Prepare("UPDATE event_state SET acked_through=? WHERE singleton=1"));
    RK_RETURN_IF_ERROR(update.Bind(1, static_cast<int64_t>(up_to)));
    return Done(update);
  });
}
Result<void> EventStore::Rotate() {
  return db_.Write([&]() -> Result<void> {
    RK_ASSIGN_OR_RETURN(events, Load(0, coordination::kMaxEvents));
    RK_ASSIGN_OR_RETURN(stream, NewStream(db_.db_));
    RK_RETURN_IF_ERROR(
        db_.db_.Execute("DELETE FROM events; DELETE FROM sqlite_sequence WHERE name='events'"));
    RK_ASSIGN_OR_RETURN(
        update,
        db_.db_.Prepare("UPDATE event_state SET stream_id=?,acked_through=0 WHERE singleton=1"));
    RK_RETURN_IF_ERROR(update.Bind(1, stream));
    RK_RETURN_IF_ERROR(Done(update));
    for (const auto& event : events) {
      RK_ASSIGN_OR_RETURN(appended, Append(event["type"], event["body"], event["eventId"],
                                           event["browserIncarnation"]));
    }
    return {};
  });
}
Result<void> EventStore::BeginPlacement(uint64_t epoch) {
  return db_.Write([&]() -> Result<void> {
    int64_t previous = 0;
    {
      RK_ASSIGN_OR_RETURN(
          statement,
          db_.db_.Prepare("SELECT placement_epoch FROM coordination_state WHERE singleton=1"));
      RK_ASSIGN_OR_RETURN(row, statement.Step());
      if (!row)
        return CorruptState("missing coordination state");
      previous = statement.Int64(0);
    }
    if (previous > static_cast<int64_t>(epoch))
      return Error{ErrorCode::kConflict, "event placement is fenced"};
    if (previous && previous != epoch)
      RK_RETURN_IF_ERROR(Rotate());
    RK_ASSIGN_OR_RETURN(
        statement,
        db_.db_.Prepare("UPDATE coordination_state SET placement_epoch=? WHERE singleton=1"));
    RK_RETURN_IF_ERROR(statement.Bind(1, static_cast<int64_t>(epoch)));
    return Done(statement);
  });
}
}  // namespace remotekit
