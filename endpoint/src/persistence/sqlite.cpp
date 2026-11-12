#include "persistence/sqlite.hpp"
#include "util/result_macros.hpp"
#include <sqlite3.h>
#include <utility>

namespace remotekit::sqlite {
Database::~Database() {
  if (handle_)
    sqlite3_close_v2(handle_);
}
Error Database::Failure(const char* operation, int code) const {
  const int extended = handle_ ? sqlite3_extended_errcode(handle_) : code;
  const int primary = code & 255;
  ErrorCode kind = ErrorCode::kInternal;
  std::optional<ErrorReason> reason;
  if (primary == SQLITE_BUSY || primary == SQLITE_LOCKED)
    kind = ErrorCode::kBusy;
  else if (primary == SQLITE_IOERR || primary == SQLITE_CANTOPEN || primary == SQLITE_FULL ||
           primary == SQLITE_PERM)
    kind = ErrorCode::kUnavailable;
  else if (primary == SQLITE_CORRUPT || primary == SQLITE_NOTADB)
    reason = ErrorReason::kCorruptState;
  return Error{kind,
               std::string("session store ") + operation + ": " +
                   (handle_ ? sqlite3_errmsg(handle_) : "database is closed") + " (sqlite " +
                   std::to_string(extended) + ")",
               reason,
               {},
               OsError{OsError::Kind::kSqlite, extended}};
}
Result<void> Database::Open(const std::filesystem::path& path) {
  if (handle_)
    return Error{ErrorCode::kInternal, "session store already open"};
  const auto utf8 = path.u8string();
  int code =
      sqlite3_open_v2(reinterpret_cast<const char*>(utf8.c_str()), &handle_,
                      SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nullptr);
  if (code != SQLITE_OK) {
    auto error = Failure("open", code);
    Close();
    return error;
  }
  sqlite3_extended_result_codes(handle_, 1);
  RK_RETURN_IF_ERROR(Execute("PRAGMA journal_mode=WAL"));
  RK_RETURN_IF_ERROR(Execute("PRAGMA synchronous=FULL"));
  return Execute("PRAGMA busy_timeout=0");
}
Result<void> Database::Close() {
  if (!handle_)
    return {};
  int code = sqlite3_close(handle_);
  if (code != SQLITE_OK)
    return Failure("close", code);
  handle_ = nullptr;
  return {};
}
Result<void> Database::OpenReadOnly(const std::filesystem::path& path, bool immutable) {
  if (handle_)
    return Error{ErrorCode::kInternal, "session store already open"};
  const auto utf8 = path.generic_u8string();
  std::string name = "file:";
  for (const auto character : utf8) {
    if (character == '%')
      name += "%25";
    else if (character == '?')
      name += "%3f";
    else if (character == '#')
      name += "%23";
    else
      name += static_cast<char>(character);
  }
  name += immutable ? "?mode=ro&immutable=1" : "?mode=ro";
  const auto code =
      sqlite3_open_v2(name.c_str(), &handle_,
                      SQLITE_OPEN_READONLY | SQLITE_OPEN_URI | SQLITE_OPEN_FULLMUTEX, nullptr);
  if (code != SQLITE_OK) {
    const auto error = Failure("read-only open", code);
    Close();
    return error;
  }
  sqlite3_extended_result_codes(handle_, 1);
  return Execute("PRAGMA query_only=ON");
}
Result<void> Database::Execute(const char* sql) {
  if (!handle_)
    return Failure("execute", SQLITE_MISUSE);
  int code = sqlite3_exec(handle_, sql, nullptr, nullptr, nullptr);
  if (code != SQLITE_OK)
    return Failure("execute", code);
  return {};
}
Result<Statement> Database::Prepare(const char* sql) {
  if (!handle_)
    return Failure("prepare", SQLITE_MISUSE);
  sqlite3_stmt* statement = nullptr;
  int code = sqlite3_prepare_v2(handle_, sql, -1, &statement, nullptr);
  if (code != SQLITE_OK)
    return Failure("prepare", code);
  return Statement(*this, statement);
}
Statement::Statement(Statement&& other) noexcept
    : db_(other.db_), statement_(std::exchange(other.statement_, nullptr)) {}
Statement::~Statement() {
  sqlite3_finalize(statement_);
}
Result<void> Statement::Bound(int code) {
  if (code != SQLITE_OK)
    return db_->Failure("bind", code);
  return {};
}
Result<void> Statement::Bind(int index, std::string_view value) {
  return Bound(sqlite3_bind_text64(statement_, index, value.data(), value.size(), SQLITE_TRANSIENT,
                                   SQLITE_UTF8));
}
Result<void> Statement::Bind(int index, int64_t value) {
  return Bound(sqlite3_bind_int64(statement_, index, value));
}
Result<void> Statement::Bind(int index, std::span<const uint8_t> value) {
  return Bound(
      sqlite3_bind_blob64(statement_, index, value.data(), value.size(), SQLITE_TRANSIENT));
}
Result<void> Statement::BindNull(int index) {
  return Bound(sqlite3_bind_null(statement_, index));
}
Result<bool> Statement::Step() {
  int code = sqlite3_step(statement_);
  if (code == SQLITE_ROW)
    return true;
  if (code == SQLITE_DONE)
    return false;
  return db_->Failure("step", code);
}
std::string Statement::Text(int column) const {
  const auto* text = sqlite3_column_text(statement_, column);
  return text ? std::string(reinterpret_cast<const char*>(text),
                            sqlite3_column_bytes(statement_, column))
              : std::string();
}
int64_t Statement::Int64(int column) const {
  return sqlite3_column_int64(statement_, column);
}
std::vector<uint8_t> Statement::Blob(int column) const {
  const auto* bytes = static_cast<const uint8_t*>(sqlite3_column_blob(statement_, column));
  const auto size = sqlite3_column_bytes(statement_, column);
  return size ? std::vector<uint8_t>(bytes, bytes + size) : std::vector<uint8_t>();
}
bool Statement::IsNull(int column) const {
  return sqlite3_column_type(statement_, column) == SQLITE_NULL;
}
Transaction::~Transaction() {
  if (active_)
    db_.Execute("ROLLBACK");
}
Result<void> Transaction::Begin() {
  RK_RETURN_IF_ERROR(db_.Execute("BEGIN IMMEDIATE"));
  active_ = true;
  return {};
}
Result<void> Transaction::Commit() {
  RK_RETURN_IF_ERROR(db_.Execute("COMMIT"));
  active_ = false;
  return {};
}
}  // namespace remotekit::sqlite
