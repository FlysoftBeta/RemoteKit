#include "persistence/checkpoint.hpp"
#include "persistence/checkpoint_formats.hpp"
#include "util/file_io.hpp"
#include "persistence/session_db.hpp"
#include "util/result_macros.hpp"
#include <windows.h>
#include <fstream>
#include <set>
#include <sstream>
#include "persistence/parallel.hpp"
#include <cstdlib>
#include <condition_variable>

namespace remotekit {
namespace {
constexpr size_t kChunk = 1024 * 1024;
using checkpoint_formats::SafePath;
using checkpoint_formats::ValidEntries;
Result<Json> Load(const fs::path& path) {
  RK_ASSIGN_OR_RETURN(bytes, ReadFileIfExists(path));
  if (!bytes)
    return Json();
  return checkpoint_formats::DecodeIndex(*bytes);
}
bool ExcludedPath(const fs::path& path, bool directory) {
  fs::path prefix;
  for (const auto& part : path) {
    prefix /= part;
    if (Checkpoints::Excluded(prefix, prefix != path || directory))
      return true;
  }
  return false;
}
Json BareIdentity(const Json& entry) {
  if (entry.contains("directory"))
    return Json{{"directory", true}};
  return {{"size", entry.at("size")}, {"mtime", entry.at("mtime")}, {"fileId", entry.at("fileId")}};
}
objects::ObjectInfo ObjectMetadata(const Json& value) {
  return {value.at("objectId").get<std::string>(), value.at("size").get<uint64_t>(),
          value.at("storedSize").get<uint64_t>(), value.at("storedSha256").get<std::string>()};
}
class CommitStream {
 public:
  CommitStream(objects::ObjectService& objects,
               std::string tenant,
               Json* phases,
               std::mutex& stats,
               bool defer_commits)
      : objects_(objects),
        tenant_(std::move(tenant)),
        phases_(phases),
        stats_(stats),
        defer_commits_(defer_commits) {
    if (!defer_commits_)
      worker_ = std::thread([this] { Run(); });
  }
  ~CommitStream() { auto finished = Finish(); }
  void Add(const objects::ObjectInfo& info) {
    if (defer_commits_)
      return;
    std::lock_guard lock(mutex_);
    if (ids_.insert(info.id).second)
      pending_.push_back(info);
    wake_.notify_one();
  }
  Result<void> Finish() {
    {
      std::lock_guard lock(mutex_);
      done_ = true;
    }
    wake_.notify_one();
    if (worker_.joinable())
      worker_.join();
    if (failure_)
      return *failure_;
    return {};
  }

 private:
  void Run() {
    try {
      for (;;) {
        std::vector<objects::ObjectInfo> batch;
        {
          std::unique_lock lock(mutex_);
          wake_.wait(lock, [&] { return done_ || pending_.size() >= 1024; });
          if (pending_.empty())
            return;
          const auto count = std::min<size_t>(1024, pending_.size());
          batch.assign(pending_.begin(), pending_.begin() + count);
          pending_.erase(pending_.begin(), pending_.begin() + count);
        }
        const auto start = PhaseClock::now();
        size_t requests = 0;
        const auto result = objects_.CommittedBatch(batch, tenant_, &requests);
        {
          std::lock_guard lock(stats_);
          AddPhase(phases_, "commit", "ms", PhaseMs(start));
          AddPhase(phases_, "commit", "requests", double(requests));
          AddPhase(phases_, "commit", "objects", double(batch.size()));
        }
        if (!result) {
          failure_ = result.error();
          return;
        }
      }
    } catch (const std::filesystem::filesystem_error& error) {
      failure_ = WithOsError(ErrorCode::kUnavailable, error.what(), OsError::Kind::kWin32,
                             error.code().value());
    } catch (const std::exception& error) {
      failure_ = Error{ErrorCode::kUnavailable, error.what()};
    }
  }
  objects::ObjectService& objects_;
  bool defer_commits_;
  std::string tenant_;
  Json* phases_;
  std::mutex& stats_;
  std::mutex mutex_;
  std::condition_variable wake_;
  bool done_ = false;
  std::vector<objects::ObjectInfo> pending_;
  std::set<std::string> ids_;
  std::optional<Error> failure_;
  std::thread worker_;
};
}  // namespace
Result<Json> Checkpoints::Copy(const fs::path& directory) {
  RK_ASSIGN_OR_RETURN(bytes, ReadFileIfExists(LongPath(directory).wstring() + L".copy.json"));
  if (!bytes)
    return Json();
  RK_ASSIGN_OR_RETURN(value, checkpoint_formats::Decode(*bytes, checkpoint_formats::ValidateCopy,
                                                        persisted::Store::kCopy));
  if (value.at("sessionId") != directory.filename().string())
    return CorruptState("Session copy identity mismatch");
  return value;
}
Result<void> Checkpoints::WriteCopy(const fs::path& directory, const Json& copy) {
  RK_ASSIGN_OR_RETURN(bytes, checkpoint_formats::Encode(copy, checkpoint_formats::ValidateCopy));
  if (copy.at("sessionId") != directory.filename().string())
    return CorruptState("Session copy identity mismatch");
  return WriteDurableText(LongPath(directory).wstring() + L".copy.json", bytes);
}
bool Checkpoints::ReuseCopy(const Json& copy, uint64_t epoch, const Json& checkpoint) {
  return copy.is_object() && copy.at("placementEpoch").get<uint64_t>() <= epoch &&
         (copy.at("state") == "dirty" || copy.at("base") == checkpoint);
}
Result<void> Checkpoints::FlushChanges(const fs::path& directory, const DirectoryChanges& changes) {
  RK_ASSIGN_OR_RETURN(copy, Copy(directory));
  if (copy.is_null())
    return CorruptState("Session copy record missing");
  const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(
                       std::chrono::system_clock::now().time_since_epoch())
                       .count();
  Json paths = Json::array();
  for (const auto& [name, at] : changes.paths)
    paths.push_back(name);
  const Json record{{"version", 1},
                    {"at", now},
                    {"paths", paths},
                    {"removed", changes.removed},
                    {"subtrees", changes.subtrees},
                    {"continuous", changes.continuous}};
  RK_ASSIGN_OR_RETURN(encoded,
                      checkpoint_formats::Encode(record, checkpoint_formats::ValidateChanges));
  const auto bytes = encoded + "\n";
  const auto path = LongPath(directory).wstring() + L".changes";
  HANDLE file = CreateFileW(path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ, nullptr, OPEN_ALWAYS,
                            FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE)
    return Error{ErrorCode::kUnavailable, "change journal open failed"};
  DWORD written = 0;
  const bool ok =
      WriteFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) &&
      written == bytes.size() && FlushFileBuffers(file);
  CloseHandle(file);
  if (!ok)
    return Error{ErrorCode::kUnavailable, "change journal flush failed"};
  copy["changesAt"] = now;
  return WriteCopy(directory, copy);
}
Result<void> Checkpoints::TruncateChanges(const fs::path& directory) {
  const auto path = LongPath(directory).wstring() + L".changes";
  HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_ALWAYS,
                            FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE)
    return Error{ErrorCode::kUnavailable, "change journal truncate failed"};
  const bool ok = FlushFileBuffers(file) != FALSE;
  CloseHandle(file);
  if (!ok)
    return Error{ErrorCode::kUnavailable, "change journal truncate flush failed"};
  return {};
}
Result<DirectoryChanges> Checkpoints::RecoverChanges(const fs::path& raw_directory,
                                                     int64_t changes_at,
                                                     bool metadata_walk) {
  const auto directory = LongPath(raw_directory);
  RK_ASSIGN_OR_RETURN(previous, Load(directory.wstring() + L".checkpoint-index.json"));
  DirectoryChanges changes;
  changes.continuous = ValidEntries(previous);
  if (!changes.continuous)
    previous = Json::object();
  RK_ASSIGN_OR_RETURN(journal, ReadFileIfExists(directory.wstring() + L".changes"));
  if (journal) {
    std::istringstream lines(*journal);
    std::string line;
    while (std::getline(lines, line)) {
      RK_ASSIGN_OR_RETURN(record,
                          checkpoint_formats::Decode(line, checkpoint_formats::ValidateChanges,
                                                     persisted::Store::kChanges));
      if (!record.at("continuous").get<bool>())
        metadata_walk = true;
      for (const auto* field : {"paths", "removed", "subtrees"}) {
        for (const auto& item : record.at(field)) {
          const auto name = item.get<std::string>();
          changes.paths[name] = PhaseClock::now();
          if (std::string_view(field) == "removed")
            changes.removed.insert(name);
          if (std::string_view(field) == "subtrees")
            changes.subtrees.insert(name);
        }
      }
    }
  }
  if (!metadata_walk)
    return changes;
  // Scan reads file attributes only. Content is read after the Browser consistency boundary.
  RK_ASSIGN_OR_RETURN(current, Scan(directory, Json(), DirectoryChanges{}));
  const auto threshold =
      uint64_t(std::max<int64_t>(0, changes_at - 2000) + 11644473600000LL) * 10000;
  for (const auto& [name, entry] : current.items()) {
    changes.removed.erase(name);
    if (!previous.contains(name) || BareIdentity(previous[name]) != entry ||
        (!entry.contains("directory") && entry["mtime"].get<uint64_t>() >= threshold)) {
      changes.paths[name] = PhaseClock::now();
      if (entry.contains("directory"))
        changes.subtrees.insert(name);
    }
  }
  for (const auto& [name, entry] : previous.items())
    if (!current.contains(name)) {
      changes.paths[name] = PhaseClock::now();
      changes.removed.insert(name);
    }
  return changes;
}
Result<Json> Checkpoints::Describe(const std::string& manifest) {
  std::ostringstream bytes;
  RK_RETURN_IF_ERROR(objects_.Store().Read(objects_.ObjectKeys(), manifest, bytes));
  RK_ASSIGN_OR_RETURN(value,
                      checkpoint_formats::Decode(bytes.str(), checkpoint_formats::ValidateManifest,
                                                 persisted::Store::kManifest));
  std::set<std::string> ids{manifest};
  for (const auto& file : value["files"])
    for (const auto& chunk : file.at("chunks"))
      ids.insert(chunk.get<std::string>());
  if (ids.size() > 32768)
    return Error{ErrorCode::kLimitExceeded, "checkpoint descriptor exceeds object limit"};
  return Json{{"objects", ids}, {"buildId", value["buildId"]}};
}
bool Checkpoints::Excluded(const fs::path& relative, bool directory) {
  const auto name = relative.filename().wstring();
  if (directory) {
    static const std::set<std::wstring> excluded{L"Cache",
                                                 L"Code Cache",
                                                 L"GPUCache",
                                                 L"DawnWebGPUCache",
                                                 L"DawnGraphiteCache",
                                                 L"Shared Dictionary",
                                                 L"VideoDecodeStats",
                                                 L"blob_storage"};
    if (excluded.contains(name))
      return true;
    return relative == "uploads" || relative == "file-library/incoming" ||
           relative == "file-library/staging";
  }
  return name == L"LOCK" || name == L"LOG" || name == L"LOG.old" || name == L".checkpoint-watcher";
}
Result<std::string> Checkpoints::Get(const std::string& tenant, const std::string& id) {
  if (!access_)
    access_ = std::make_shared<objects::SessionObjects>(objects_, tenant);
  auto start = PhaseClock::now();
  RK_ASSIGN_OR_RETURN(sources, access_->Prepare({id}));
  AddPhase(phases_, "locate", "ms", PhaseMs(start));
  AddPhase(phases_, "locate", "requests", 1);
  AddPhase(phases_, "locate", "ids", 1);
  RK_ASSIGN_OR_RETURN(path, objects_.Store().StoredPath(id));
  const bool local = fs::is_regular_file(path);
  start = PhaseClock::now();
  RK_ASSIGN_OR_RETURN(info, objects_.EnsureUncommitted(id, sources.at(id)));
  std::ostringstream output;
  RK_RETURN_IF_ERROR(objects_.Store().Read(objects_.ObjectKeys(), id, output));
  AddPhase(phases_, "fetch", "ms", PhaseMs(start));
  AddPhase(phases_, "fetch", local ? "chunksLocal" : "chunksRemote", 1);
  AddPhase(phases_, "fetch", "bytes", double(output.str().size()));
  if (!local) {
    start = PhaseClock::now();
    size_t requests = 0;
    RK_RETURN_IF_ERROR(objects_.CommittedBatch({info}, {}, &requests));
    AddPhase(phases_, "replicaCommit", "ms", PhaseMs(start));
    AddPhase(phases_, "replicaCommit", "objects", 1);
    AddPhase(phases_, "replicaCommit", "requests", double(requests));
  }
  return output.str();
}
Result<Json> Checkpoints::Scan(const fs::path& raw_directory,
                               const Json& previous,
                               const DirectoryChanges& changes,
                               Json* phases) {
  const auto directory = LongPath(raw_directory);
  const auto start = PhaseClock::now();
  Json entries = Json::object();
  const bool incremental = changes.continuous && ValidEntries(previous);
  if (incremental)
    for (const auto& [name, entry] : previous.items())
      entries[name] = BareIdentity(entry);
  auto erase = [&](const std::string& name) {
    for (auto entry = entries.begin(); entry != entries.end();) {
      if (entry.key() == name || entry.key().starts_with(name + "/"))
        entry = entries.erase(entry);
      else
        ++entry;
    }
  };
  auto add = [&](const fs::path& path) -> Result<void> {
    const auto relative = path.lexically_relative(directory);
    const auto encoded = relative.generic_u8string();
    const std::string name(encoded.begin(), encoded.end());
    if (!SafePath(name))
      return Error{ErrorCode::kRejected, "invalid checkpoint path"};
    const auto attributes = GetFileAttributesW(path.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES)
      return Error{ErrorCode::kUnavailable, "checkpoint path disappeared"};
    if (attributes & FILE_ATTRIBUTE_REPARSE_POINT)
      return Error{ErrorCode::kRejected, "checkpoint contains a reparse point"};
    if (attributes & FILE_ATTRIBUTE_DIRECTORY)
      entries[name] = {{"directory", true}};
    else {
      RK_ASSIGN_OR_RETURN(identity, CheckpointIdentity(path));
      entries[name] = std::move(identity);
      AddPhase(phases, "scan", "filesStatted", 1);
    }
    return {};
  };
  auto walk = [&](const fs::path& root) -> Result<void> {
    for (auto entry = fs::recursive_directory_iterator(root);
         entry != fs::recursive_directory_iterator(); ++entry) {
      const auto relative = entry->path().lexically_relative(directory);
      const bool is_directory = entry->is_directory();
      if (ExcludedPath(relative, is_directory)) {
        if (is_directory)
          entry.disable_recursion_pending();
        continue;
      }
      RK_RETURN_IF_ERROR(add(entry->path()));
    }
    return {};
  };
  if (incremental) {
    AddPhase(phases, "scan", "filesFromWatcher", double(changes.paths.size()));
    for (const auto& name : changes.removed)
      erase(name);
    for (const auto& [name, changed] : changes.paths) {
      if (std::ranges::any_of(changes.removed, [&](const std::string& removed) {
            return name == removed || name.starts_with(removed + "/");
          }))
        continue;
      const auto relative = Utf8Path(name);
      if (!SafePath(name))
        return Error{ErrorCode::kRejected, "invalid watcher path"};
      const auto path = LongPath(directory / relative);
      const bool is_directory = fs::is_directory(path);
      if (ExcludedPath(relative, is_directory))
        continue;
      if (!fs::exists(path)) {
        erase(name);
        continue;
      }
      if (is_directory && entries.contains(name) && entries[name].contains("directory") &&
          !changes.subtrees.contains(name))
        continue;
      erase(name);
      RK_RETURN_IF_ERROR(add(path));
      if (is_directory)
        RK_RETURN_IF_ERROR(walk(path));
    }
  } else
    RK_RETURN_IF_ERROR(walk(directory));
  AddPhase(phases, "scan", "ms", PhaseMs(start));
#ifndef NDEBUG
  if (incremental) {
    const char* verify = std::getenv("REMOTEKIT_CHECKPOINT_VERIFY");
    if (verify && std::string_view(verify) == "1") {
      RK_ASSIGN_OR_RETURN(full, Scan(directory, Json(), DirectoryChanges{}));
      if (entries != full)
        return Error{ErrorCode::kInternal, "incremental checkpoint differs from full walk"};
    }
  }
#endif
  return entries;
}
Result<Json> Checkpoints::Create(const fs::path& raw_directory,
                                 const std::string& tenant,
                                 const std::string& build,
                                 PhaseClock::time_point deadline,
                                 bool defer_commits,
                                 const SnapshotSource* source) {
  fs::create_directories(LongPath(raw_directory));
  RK_ASSIGN_OR_RETURN(plan,
                      Capture(raw_directory, cache_ ? cache_->Changes() : DirectoryChanges{}));
  if (!source && cache_ && !plan.changes.continuous && ValidEntries(plan.previous)) {
    RK_ASSIGN_OR_RETURN(copy, Copy(raw_directory));
    RK_ASSIGN_OR_RETURN(
        recovered,
        RecoverChanges(raw_directory, copy.is_null() ? 0 : copy["changesAt"].get<int64_t>()));
    plan.changes = std::move(recovered);
  }
  RK_ASSIGN_OR_RETURN(built,
                      Build(raw_directory, tenant, build, plan, deadline, defer_commits, source));
  const auto journal_start = PhaseClock::now();
  RK_RETURN_IF_ERROR(InstallIndex(raw_directory, built));
  if (phases_)
    (*phases_)["journal"] = phases_->value("journal", 0.0) + PhaseMs(journal_start);
  return std::move(built.checkpoint);
}
Result<CheckpointPlan> Checkpoints::Capture(const fs::path& directory, DirectoryChanges changes) {
  RK_ASSIGN_OR_RETURN(previous, Load(LongPath(directory).wstring() + L".checkpoint-index.json"));
  if (!ValidEntries(previous))
    previous = Json();
  return CheckpointPlan{std::move(previous), std::move(changes)};
}
Result<void> Checkpoints::InstallIndex(const fs::path& directory, const BuiltCheckpoint& built) {
  RK_ASSIGN_OR_RETURN(encoded_index, checkpoint_formats::EncodeIndex(built.index));
  return WriteDurableJson(LongPath(directory).wstring() + L".checkpoint-index.json", encoded_index);
}
Result<BuiltCheckpoint> Checkpoints::Build(const fs::path& raw_directory,
                                           const std::string& tenant,
                                           const std::string& build,
                                           const CheckpointPlan& plan,
                                           PhaseClock::time_point deadline,
                                           bool defer_commits,
                                           const SnapshotSource* source) {
  const auto directory = LongPath(raw_directory);
  const auto& previous = plan.previous;
  const auto& changes = plan.changes;
  RK_ASSIGN_OR_RETURN(snapshot, source ? Result<Json>(source->entries)
                                       : Scan(directory, previous, changes, phases_));
  Json index = snapshot;
  std::vector<std::string> names;
  Json directories = Json::array();
  for (const auto& [name, entry] : snapshot.items()) {
    if (entry.contains("directory"))
      directories.push_back(name);
    else
      names.push_back(name);
  }
  std::mutex stats;
  CommitStream commits(objects_, tenant, phases_, stats, defer_commits);
  const auto store_start = PhaseClock::now();
  auto stored =
      CheckpointParallel(names.size(), CheckpointWorkers(), [&](size_t position) -> Result<void> {
        if (PhaseClock::now() >= deadline)
          return Error{ErrorCode::kUnavailable, "shutdown commit budget exhausted"};
        const auto& name = names[position];
        const auto& identity = snapshot.at(name);
        std::vector<objects::ObjectInfo> objects;
        const bool changed = !changes.continuous || changes.paths.contains(name) ||
                             std::ranges::any_of(changes.subtrees,
                                                 [&](const std::string& subtree) {
                                                   return name.starts_with(subtree + "/");
                                                 }) ||
                             name == "session.db" || name == "session.db-wal";
        bool reuse = (!source || !changed) && previous.contains(name) &&
                     !previous[name].contains("directory") &&
                     BareIdentity(previous[name]) == identity && previous[name].contains("chunks");
        if (reuse) {
          if (changes.continuous && previous[name].contains("objects")) {
            for (const auto& item : previous[name]["objects"])
              objects.push_back(ObjectMetadata(item));
          } else {
            for (const auto& chunk : previous[name]["chunks"]) {
              auto local = objects_.Store().Inspect(chunk.get<std::string>());
              if (!local) {
                reuse = false;
                objects.clear();
                break;
              }
              objects.push_back(std::move(local).value());
            }
          }
        }
        uint64_t bytes_read = 0;
        bool read_file = false, staged_file = false;
        if (!reuse && cache_) {
          if (auto staged = cache_->Find(name, identity)) {
            objects = staged->objects;
            reuse = true;
            staged_file = true;
          }
        }
        if (!reuse) {
          read_file = true;
          std::vector<objects::ObjectInfo> known;
          if (changes.continuous && previous.contains(name) && previous[name].contains("objects"))
            for (const auto& item : previous[name]["objects"])
              known.push_back(ObjectMetadata(item));
          std::ifstream input;
          if (!source)
            input.open(LongPath(directory / Utf8Path(name)), std::ios::binary);
          if (!source && !input)
            return Error{ErrorCode::kUnavailable, "checkpoint file open failed: " +
                                                      Utf8(LongPath(directory / Utf8Path(name)))};
          uint64_t remaining = identity["size"].get<uint64_t>();
          do {
            if (PhaseClock::now() >= deadline)
              return Error{ErrorCode::kUnavailable, "shutdown commit budget exhausted"};
            std::string bytes(static_cast<size_t>(std::min<uint64_t>(remaining, kChunk)), '\0');
            if (source) {
              RK_ASSIGN_OR_RETURN(
                  content, source->read(name, bytes_read, static_cast<uint32_t>(bytes.size())));
              if (content.size() != bytes.size())
                return Error{ErrorCode::kUnavailable, "snapshot file read is incomplete"};
              bytes = std::move(content);
            } else if (!input.read(bytes.data(), static_cast<std::streamsize>(bytes.size())))
              return Error{ErrorCode::kUnavailable, "checkpoint file read failed"};
            const auto* existing = objects.size() < known.size() ? &known[objects.size()] : nullptr;
            RK_ASSIGN_OR_RETURN(
                info, objects_.Store().WriteChunk(objects_.ObjectKeys(), bytes, existing));
            objects.push_back(std::move(info));
            bytes_read += bytes.size();
            remaining -= bytes.size();
          } while (remaining);
          if (!source) {
            RK_ASSIGN_OR_RETURN(after, CheckpointIdentity(LongPath(directory / Utf8Path(name))));
            if (after != identity)
              return Error{ErrorCode::kConflict, "checkpoint file changed during read"};
          }
        }
        Json entry = identity;
        entry["chunks"] = Json::array();
        entry["objects"] = Json::array();
        for (const auto& info : objects) {
          entry["chunks"].push_back(info.id);
          entry["objects"].push_back(info.Committed());
          commits.Add(info);
        }
        std::lock_guard lock(stats);
        AddPhase(phases_, "store", "filesRead", read_file ? 1 : 0);
        if (staged_file)
          AddPhase(phases_, "store", "filesStaged", 1);
        AddPhase(phases_, "store", "bytesRead", double(bytes_read));
        for (const auto& info : objects) {
          AddPhase(phases_, "store", "chunksNew", !reuse && info.created ? 1 : 0);
          AddPhase(phases_, "store", "chunksReused", reuse || !info.created ? 1 : 0);
          AddPhase(phases_, "store", "bytesStored",
                   !reuse && info.created ? double(info.stored_size) : 0);
          AddPhase(phases_, "store", "compressEncryptMs", !reuse ? info.compress_encrypt_ms : 0);
        }
        index[name] = std::move(entry);
        return {};
      });
  if (!stored)
    return stored.error();
  AddPhase(phases_, "store", "ms", PhaseMs(store_start));
  Json files = Json::array();
  std::set<std::string> ids;
  for (const auto& name : names) {
    const auto& entry = index[name];
    files.push_back({{"path", name}, {"size", entry["size"]}, {"chunks", entry["chunks"]}});
    for (const auto& id : entry["chunks"])
      ids.insert(id.get<std::string>());
  }
  Json manifest{{"version", 2}, {"buildId", build}, {"files", files}, {"directories", directories}};
  if (PhaseClock::now() >= deadline)
    return Error{ErrorCode::kUnavailable, "shutdown commit budget exhausted"};
  RK_ASSIGN_OR_RETURN(manifest_bytes,
                      checkpoint_formats::Encode(manifest, checkpoint_formats::ValidateManifest));
  const auto manifest_start = PhaseClock::now();
  RK_ASSIGN_OR_RETURN(info, objects_.Store().WriteChunk(objects_.ObjectKeys(), manifest_bytes));
  {
    std::lock_guard lock(stats);
    AddPhase(phases_, "store", "ms", PhaseMs(manifest_start));
    AddPhase(phases_, "store", "bytesStored", info.created ? double(info.stored_size) : 0);
    AddPhase(phases_, "store", "compressEncryptMs", info.compress_encrypt_ms);
  }
  commits.Add(info);
  ids.insert(info.id);
  RK_RETURN_IF_ERROR(commits.Finish());
  if (access_)
    for (const auto& id : ids)
      access_->Grant(id);
  return BuiltCheckpoint{Json{{"manifestId", info.id}, {"objects", ids}}, std::move(index)};
}
Result<void> Checkpoints::Restore(const fs::path& raw_directory,
                                  const std::string& tenant,
                                  const Json& checkpoint) {
  const auto directory = LongPath(raw_directory);
  const fs::path index_path = directory.wstring() + L".checkpoint-index.json";
  RK_ASSIGN_OR_RETURN(saved_index, Load(index_path));
  const bool warm =
      !checkpoint.is_null() && fs::is_directory(directory) && ValidEntries(saved_index);
  if (phases_)
    (*phases_)["mode"] = checkpoint.is_null() ? "new" : warm ? "warm" : "cold";
  RK_ASSIGN_OR_RETURN(previous, Load(index_path));
  if (!warm)
    previous = Json();
  if (!ValidEntries(previous))
    previous = Json::object();
  Json index = Json::object();
  const fs::path restore = directory.wstring() + L".restore";
  const fs::path discard = directory.wstring() + L".discard";
  fs::remove_all(restore);
  fs::create_directories(restore);
  struct File {
    std::string name;
    uint64_t size;
    std::vector<std::string> chunks;
    bool matched = false;
    Json identity;
  };
  struct Chunk {
    size_t file, part;
  };
  std::vector<File> files;
  std::vector<Chunk> chunks;
  std::set<std::string> ids, paths;
  Json sources = Json::object();
  if (!checkpoint.is_null()) {
    const auto start = PhaseClock::now();
    RK_ASSIGN_OR_RETURN(bytes, Get(tenant, checkpoint.get<std::string>()));
    AddPhase(phases_, "manifest", "ms", PhaseMs(start));
    RK_ASSIGN_OR_RETURN(manifest,
                        checkpoint_formats::Decode(bytes, checkpoint_formats::ValidateManifest,
                                                   persisted::Store::kManifest));
    for (const auto& item : manifest["directories"]) {
      index[item.get<std::string>()] = {{"directory", true}};
    }
    for (const auto& item : manifest["files"]) {
      File file{item["path"].get<std::string>(), item["size"].get<uint64_t>(), {}};
      for (const auto& id : item["chunks"]) {
        file.chunks.push_back(id.get<std::string>());
      }
      files.push_back(std::move(file));
    }
    const auto validate_start = PhaseClock::now();
    RK_RETURN_IF_ERROR(
        CheckpointParallel(files.size(), CheckpointWorkers(), [&](size_t i) -> Result<void> {
          auto& file = files[i];
          if (!warm || !previous.contains(file.name))
            return {};
          auto identity = CheckpointIdentity(LongPath(directory / Utf8Path(file.name)));
          const auto& old = previous[file.name];
          if (identity && old.is_object() && old.contains("fileId") &&
              BareIdentity(old) == identity.value() && old.contains("chunks") &&
              old.at("chunks") == Json(file.chunks) && identity.value()["size"] == file.size) {
            file.matched = true;
            file.identity = old;
          }
          return {};
        }));
    AddPhase(phases_, "validate", "ms", PhaseMs(validate_start));
    AddPhase(phases_, "validate", "files", double(files.size()));
    for (size_t i = 0; i < files.size(); ++i) {
      const auto& file = files[i];
      if (file.matched) {
        index[file.name] = file.identity;
        continue;
      }
      AddPhase(phases_, "validate", "mismatched", 1);
      for (size_t part = 0; part < file.chunks.size(); ++part) {
        chunks.push_back({i, part});
        ids.insert(file.chunks[part]);
      }
    }
    const auto locate_start = PhaseClock::now();
    RK_ASSIGN_OR_RETURN(located, access_->Prepare({ids.begin(), ids.end()}));
    sources = std::move(located);
    AddPhase(phases_, "locate", "ms", PhaseMs(locate_start));
    AddPhase(phases_, "locate", "requests", double((ids.size() + 1023) / 1024));
    AddPhase(phases_, "locate", "ids", double(ids.size()));
  }
  const auto materialize_start = PhaseClock::now();
  std::set<fs::path> unique_directories;
  for (const auto& [name, entry] : index.items())
    if (entry.contains("directory"))
      unique_directories.insert(LongPath(restore / Utf8Path(name)));
  for (const auto& file : files)
    if (!file.matched)
      unique_directories.insert((LongPath(restore / Utf8Path(file.name))).parent_path());
  const std::vector<fs::path> directories(unique_directories.begin(), unique_directories.end());
  RK_RETURN_IF_ERROR(CheckpointParallel(directories.size(), 8, [&](size_t i) -> Result<void> {
    fs::create_directories(directories[i]);
    return {};
  }));
  RK_RETURN_IF_ERROR(CheckpointParallel(files.size(), 8, [&](size_t i) -> Result<void> {
    const auto& file = files[i];
    if (file.matched)
      return {};
    const auto path = LongPath(restore / Utf8Path(file.name));
    if (file.chunks.size() == 1)
      return {};
    HANDLE output = CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (output == INVALID_HANDLE_VALUE)
      return Error{ErrorCode::kUnavailable, "checkpoint materialization failed"};
    LARGE_INTEGER size{};
    size.QuadPart = static_cast<LONGLONG>(file.size);
    const bool ok = SetFilePointerEx(output, size, nullptr, FILE_BEGIN) && SetEndOfFile(output);
    CloseHandle(output);
    if (!ok)
      return Error{ErrorCode::kUnavailable, "checkpoint materialization failed"};
    return {};
  }));
  std::mutex stats;
  std::map<std::string, objects::ObjectInfo> metadata, fetched;
  AddPhase(phases_, "materialize", "prepareMs", PhaseMs(materialize_start));
  const auto fetch_start = PhaseClock::now();
  if (phases_)
    (*phases_)["fetch"]["concurrency"] = 8;
  auto materialized = CheckpointParallel(chunks.size(), 8, [&](size_t i) -> Result<void> {
    const auto& chunk = chunks[i];
    const auto& file = files[chunk.file];
    const auto& id = file.chunks[chunk.part];
    const auto fetch_start = PhaseClock::now();
    RK_ASSIGN_OR_RETURN(stored_path, objects_.Store().StoredPath(id));
    const bool local = fs::is_regular_file(stored_path);
    RK_ASSIGN_OR_RETURN(info, objects_.EnsureUncommitted(id, sources.at(id)));
    std::ostringstream output;
    RK_RETURN_IF_ERROR(objects_.Store().Read(objects_.ObjectKeys(), id, output));
    const auto content = output.str();
    const uint64_t offset = uint64_t(chunk.part) * kChunk;
    if (content.size() != std::min<uint64_t>(file.size - offset, kChunk))
      return Error{ErrorCode::kRejected, "checkpoint chunk size mismatch"};
    const auto fetch_ms = PhaseMs(fetch_start);
    const auto write_start = PhaseClock::now();
    const auto path = LongPath(restore / Utf8Path(file.name));
    const bool single = file.chunks.size() == 1;
    HANDLE target =
        CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                    single ? CREATE_ALWAYS : OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (target == INVALID_HANDLE_VALUE)
      return Error{ErrorCode::kUnavailable, "checkpoint materialization failed"};
    LARGE_INTEGER position{};
    position.QuadPart = static_cast<LONGLONG>(offset);
    DWORD written = 0;
    const bool ok =
        SetFilePointerEx(target, position, nullptr, FILE_BEGIN) &&
        WriteFile(target, content.data(), static_cast<DWORD>(content.size()), &written, nullptr) &&
        written == content.size() && (!single || FlushFileBuffers(target));
    CloseHandle(target);
    if (!ok)
      return Error{ErrorCode::kUnavailable, "checkpoint materialization failed"};
    const auto write_ms = PhaseMs(write_start);
    std::lock_guard lock(stats);
    metadata[id] = info;
    if (!local)
      fetched[id] = info;
    AddPhase(phases_, "fetch", "workMs", fetch_ms);
    AddPhase(phases_, "materialize", "workMs", write_ms);
    AddPhase(phases_, "fetch", local ? "chunksLocal" : "chunksRemote", 1);
    AddPhase(phases_, "fetch", "bytes", double(content.size()));
    return {};
  });
  AddPhase(phases_, "fetch", "ms", PhaseMs(fetch_start));
  std::vector<objects::ObjectInfo> replicas;
  for (const auto& [id, info] : fetched)
    replicas.push_back(info);
  const auto commit_start = PhaseClock::now();
  size_t replica_requests = 0;
  RK_RETURN_IF_ERROR(objects_.CommittedBatch(replicas, {}, &replica_requests));
  AddPhase(phases_, "replicaCommit", "ms", PhaseMs(commit_start));
  AddPhase(phases_, "replicaCommit", "objects", double(replicas.size()));
  AddPhase(phases_, "replicaCommit", "requests", double(replica_requests));
  if (!materialized)
    return materialized.error();
  RK_RETURN_IF_ERROR(CheckpointParallel(files.size(), 8, [&](size_t i) -> Result<void> {
    auto& file = files[i];
    if (file.matched)
      return {};
    const auto path = LongPath(restore / Utf8Path(file.name));
    if (file.chunks.size() > 1)
      RK_RETURN_IF_ERROR(FlushFile(path));
    RK_ASSIGN_OR_RETURN(identity, CheckpointIdentity(path));
    identity["chunks"] = file.chunks;
    identity["objects"] = Json::array();
    for (const auto& id : file.chunks)
      identity["objects"].push_back(metadata.at(id).Committed());
    file.identity = std::move(identity);
    return {};
  }));
  for (const auto& file : files)
    index[file.name] = file.identity;
  AddPhase(phases_, "materialize", "ms", PhaseMs(materialize_start));
  const auto swap_start = PhaseClock::now();
  if (warm) {
    for (const auto& entry : fs::recursive_directory_iterator(restore)) {
      const auto target = directory / entry.path().lexically_relative(restore);
      if (entry.is_directory())
        fs::create_directories(target);
      else if (!MoveFileExW(entry.path().c_str(), target.c_str(),
                            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
        return Error{ErrorCode::kUnavailable, "warm checkpoint repair failed"};
    }
    fs::remove_all(restore);
    std::vector<fs::path> extras;
    for (auto entry = fs::recursive_directory_iterator(directory);
         entry != fs::recursive_directory_iterator(); ++entry) {
      const auto relative = entry->path().lexically_relative(directory);
      const bool is_directory = entry->is_directory();
      if (ExcludedPath(relative, is_directory)) {
        if (is_directory)
          entry.disable_recursion_pending();
        continue;
      }
      const auto encoded = relative.generic_u8string();
      const std::string name(encoded.begin(), encoded.end());
      if (!index.contains(name)) {
        extras.push_back(entry->path());
        if (is_directory)
          entry.disable_recursion_pending();
      }
    }
    for (const auto& extra : extras)
      fs::remove_all(extra);
  } else {
    fs::remove_all(discard);
    const bool had_directory = fs::exists(directory);
    if (had_directory)
      fs::rename(directory, discard);
    std::error_code error;
    fs::rename(restore, directory, error);
    if (error) {
      if (had_directory)
        fs::rename(discard, directory);
      return Error{ErrorCode::kUnavailable, "checkpoint directory swap failed"};
    }
    fs::remove_all(discard);
  }
  RK_ASSIGN_OR_RETURN(encoded_index, checkpoint_formats::EncodeIndex(index));
  RK_RETURN_IF_ERROR(WriteDurableJson(index_path, encoded_index));
  AddPhase(phases_, "swap", "ms", PhaseMs(swap_start));
  return {};
}
}  // namespace remotekit
