#include "persistence/session_store.hpp"
#include <windows.h>
#include <fstream>
namespace remotekit {
namespace {
Error IoError(const char* operation) {
  return {ErrorCode::kUnavailable,
          std::string(operation) + " Windows " + std::to_string(GetLastError())};
}
}  // namespace
Result<void> FlushFile(const fs::path& path) {
  HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                            FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE)
    return IoError("state open failed");
  const bool flushed = FlushFileBuffers(file) != FALSE;
  const auto error = flushed ? Error{ErrorCode::kInternal, {}} : IoError("state flush failed");
  CloseHandle(file);
  if (!flushed)
    return error;
  return {};
}
Result<void> WriteDurableJson(const fs::path& path,
                              const Json& value,
                              const std::function<void()>& before_commit) {
  std::error_code directory_error;
  fs::create_directories(path.parent_path(), directory_error);
  if (directory_error)
    return Error{ErrorCode::kUnavailable, "state directory unavailable"};
  auto temporary = path;
  temporary += L".new";
  struct Cleanup {
    fs::path path;
    ~Cleanup() {
      std::error_code ignored;
      fs::remove(path, ignored);
    }
  } cleanup{temporary};
  {
    std::ofstream file(temporary, std::ios::binary | std::ios::trunc);
    const auto bytes = value.dump(2);
    file.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
    file.flush();
    file.close();
    if (!file)
      return Error{ErrorCode::kUnavailable, "state write failed"};
  }
  auto flushed = FlushFile(temporary);
  if (!flushed)
    return flushed.error();
  if (before_commit)
    before_commit();
  if (!MoveFileExW(temporary.c_str(), path.c_str(),
                   MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
    return IoError("state commit failed");
  return {};
}
Json SessionStore::Load(const fs::path& name, Json fallback) const {
  std::ifstream file(directory_ / name, std::ios::binary);
  if (!file)
    return fallback;
  Json value;
  file >> value;
  return value;
}
Result<void> SessionStore::Save(const fs::path& name, const Json& value) const {
  return WriteDurableJson(directory_ / name, value);
}
}  // namespace remotekit
