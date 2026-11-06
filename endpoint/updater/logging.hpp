#pragma once
#include "platform.hpp"
#include <mutex>
namespace remotekit::updater {
class Log {
 public:
  explicit Log(fs::path path);
  void Write(std::span<const uint8_t> bytes);
  void Line(const std::string& message);

 private:
  fs::path path_;
  std::mutex mutex_;
  void Rotate();
};
}  // namespace remotekit::updater
