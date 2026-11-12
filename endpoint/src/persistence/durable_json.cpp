#include "persistence/durable_json.hpp"
#include <windows.h>
#include <algorithm>
namespace remotekit {
namespace {
Error IoError(const char* operation) {
  const auto code = GetLastError();
  return WithOsError(ErrorCode::kUnavailable,
                     std::string(operation) + " Windows " + std::to_string(code),
                     OsError::Kind::kWin32, code);
}
}  // namespace
Result<void> FlushFile(const fs::path& raw_path) {
  const auto path = LongPath(raw_path);
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
Result<void> WriteDurableText(const fs::path& raw_path,
                              std::string_view bytes,
                              const std::function<Result<void>()>& before_commit) {
  const auto path = LongPath(raw_path);
  std::error_code directory_error;
  fs::create_directories(path.parent_path(), directory_error);
  if (directory_error)
    return WithOsError(ErrorCode::kUnavailable, "state directory unavailable",
                       OsError::Kind::kWin32, directory_error.value());
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
    const auto file = CreateFileW(temporary.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr,
                                  CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE)
      return IoError("state open failed");
    struct Close {
      HANDLE file;
      ~Close() { CloseHandle(file); }
    } close{file};
    for (size_t offset = 0; offset < bytes.size();) {
      const auto count = static_cast<DWORD>(std::min<size_t>(65536, bytes.size() - offset));
      DWORD written = 0;
      if (!WriteFile(file, bytes.data() + offset, count, &written, nullptr))
        return IoError("state write failed");
      offset += written;
    }
  }
  auto flushed = FlushFile(temporary);
  if (!flushed)
    return flushed.error();
  if (before_commit) {
    auto current = before_commit();
    if (!current)
      return current.error();
  }
  if (!MoveFileExW(temporary.c_str(), path.c_str(),
                   MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
    return IoError("state commit failed");
  return {};
}
Result<void> WriteDurableJson(const fs::path& path,
                              const Json& value,
                              const std::function<Result<void>()>& before_commit) {
  return WriteDurableText(path, value.dump(2), before_commit);
}
}  // namespace remotekit
