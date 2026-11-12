#pragma once
#include "persistence/phase_timing.hpp"
#include <windows.h>
#include <condition_variable>
#include <map>
#include <mutex>
#include <thread>
#include <set>

namespace remotekit {
struct DirectoryChanges {
  bool continuous = false;
  std::map<std::string, PhaseClock::time_point> paths;
  std::set<std::string> subtrees;
  std::set<std::string> removed;
};
class DirectoryWatcher {
 public:
  ~DirectoryWatcher();
  void Start(const fs::path& directory);
  void Stop();
  void Invalidate();
  void Merge(const DirectoryChanges& changes);
  DirectoryChanges Snapshot() const;

 private:
  friend class CheckpointCacheProbe;
  void Run();
  fs::path directory_;
  HANDLE directory_handle_ = INVALID_HANDLE_VALUE;
  HANDLE event_ = nullptr;
  HANDLE stop_event_ = nullptr;
  std::thread worker_;
  mutable std::mutex mutex_;
  std::condition_variable changed_;
  DirectoryChanges changes_;
  bool armed_ = false, barrier_ = false;
};
}  // namespace remotekit
