#pragma once

#include "remotekit/error.hpp"
#include <filesystem>
#include <vector>

namespace remotekit {
inline Result<bool> FileExists(const std::filesystem::path& path) {
  std::error_code error;
  const bool exists = std::filesystem::exists(path, error);
  if (error)
    return Error{ErrorCode::kUnavailable, "cannot inspect file: " + error.message()};
  return exists;
}

inline Result<void> CreateDirectories(const std::filesystem::path& path) {
  std::error_code error;
  std::filesystem::create_directories(path, error);
  if (error)
    return Error{ErrorCode::kUnavailable, "cannot create directory: " + error.message()};
  return {};
}

inline Result<uint64_t> FileSize(const std::filesystem::path& path) {
  std::error_code error;
  const auto size = std::filesystem::file_size(path, error);
  if (error)
    return Error{ErrorCode::kUnavailable, "cannot read file size: " + error.message()};
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
    return Error{ErrorCode::kUnavailable, "cannot read directory: " + error.message()};
  return entries;
}

inline Result<void> RemoveTree(const std::filesystem::path& path) {
  std::error_code error;
  std::filesystem::remove_all(path, error);
  if (error)
    return Error{ErrorCode::kUnavailable, "cannot remove directory: " + error.message()};
  return {};
}

inline Result<void> RemoveFile(const std::filesystem::path& path) {
  std::error_code error;
  std::filesystem::remove(path, error);
  if (error)
    return Error{ErrorCode::kUnavailable, "cannot remove file: " + error.message()};
  return {};
}
}  // namespace remotekit
