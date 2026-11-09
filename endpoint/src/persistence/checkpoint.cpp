#include "persistence/checkpoint.hpp"
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
bool SafePath(const std::string& text) {
  if (text.empty() || text.find('\\') != std::string::npos || text.find(':') != std::string::npos ||
      text.find('\0') != std::string::npos)
    return false;
  const auto path = Utf8Path(text);
  if (path.is_absolute() || path.has_root_path())
    return false;
  for (const auto& part : path)
    if (part == "." || part == ".." || part.empty() || part.native().back() == L'.' ||
        part.native().back() == L' ')
      return false;
  return true;
}
Json Load(const fs::path& path) {
  std::ifstream input(path, std::ios::binary);
  return input ? Json::parse(input, nullptr, false) : Json();
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
  if (entry.value("directory", false))
    return Json{{"directory", true}};
  return {{"size", entry.at("size")}, {"mtime", entry.at("mtime")}, {"fileId", entry.at("fileId")}};
}
bool ValidIndex(const Json& index) {
  if (!index.is_object())
    return false;
  for (const auto& [name, entry] : index.items()) {
    if (!SafePath(name) || !entry.is_object())
      return false;
    if (entry.contains("directory")) {
      if (entry["directory"] != true)
        return false;
      continue;
    }
    if (!entry.contains("size") || !entry["size"].is_number_unsigned() ||
        !entry.contains("mtime") || !entry["mtime"].is_number_unsigned() ||
        !entry.contains("fileId") || !entry["fileId"].is_string())
      return false;
    if (entry.contains("chunks") &&
        (!entry["chunks"].is_array() || std::ranges::any_of(entry["chunks"], [](const Json& id) {
          return !id.is_string() || !objects::ValidId(id.get<std::string>());
        })))
      return false;
    if (entry.contains("objects")) {
      if (!entry["objects"].is_array() || !entry.contains("chunks") ||
          entry["objects"].size() != entry["chunks"].size())
        return false;
      for (size_t i = 0; i < entry["objects"].size(); ++i) {
        const auto& object = entry["objects"][i];
        if (!object.is_object() || object.value("objectId", Json()) != entry["chunks"][i] ||
            !object.contains("size") || !object["size"].is_number_unsigned() ||
            !object.contains("storedSize") || !object["storedSize"].is_number_unsigned() ||
            !object.contains("storedSha256") || !object["storedSha256"].is_string() ||
            !objects::ValidId(object["storedSha256"].get<std::string>()))
          return false;
      }
    }
  }
  return true;
}
objects::ObjectInfo ObjectMetadata(const Json& value) {
  return {value.at("objectId").get<std::string>(), value.at("size").get<uint64_t>(),
          value.at("storedSize").get<uint64_t>(), value.at("storedSha256").get<std::string>()};
}
class CommitStream {
 public:
  CommitStream(objects::ObjectService& objects, std::string tenant, Json* phases, std::mutex& stats)
      : objects_(objects),
        tenant_(std::move(tenant)),
        phases_(phases),
        stats_(stats),
        worker_([this] { Run(); }) {}
  ~CommitStream() { auto finished = Finish(); }
  void Add(const objects::ObjectInfo& info) {
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
    } catch (const std::exception& error) {
      failure_ = Error{ErrorCode::kUnavailable, error.what()};
    }
  }
  objects::ObjectService& objects_;
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
Result<Json> Checkpoints::Hibernation(const fs::path& directory) {
  const fs::path path = directory.wstring() + L".hibernation.json";
  if (!fs::exists(path))
    return Json();
  auto journal = Load(path);
  if (!journal.is_object() || !journal.contains("placementEpoch") ||
      !journal["placementEpoch"].is_number_unsigned() || journal["placementEpoch"] == 0 ||
      !journal.contains("manifestId") || !journal["manifestId"].is_string() ||
      !objects::ValidId(journal["manifestId"].get<std::string>()) || !journal.contains("objects") ||
      !journal["objects"].is_array() || !journal.contains("buildId") ||
      !journal["buildId"].is_string())
    return Error{ErrorCode::kUnavailable, "invalid hibernation journal"};
  return journal;
}
Result<void> Checkpoints::Journal(const fs::path& directory,
                                  uint64_t epoch,
                                  const Json& checkpoint,
                                  const std::string& build) {
  Json journal = checkpoint;
  journal["placementEpoch"] = epoch;
  journal["buildId"] = build;
  return WriteDurableJson(directory.wstring() + L".hibernation.json", journal);
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
    return relative == "uploads" || relative == "file-library/drafts" ||
           relative == "file-library/incoming" || relative == "file-library/staging";
  }
  return name == L"browser.log" || name == L"LOCK" || name == L"LOG" || name == L"LOG.old" ||
         name == L".checkpoint-watcher";
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
Result<Json> Checkpoints::Scan(const fs::path& directory,
                               const Json& previous,
                               const DirectoryChanges& changes,
                               Json* phases) {
  const auto start = PhaseClock::now();
  Json entries = Json::object();
  const bool incremental = changes.continuous && ValidIndex(previous) && !previous.empty();
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
      const auto path = directory / relative;
      const bool is_directory = fs::is_directory(path);
      if (ExcludedPath(relative, is_directory))
        continue;
      if (!fs::exists(path)) {
        erase(name);
        continue;
      }
      if (is_directory && entries.contains(name) && entries[name].value("directory", false) &&
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
Result<Json> Checkpoints::Create(const fs::path& directory,
                                 const std::string& tenant,
                                 const std::string& build) {
  const fs::path index_path = directory.wstring() + L".checkpoint-index.json";
  auto previous = Load(index_path);
  if (!ValidIndex(previous))
    previous = Json::object();
  fs::create_directories(directory);
  const auto changes = cache_ ? cache_->Changes() : DirectoryChanges{};
  RK_ASSIGN_OR_RETURN(snapshot, Scan(directory, previous, changes, phases_));
  Json index = snapshot;
  std::vector<std::string> names;
  Json directories = Json::array();
  for (const auto& [name, entry] : snapshot.items()) {
    if (entry.value("directory", false))
      directories.push_back(name);
    else
      names.push_back(name);
  }
  std::mutex stats;
  CommitStream commits(objects_, tenant, phases_, stats);
  const auto store_start = PhaseClock::now();
  auto stored =
      CheckpointParallel(names.size(), CheckpointWorkers(), [&](size_t position) -> Result<void> {
        const auto& name = names[position];
        const auto& identity = snapshot.at(name);
        std::vector<objects::ObjectInfo> objects;
        bool reuse = previous.contains(name) && !previous[name].value("directory", false) &&
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
          std::ifstream input(directory / Utf8Path(name), std::ios::binary);
          if (!input)
            return Error{ErrorCode::kUnavailable, "checkpoint file open failed"};
          uint64_t remaining = identity["size"].get<uint64_t>();
          do {
            std::string bytes(static_cast<size_t>(std::min<uint64_t>(remaining, kChunk)), '\0');
            if (!input.read(bytes.data(), static_cast<std::streamsize>(bytes.size())))
              return Error{ErrorCode::kUnavailable, "checkpoint file read failed"};
            const auto* existing = objects.size() < known.size() ? &known[objects.size()] : nullptr;
            RK_ASSIGN_OR_RETURN(
                info, objects_.Store().WriteChunk(objects_.ObjectKeys(), bytes, existing));
            objects.push_back(std::move(info));
            bytes_read += bytes.size();
            remaining -= bytes.size();
          } while (remaining);
          RK_ASSIGN_OR_RETURN(after, CheckpointIdentity(directory / Utf8Path(name)));
          if (after != identity)
            return Error{ErrorCode::kConflict, "checkpoint file changed during read"};
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
  const auto manifest_start = PhaseClock::now();
  RK_ASSIGN_OR_RETURN(info, objects_.Store().WriteChunk(objects_.ObjectKeys(), manifest.dump()));
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
  const auto journal_start = PhaseClock::now();
  RK_RETURN_IF_ERROR(WriteDurableJson(index_path, index));
  RK_RETURN_IF_ERROR(WriteDurableJson(directory.wstring() + L".checkpoint", info.id));
  if (phases_)
    (*phases_)["journal"] = phases_->value("journal", 0.0) + PhaseMs(journal_start);
  return Json{{"manifestId", info.id}, {"objects", ids}};
}
Result<void> Checkpoints::Restore(const fs::path& directory,
                                  const std::string& tenant,
                                  const Json& checkpoint) {
  const fs::path marker = directory.wstring() + L".checkpoint";
  const fs::path index_path = directory.wstring() + L".checkpoint-index.json";
  RK_ASSIGN_OR_RETURN(journal, Hibernation(directory));
  if (!journal.is_null() && checkpoint != journal["manifestId"])
    return Error{ErrorCode::kConflict,
                 "uncommitted hibernation: checkpoint does not match journal"};
  if (checkpoint.is_null() && fs::exists(directory) && !fs::is_empty(directory))
    return Error{ErrorCode::kConflict, "null checkpoint over non-empty Session directory"};
  const bool warm =
      !checkpoint.is_null() && fs::is_directory(directory) && Load(marker) == checkpoint;
  if (phases_)
    (*phases_)["mode"] = checkpoint.is_null() ? "new" : warm ? "warm" : "cold";
  auto previous = warm ? Load(index_path) : Json();
  if (!ValidIndex(previous))
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
    const auto manifest = Json::parse(bytes, nullptr, false);
    // buildId records the producer; all builds use the same pinned Chromium Profile format.
    if (!manifest.is_object() || manifest.value("version", Json()) != 2 ||
        !manifest.contains("files") || !manifest["files"].is_array() ||
        !manifest.contains("directories") || !manifest["directories"].is_array())
      return Error{ErrorCode::kRejected, "invalid checkpoint manifest"};
    for (const auto& item : manifest["directories"]) {
      if (!item.is_string() || !SafePath(item.get<std::string>()) ||
          !paths.insert(item.get<std::string>()).second)
        return Error{ErrorCode::kRejected, "invalid checkpoint directory"};
      index[item.get<std::string>()] = {{"directory", true}};
    }
    for (const auto& item : manifest["files"]) {
      if (!item.is_object() || !item.contains("path") || !item["path"].is_string() ||
          !SafePath(item["path"].get<std::string>()) || !item.contains("size") ||
          !item["size"].is_number_unsigned() || !item.contains("chunks") ||
          !item["chunks"].is_array() || !paths.insert(item["path"].get<std::string>()).second)
        return Error{ErrorCode::kRejected, "invalid checkpoint file"};
      File file{item["path"].get<std::string>(), item["size"].get<uint64_t>(), {}};
      if (item["chunks"].size() !=
          std::max<uint64_t>(1, file.size / kChunk + (file.size % kChunk != 0)))
        return Error{ErrorCode::kRejected, "invalid checkpoint chunk count"};
      for (const auto& id : item["chunks"]) {
        if (!id.is_string() || !objects::ValidId(id.get<std::string>()))
          return Error{ErrorCode::kRejected, "invalid checkpoint chunk"};
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
          auto identity = CheckpointIdentity(directory / Utf8Path(file.name));
          const auto& old = previous[file.name];
          if (identity && old.is_object() && old.contains("fileId") &&
              BareIdentity(old) == identity.value() &&
              old.value("chunks", Json()) == Json(file.chunks) &&
              identity.value()["size"] == file.size) {
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
    if (entry.value("directory", false))
      unique_directories.insert(restore / Utf8Path(name));
  for (const auto& file : files)
    if (!file.matched)
      unique_directories.insert((restore / Utf8Path(file.name)).parent_path());
  const std::vector<fs::path> directories(unique_directories.begin(), unique_directories.end());
  RK_RETURN_IF_ERROR(CheckpointParallel(directories.size(), 8, [&](size_t i) -> Result<void> {
    fs::create_directories(directories[i]);
    return {};
  }));
  RK_RETURN_IF_ERROR(CheckpointParallel(files.size(), 8, [&](size_t i) -> Result<void> {
    const auto& file = files[i];
    if (file.matched)
      return {};
    const auto path = restore / Utf8Path(file.name);
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
    const auto path = restore / Utf8Path(file.name);
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
    return Error{ErrorCode::kUnavailable,
                 "checkpoint object unavailable: " + materialized.error().message};
  RK_RETURN_IF_ERROR(CheckpointParallel(files.size(), 8, [&](size_t i) -> Result<void> {
    auto& file = files[i];
    if (file.matched)
      return {};
    const auto path = restore / Utf8Path(file.name);
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
    // Include files created outside the checkpoint before the watcher starts.
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
      if (index.contains(name))
        continue;
      if (is_directory)
        index[name] = {{"directory", true}};
      else {
        RK_ASSIGN_OR_RETURN(identity, CheckpointIdentity(entry->path()));
        index[name] = std::move(identity);
      }
    }
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
  RK_RETURN_IF_ERROR(WriteDurableJson(index_path, index));
  fs::remove(marker);
  AddPhase(phases_, "swap", "ms", PhaseMs(swap_start));
  return {};
}
}  // namespace remotekit
