#pragma once
#include "util/error.hpp"
#include <filesystem>
#include <span>
#include <vector>

struct sqlite3;
struct sqlite3_stmt;
namespace remotekit::sqlite {
class Statement;
class Database {
 public:
  Database() = default;
  ~Database();
  Database(const Database&) = delete;
  Database& operator=(const Database&) = delete;
  Result<void> Open(const std::filesystem::path& path);
  Result<void> OpenReadOnly(const std::filesystem::path& path, bool immutable);
  Result<void> Close();
  Result<void> Execute(const char* sql);
  Result<Statement> Prepare(const char* sql);
  Error Failure(const char* operation, int code) const;

 private:
  sqlite3* handle_ = nullptr;
};
class Statement {
 public:
  Statement(Database& db, sqlite3_stmt* statement) : db_(&db), statement_(statement) {}
  Statement(Statement&& other) noexcept;
  ~Statement();
  Statement(const Statement&) = delete;
  Result<void> Bind(int index, std::string_view value);
  Result<void> Bind(int index, int64_t value);
  Result<void> Bind(int index, std::span<const uint8_t> value);
  Result<void> BindNull(int index);
  Result<bool> Step();
  std::string Text(int column) const;
  int64_t Int64(int column) const;
  std::vector<uint8_t> Blob(int column) const;
  bool IsNull(int column) const;

 private:
  Result<void> Bound(int code);
  Database* db_;
  sqlite3_stmt* statement_;
};
class Transaction {
 public:
  explicit Transaction(Database& db) : db_(db) {}
  ~Transaction();
  Result<void> Begin();
  Result<void> Commit();

 private:
  Database& db_;
  bool active_ = false;
};
}  // namespace remotekit::sqlite
