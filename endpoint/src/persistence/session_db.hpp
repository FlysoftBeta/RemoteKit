#pragma once
#include "persistence/sqlite.hpp"
#include "util/common.hpp"
#include <functional>
#include <map>
#include <mutex>
#include <set>

namespace remotekit {
inline Error CorruptState(std::string message) {
  return {ErrorCode::kInternal, std::move(message), ErrorReason::kCorruptState};
}
class SessionDb;
class EventStore {
 public:
  explicit EventStore(SessionDb& db) : db_(db) {}
  Result<Json> State();
  Result<bool> Present();
  Result<Json> Load(uint64_t after = 0, size_t limit = 256);
  Result<Json> Append(const std::string& type,
                      const Json& body,
                      const std::string& event_id,
                      const Json& incarnation = nullptr);
  Result<void> Acknowledge(const std::string& stream, uint64_t up_to);
  Result<void> Rotate();
  Result<void> BeginPlacement(uint64_t epoch);

 private:
  SessionDb& db_;
};
class ViewStore {
 public:
  explicit ViewStore(SessionDb& db) : db_(db) {}
  Result<Json> Load();
  Result<void> Save(const Json& views);
  Result<void> SaveDesired(const Json& views, uint64_t epoch, const std::string& revision);
  Result<Json> Close(const std::string& view,
                     const std::string& reason,
                     const Json& incarnation = nullptr);
  Result<Json> Retired();
  Result<void> CommitNavigation(const std::string& view, const std::string& url);
  Result<std::string> ResumeUrl(const std::string& view, const std::string& fallback);
  Result<bool> SignInCurrent(const std::string& view, const std::string& incarnation);

 private:
  SessionDb& db_;
};
class RecoveryStore {
 public:
  explicit RecoveryStore(SessionDb& db) : db_(db) {}
  Result<bool> Contains(const std::string& view);
  Result<Json> Load(const std::string& view);
  Result<void> Save(const std::string& view, const Json& document);
  Result<void> Erase(const std::string& view);

 private:
  SessionDb& db_;
};
class DownloadStore {
 public:
  explicit DownloadStore(SessionDb& db) : db_(db) {}
  Result<Json> Load();
  Result<void> Save(const Json& state);
  Result<void> Complete(const std::string& event_id);

 private:
  SessionDb& db_;
};
enum class LibraryTable { kAssets, kDrafts, kSelections, kDerivatives };
class LibraryStore {
 public:
  explicit LibraryStore(SessionDb& db) : db_(db) {}
  Result<std::map<std::string, Json>> Load(LibraryTable table);
  Result<void> Save(LibraryTable table, const std::string& id, const Json& document);
  Result<void> Erase(LibraryTable table, const std::string& id);
  Result<void> ClearDrafts();
  Result<void> Selections(const std::map<std::string, Json>& documents);
  Result<void> Seal(const std::string& asset,
                    const Json& metadata,
                    const std::string& upload,
                    const Json& draft,
                    const std::string& derivative = {});

 private:
  SessionDb& db_;
};
class SessionDb {
 public:
  explicit SessionDb(fs::path directory) : directory_(std::move(directory)) {}
  Result<void> Open();
  Result<void> OpenReadOnly(bool immutable);
  Result<void> Close();
  ViewStore Views() { return ViewStore(*this); }
  EventStore Events() { return EventStore(*this); }
  RecoveryStore Recovery() { return RecoveryStore(*this); }
  DownloadStore Downloads() { return DownloadStore(*this); }
  LibraryStore Library() { return LibraryStore(*this); }

 private:
  friend class ViewStore;
  friend class EventStore;
  friend class RecoveryStore;
  friend class DownloadStore;
  friend class LibraryStore;
  Result<void> OpenFile(const fs::path& path);
  Result<void> Write(const std::function<Result<void>()>& action);
  Result<void> Delete(const char* sql, const std::string& id);
  Result<void> PutLibrary(LibraryTable table, const std::string& id, const Json& document);
  const fs::path directory_;
  sqlite::Database db_;
  std::recursive_mutex mutex_;
  bool closed_ = false;
  bool writing_ = false;
};
Result<void> ValidateDownloadState(const Json& state);
}  // namespace remotekit
