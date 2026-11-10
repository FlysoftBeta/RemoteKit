#pragma once
#include "files/file_upload.hpp"
#include "files/photo_processing.hpp"

#include <algorithm>
#include <cctype>
#include <optional>

namespace remotekit {
inline std::optional<PhotoTranscode> SelectionWebpTranscode(
    const std::vector<std::string>& accept) {
  std::vector<std::string> types;
  for (auto type : accept) {
    const auto whitespace = [](unsigned char c) { return std::isspace(c) != 0; };
    type.erase(type.begin(), std::find_if_not(type.begin(), type.end(), whitespace));
    type.erase(std::find_if_not(type.rbegin(), type.rend(), whitespace).base(), type.end());
    std::transform(type.begin(), type.end(), type.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    if (!type.empty())
      types.push_back(std::move(type));
  }
  const auto has = [&](std::initializer_list<const char*> values) {
    return std::any_of(types.begin(), types.end(), [&](const auto& type) {
      return std::any_of(values.begin(), values.end(),
                         [&](const auto* value) { return type == value; });
    });
  };
  if (types.empty() || has({"image/webp", "image/*", ".webp"}))
    return {};
  if (has({"image/jpeg", "image/jpg", "image/pjpeg", ".jpg", ".jpeg", ".jfif", ".pjpeg"}))
    return PhotoTranscode::kJpeg;
  if (has({"image/png", ".png"}))
    return PhotoTranscode::kPng;
  return {};
}

inline Result<void> CheckSelectionSources(const std::vector<FileUploadStore::Source>& sources,
                                          const FileUploadStore::Limits& limits) {
  if (sources.empty() || sources.size() > limits.files)
    return Error{ErrorCode::kLimitExceeded, "invalid_file_count"};
  std::uint64_t total = 0;
  for (const auto& source : sources) {
    if (source.spec.size > limits.file_bytes || source.spec.size > limits.batch_bytes - total)
      return Error{ErrorCode::kLimitExceeded, "file_too_large", ErrorReason::kFileTooLarge};
    total += source.spec.size;
  }
  return {};
}
}  // namespace remotekit
