#include "util/log.hpp"
#include "persistence/checkpoint_cache.hpp"
#include "persistence/checkpoint.hpp"
#include "util/result_macros.hpp"
#include <fstream>
#include <sstream>

namespace remotekit {
Result<Json> CheckpointIdentity(const fs::path& path) {
  HANDLE file = CreateFileW(
      path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (file == INVALID_HANDLE_VALUE)
    return Error{ErrorCode::kUnavailable, "checkpoint file attributes unavailable"};
  BY_HANDLE_FILE_INFORMATION info{};
  const bool ok = GetFileInformationByHandle(file, &info) != FALSE;
  CloseHandle(file);
  if (!ok)
    return Error{ErrorCode::kUnavailable, "checkpoint file identity unavailable"};
  if (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)
    return Error{ErrorCode::kRejected, "checkpoint contains a reparse point"};
  return Json{
      {"size", (uint64_t(info.nFileSizeHigh) << 32) | info.nFileSizeLow},
      {"mtime",
       (uint64_t(info.ftLastWriteTime.dwHighDateTime) << 32) | info.ftLastWriteTime.dwLowDateTime},
      {"fileId", std::to_string(info.dwVolumeSerialNumber) + ":" +
                     std::to_string((uint64_t(info.nFileIndexHigh) << 32) | info.nFileIndexLow)}};
}
CheckpointCache::~CheckpointCache() {
  Stop();
}
void CheckpointCache::Start(const fs::path& directory) {
  directory_ = directory;
  cancel_ = false;
  no_peer_ = PhaseClock::now();
  watcher_.Start(directory);
}
void CheckpointCache::Stop() {
  cancel_ = true;
  ++generation_;
  if (staging_.valid())
    staging_.get();
  watcher_.Stop();
}
void CheckpointCache::PeerPresent(bool present) {
  cancel_ = present;
  if (present)
    ++generation_;
  if (present)
    no_peer_.reset();
  else if (!no_peer_)
    no_peer_ = PhaseClock::now();
}
std::optional<StagedFile> CheckpointCache::Find(const std::string& path,
                                                const Json& identity) const {
  std::lock_guard lock(mutex_);
  const auto found = staged_.find(path);
  if (found == staged_.end() || found->second.identity != identity)
    return {};
  return found->second;
}
void CheckpointCache::MaybeStage(objects::ObjectService& objects, const std::string& tenant) {
  if (cancel_ || !no_peer_ || PhaseClock::now() - *no_peer_ < std::chrono::seconds(30))
    return;
  if (staging_.valid()) {
    if (staging_.wait_for(std::chrono::seconds(0)) != std::future_status::ready)
      return;
    staging_.get();
  }
  const auto changes = watcher_.Snapshot();
  const auto generation = generation_.load();
  auto task = std::make_shared<std::packaged_task<void()>>([this, &objects, tenant, changes,
                                                            generation] {
    SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN);
    struct Priority {
      ~Priority() { SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_END); }
    } priority;
    try {
      for (const auto& [name, changed] : changes.paths) {
        if (cancel_ || generation_ != generation)
          return;
        if (PhaseClock::now() - changed < std::chrono::seconds(10))
          continue;
        const auto path = directory_ / Utf8Path(name);
        bool excluded = false;
        fs::path prefix;
        for (const auto& part : Utf8Path(name)) {
          prefix /= part;
          excluded |= Checkpoints::Excluded(prefix, prefix != Utf8Path(name));
        }
        if (excluded || !fs::is_regular_file(path))
          continue;
        auto before = CheckpointIdentity(path);
        if (!before || Find(name, before.value()))
          continue;
        StagedFile staged{before.value(), {}};
        std::ifstream input(path, std::ios::binary);
        uint64_t remaining = before.value()["size"].get<uint64_t>();
        bool complete = true;
        do {
          if (cancel_ || generation_ != generation) {
            complete = false;
            break;
          }
          std::string bytes(static_cast<size_t>(std::min<uint64_t>(remaining, 1024 * 1024)), '\0');
          if (!input.read(bytes.data(), static_cast<std::streamsize>(bytes.size()))) {
            complete = false;
            break;
          }
          auto object = objects.Store().WriteChunk(objects.ObjectKeys(), bytes);
          if (!object) {
            complete = false;
            break;
          }
          staged.objects.push_back(std::move(object).value());
          remaining -= bytes.size();
        } while (remaining);
        // Even a discarded read owns claims; normal expiry and GC reclaim the cache.
        auto committed = objects.CommittedBatch(staged.objects, tenant);
        const auto after = CheckpointIdentity(path);
        if (committed && complete && after && before.value() == after.value()) {
          std::lock_guard lock(mutex_);
          staged_[name] = std::move(staged);
        }
        return;
      }
    } catch (const std::filesystem::filesystem_error& error) {
      LogError(LogLevel::kWarn, "checkpoint.prestage_failed",
               WithOsError(ErrorCode::kUnavailable, error.what(), OsError::Kind::kWin32,
                           error.code().value()));
    } catch (const std::exception& error) {
      LogError(LogLevel::kWarn, "checkpoint.prestage_failed",
               Error{ErrorCode::kUnavailable, error.what()});
    }
  });
  staging_ = task->get_future();
  if (!objects.PreStage([task] { (*task)(); })) {
    task.reset();
    staging_ = {};
  }
}
}  // namespace remotekit
