#pragma once

#include <string>
#include <vector>
#include "base/containers/span.h"
#include "base/files/file.h"
#include "base/files/file_util.h"
#include "base/files/scoped_file.h"
#include "base/logging.h"
#include "base/rand_util.h"
#include "base/strings/string_number_conversions.h"

namespace remotekit::browser {
enum class ProfileFileState { kMissing, kPresent, kReadFailed };
struct ProfileFile {
  ProfileFileState state;
  std::string text;
};
inline ProfileFile ReadProfileFile(const base::FilePath& path) {
  base::File file(path, base::File::FLAG_OPEN | base::File::FLAG_READ);
  if (!file.IsValid()) {
    if (file.error_details() == base::File::FILE_ERROR_NOT_FOUND)
      return {ProfileFileState::kMissing, {}};
    LOG(ERROR) << "Cannot open profile file " << path << ": " << file.error_details();
    return {ProfileFileState::kReadFailed, {}};
  }
  base::ScopedFILE stream(base::FileToFILE(std::move(file), "rb"));
  std::string text;
  if (!stream || !base::ReadStreamToString(stream.get(), &text)) {
    LOG(ERROR) << "Cannot read profile file " << path;
    return {ProfileFileState::kReadFailed, {}};
  }
  return {ProfileFileState::kPresent, std::move(text)};
}
inline std::string LoadMediaDeviceSalt(const base::FilePath& path) {
  const auto file = ReadProfileFile(path);
  if (file.state == ProfileFileState::kPresent) {
    std::vector<uint8_t> decoded;
    if (file.text.size() == 64 && base::HexStringToBytes(file.text, &decoded))
      return file.text;
    LOG(ERROR) << "Invalid MediaDeviceSalt in " << path;
  }
  const auto salt = base::HexEncode(base::RandBytesAsString(32));
  if (file.state == ProfileFileState::kMissing && !base::WriteFile(path, salt))
    LOG(ERROR) << "Cannot persist MediaDeviceSalt in " << path;
  return salt;
}
}  // namespace remotekit::browser
