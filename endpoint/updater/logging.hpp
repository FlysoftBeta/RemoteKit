#pragma once
#include "platform.hpp"
#include "util/log.hpp"
#include <mutex>
namespace remotekit::updater {
class Log {
 public:
  explicit Log(fs::path path);
  void Write(std::span<const uint8_t> bytes);
  void Event(LogLevel level, std::string_view event, Json fields = Json::object());

 private:
  fs::path path_;
  std::mutex mutex_;
  void Rotate();
};
}  // namespace remotekit::updater
