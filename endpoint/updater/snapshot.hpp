#pragma once
#include "process.hpp"
namespace remotekit::updater {
class SnapshotSupervisor {
 public:
  SnapshotSupervisor(fs::path executable, fs::path root, std::string node);
  ~SnapshotSupervisor();

 private:
  Handle stop_;
  std::thread worker_;
};
}  // namespace remotekit::updater
