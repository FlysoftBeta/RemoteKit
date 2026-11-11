#include "logging.hpp"
#include <fstream>
namespace remotekit::updater {
namespace {
constexpr uint64_t kLimit = 16 * 1024 * 1024;
}
Log::Log(fs::path path) : path_(std::move(path)) {
  fs::create_directories(path_.parent_path());
}
void Log::Rotate() {
  for (int i = 4; i >= 1; --i) {
    fs::path target = path_.wstring() + L"." + std::to_wstring(i);
    std::error_code ec;
    fs::remove(target, ec);
    fs::path source = i == 1 ? path_ : fs::path(path_.wstring() + L"." + std::to_wstring(i - 1));
    if (fs::exists(source))
      fs::rename(source, target);
  }
}
void Log::Write(std::span<const uint8_t> bytes) {
  std::lock_guard lock(mutex_);
  while (!bytes.empty()) {
    uint64_t size = fs::exists(path_) ? fs::file_size(path_) : 0;
    if (size >= kLimit) {
      Rotate();
      size = 0;
    }
    auto n = static_cast<size_t>(std::min<uint64_t>(bytes.size(), kLimit - size));
    std::ofstream file(path_, std::ios::binary | std::ios::app);
    if (!file.write(reinterpret_cast<const char*>(bytes.data()), n))
      throw std::runtime_error("cannot write log");
    bytes = bytes.subspan(n);
  }
}
void Log::Event(LogLevel level, std::string_view event, Json fields) {
  const auto line = FormatLogRecord(level, event, std::move(fields));
  std::lock_guard lock(mutex_);
  if (fs::exists(path_) && fs::file_size(path_) >= kLimit)
    Rotate();
  std::ofstream file(path_, std::ios::binary | std::ios::app);
  if (!file.write(line.data(), static_cast<std::streamsize>(line.size())))
    throw std::runtime_error("cannot write log");
  file.flush();
}

}  // namespace remotekit::updater
