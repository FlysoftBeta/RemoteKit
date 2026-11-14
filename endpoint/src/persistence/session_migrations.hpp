#pragma once
#include "persistence/sqlite.hpp"
#include <span>
#include <string>

namespace remotekit {
struct SessionMigration {
  int64_t version;
  const char* name;
  Result<void> (*up)(sqlite::Database&);
};
Result<void> MigrateSessionDb(sqlite::Database& db,
                              const std::filesystem::path& directory,
                              const std::string& build,
                              std::span<const SessionMigration> steps = {});
Result<void> CheckSessionDb(sqlite::Database& db, int64_t expected_version = 4);
}  // namespace remotekit
