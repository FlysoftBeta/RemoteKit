#pragma once

#include "util/error.hpp"
#include <filesystem>
#include <vector>
#include <optional>
#include <string>
#include <windows.h>

namespace remotekit {
inline Result<std::optional<std::string>> ReadFileIfExists(const std::filesystem::path& path) {
  const auto file = CreateFileW(path.c_str(), GENERIC_READ,
                                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                                OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  const auto failure = [&](DWORD code) -> Error {
    const auto utf8 = path.u8string();
    const std::string name(reinterpret_cast<const char*>(utf8.data()), utf8.size());
    return WithOsError(ErrorCode::kUnavailable,
                       "cannot read " + name + ": Windows " + std::to_string(code),
                       OsError::Kind::kWin32, code);
  };
  if (file == INVALID_HANDLE_VALUE) {
    const auto code = GetLastError();
    if (code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND)
      return std::optional<std::string>();
    return failure(code);
  }
  struct Close {
    HANDLE file;
    ~Close() { CloseHandle(file); }
  } close{file};
  std::string result;
  char buffer[65536];
  for (;;) {
    DWORD read = 0;
    if (!ReadFile(file, buffer, sizeof(buffer), &read, nullptr))
      return failure(GetLastError());
    if (!read)
      break;
    result.append(buffer, read);
  }
  return std::optional<std::string>(std::move(result));
}
inline Result<bool> FileExists(const std::filesystem::path& path) {
  std::error_code error;
  const bool exists = std::filesystem::exists(path, error);
  if (error)
    return WithOsError(ErrorCode::kUnavailable, "cannot inspect file: " + error.message(),
                       OsError::Kind::kWin32, error.value());
  return exists;
}

inline Result<void> CreateDirectories(const std::filesystem::path& path) {
  std::error_code error;
  std::filesystem::create_directories(path, error);
  if (error)
    return WithOsError(ErrorCode::kUnavailable, "cannot create directory: " + error.message(),
                       OsError::Kind::kWin32, error.value());
  return {};
}

inline Result<uint64_t> FileSize(const std::filesystem::path& path) {
  std::error_code error;
  const auto size = std::filesystem::file_size(path, error);
  if (error)
    return WithOsError(ErrorCode::kUnavailable, "cannot read file size: " + error.message(),
                       OsError::Kind::kWin32, error.value());
  return size;
}

inline Result<std::vector<std::filesystem::directory_entry>> DirectoryEntries(
    const std::filesystem::path& path) {
  std::error_code error;
  std::filesystem::directory_iterator it(path, error), end;
  std::vector<std::filesystem::directory_entry> entries;
  while (!error && it != end) {
    entries.push_back(*it);
    it.increment(error);
  }
  if (error)
    return WithOsError(ErrorCode::kUnavailable, "cannot read directory: " + error.message(),
                       OsError::Kind::kWin32, error.value());
  return entries;
}

inline Result<void> RemoveTree(const std::filesystem::path& path) {
  std::error_code error;
  std::filesystem::remove_all(path, error);
  if (error)
    return WithOsError(ErrorCode::kUnavailable, "cannot remove directory: " + error.message(),
                       OsError::Kind::kWin32, error.value());
  return {};
}

inline Result<void> RemoveFile(const std::filesystem::path& path) {
  std::error_code error;
  std::filesystem::remove(path, error);
  if (error)
    return WithOsError(ErrorCode::kUnavailable, "cannot remove file: " + error.message(),
                       OsError::Kind::kWin32, error.value());
  return {};
}
}  // namespace remotekit
