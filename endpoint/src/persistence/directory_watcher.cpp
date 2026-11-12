#include "persistence/directory_watcher.hpp"
#include "persistence/durable_json.hpp"
#include <array>
#include <fstream>

namespace remotekit {
namespace {
constexpr wchar_t kBarrier[] = L".checkpoint-watcher";
}
void DirectoryWatcher::Prune(PhaseClock::time_point through) {
  std::lock_guard lock(mutex_);
  for (auto it = changes_.paths.begin(); it != changes_.paths.end();) {
    if (it->second < through) {
      changes_.removed.erase(it->first);
      changes_.subtrees.erase(it->first);
      it = changes_.paths.erase(it);
    } else {
      ++it;
    }
  }
}
DirectoryWatcher::~DirectoryWatcher() {
  Stop();
}
void DirectoryWatcher::Start(const fs::path& directory) {
  Stop();
  directory_ = LongPath(directory);
  fs::create_directories(directory_);
  directory_handle_ =
      CreateFileW(directory_.c_str(), FILE_LIST_DIRECTORY,
                  FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                  FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED, nullptr);
  event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  stop_event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  changes_ = {};
  armed_ = barrier_ = false;
  if (directory_handle_ == INVALID_HANDLE_VALUE || !event_ || !stop_event_) {
    Stop();
    return;
  }
  changes_.continuous = true;
  worker_ = std::thread([this] { Run(); });
  std::unique_lock lock(mutex_);
  changed_.wait(lock, [this] { return armed_; });
}
void DirectoryWatcher::Run() {
  alignas(DWORD) std::array<uint8_t, 64 * 1024> buffer{};
  for (;;) {
    OVERLAPPED pending{};
    pending.hEvent = event_;
    ResetEvent(event_);
    const bool reading =
        ReadDirectoryChangesW(directory_handle_, buffer.data(), static_cast<DWORD>(buffer.size()),
                              TRUE,
                              FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME |
                                  FILE_NOTIFY_CHANGE_SIZE | FILE_NOTIFY_CHANGE_LAST_WRITE |
                                  FILE_NOTIFY_CHANGE_CREATION | FILE_NOTIFY_CHANGE_SECURITY,
                              nullptr, &pending, nullptr) != FALSE;
    {
      std::lock_guard lock(mutex_);
      armed_ = true;
      if (!reading)
        changes_.continuous = false;
    }
    changed_.notify_all();
    if (!reading)
      return;
    const HANDLE events[] = {event_, stop_event_};
    if (WaitForMultipleObjects(2, events, FALSE, INFINITE) != WAIT_OBJECT_0) {
      CancelIoEx(directory_handle_, &pending);
      DWORD discarded = 0;
      GetOverlappedResult(directory_handle_, &pending, &discarded, TRUE);
      Invalidate();
      return;
    }
    DWORD bytes = 0;
    if (!GetOverlappedResult(directory_handle_, &pending, &bytes, TRUE)) {
      Invalidate();
      return;
    }
    std::lock_guard lock(mutex_);
    if (!bytes) {
      changes_.continuous = false;
      continue;
    }
    size_t offset = 0;
    for (;;) {
      const auto* record = reinterpret_cast<const FILE_NOTIFY_INFORMATION*>(buffer.data() + offset);
      const fs::path path(std::wstring(record->FileName, record->FileNameLength / sizeof(wchar_t)));
      if (path == kBarrier) {
        barrier_ = true;
      } else {
        const auto encoded = path.generic_u8string();
        const std::string name(encoded.begin(), encoded.end());
        changes_.paths[name] = PhaseClock::now();
        if (record->Action != FILE_ACTION_MODIFIED)
          changes_.subtrees.insert(name);
        if (record->Action == FILE_ACTION_REMOVED || record->Action == FILE_ACTION_RENAMED_OLD_NAME)
          changes_.removed.insert(name);
        if (record->Action == FILE_ACTION_ADDED || record->Action == FILE_ACTION_RENAMED_NEW_NAME)
          changes_.removed.erase(name);
      }
      if (!record->NextEntryOffset)
        break;
      offset += record->NextEntryOffset;
    }
    changed_.notify_all();
    if (barrier_)
      return;
  }
}
void DirectoryWatcher::Stop() {
  if (worker_.joinable()) {
    // A marker on the same notification stream drains every preceding file event.
    std::ofstream marker(directory_ / kBarrier, std::ios::binary | std::ios::trunc);
    marker << '1';
    marker.close();
    {
      std::unique_lock lock(mutex_);
      if (!marker || !changed_.wait_for(lock, std::chrono::seconds(2), [this] { return barrier_; }))
        changes_.continuous = false;
    }
    SetEvent(stop_event_);
    worker_.join();
    std::error_code error;
    fs::remove(directory_ / kBarrier, error);
  }
  if (directory_handle_ != INVALID_HANDLE_VALUE)
    CloseHandle(directory_handle_);
  if (event_)
    CloseHandle(event_);
  if (stop_event_)
    CloseHandle(stop_event_);
  directory_handle_ = INVALID_HANDLE_VALUE;
  event_ = nullptr;
  stop_event_ = nullptr;
}
void DirectoryWatcher::Invalidate() {
  std::lock_guard lock(mutex_);
  changes_.continuous = false;
}
DirectoryChanges DirectoryWatcher::Snapshot() const {
  std::lock_guard lock(mutex_);
  return changes_;
}
void DirectoryWatcher::Merge(const DirectoryChanges& changes) {
  std::lock_guard lock(mutex_);
  changes_.continuous &= changes.continuous;
  for (const auto& [name, at] : changes.paths)
    changes_.paths.try_emplace(name, at);
  changes_.subtrees.insert(changes.subtrees.begin(), changes.subtrees.end());
  changes_.removed.insert(changes.removed.begin(), changes.removed.end());
  for (const auto& [name, at] : changes_.paths)
    if (fs::exists(LongPath(directory_ / Utf8Path(name))))
      changes_.removed.erase(name);
}
}  // namespace remotekit
