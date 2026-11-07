#include "diagnostics/log_files.hpp"
#include <windows.h>
#include <wincrypt.h>
#include <algorithm>
#include <vector>

namespace remotekit {
namespace {
struct FileHandle {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~FileHandle() {
    if (value != INVALID_HANDLE_VALUE)
      CloseHandle(value);
  }
};
Result<std::string> Base64(const std::vector<uint8_t>& bytes) {
  if (bytes.empty())
    return std::string();
  const DWORD flags = CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF;
  DWORD size = 0;
  if (!CryptBinaryToStringA(bytes.data(), static_cast<DWORD>(bytes.size()), flags, nullptr, &size))
    return Error{ErrorCode::kInternal, "log encoding failed"};
  std::string text(size, '\0');
  if (!CryptBinaryToStringA(bytes.data(), static_cast<DWORD>(bytes.size()), flags, text.data(),
                            &size))
    return Error{ErrorCode::kInternal, "log encoding failed"};
  text.resize(size);
  return text;
}
}  // namespace

Result<Json> ReadLogWindow(const fs::path& path, std::optional<uint64_t> end, uint64_t max_bytes) {
  if (max_bytes == 0 || max_bytes > kLogWindowBytes)
    return Error{ErrorCode::kInvalidRequest, "invalid log window"};
  FileHandle file;
  // Writers keep appending and the updater renames during rotation.
  file.value = CreateFileW(path.c_str(), GENERIC_READ,
                           FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file.value == INVALID_HANDLE_VALUE) {
    const auto error = GetLastError();
    if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND)
      return Json{{"exists", false}, {"size", 0}, {"start", 0}, {"end", 0}, {"data", ""}};
    return Error{ErrorCode::kUnavailable, "log open failed " + std::to_string(error)};
  }
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(file.value, &size))
    return Error{ErrorCode::kUnavailable, "log size failed"};
  const auto total = static_cast<uint64_t>(size.QuadPart);
  const uint64_t stop = std::min(end.value_or(total), total);
  const uint64_t start = stop > max_bytes ? stop - max_bytes : 0;
  std::vector<uint8_t> bytes(static_cast<size_t>(stop - start));
  LARGE_INTEGER offset{};
  offset.QuadPart = static_cast<LONGLONG>(start);
  if (!bytes.empty()) {
    if (!SetFilePointerEx(file.value, offset, nullptr, FILE_BEGIN))
      return Error{ErrorCode::kUnavailable, "log seek failed"};
    DWORD read = 0;
    if (!ReadFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr))
      return Error{ErrorCode::kUnavailable, "log read failed"};
    bytes.resize(read);
  }
  auto data = Base64(bytes);
  if (!data)
    return data.error();
  return Json{{"exists", true},
              {"size", total},
              {"start", start},
              {"end", start + bytes.size()},
              {"data", std::move(data).value()}};
}
}  // namespace remotekit
