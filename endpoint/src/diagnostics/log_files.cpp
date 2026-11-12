#include "diagnostics/log_files.hpp"
#include "util/log.hpp"
#include "util/file_io.hpp"
#include "util/result_macros.hpp"
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
    return WithOsError(ErrorCode::kInternal, "log encoding failed", OsError::Kind::kWin32,
                       GetLastError());
  std::string text(size, '\0');
  if (!CryptBinaryToStringA(bytes.data(), static_cast<DWORD>(bytes.size()), flags, text.data(),
                            &size))
    return WithOsError(ErrorCode::kInternal, "log encoding failed", OsError::Kind::kWin32,
                       GetLastError());
  text.resize(size);
  return text;
}
}  // namespace

Result<Json> SearchErrorLogs(const fs::path& node_root, const std::string& error_id) {
  if (!ValidErrorId(error_id))
    return Error{ErrorCode::kInvalidRequest, "invalid error id"};
  std::vector<std::string> matches;
  for (int rotation = 0; rotation <= 4 && matches.size() < 50; ++rotation) {
    auto path = node_root / "logs/endpoint.log";
    if (rotation)
      path += "." + std::to_string(rotation);
    RK_ASSIGN_OR_RETURN(bytes, ReadFileIfExists(path));
    if (!bytes)
      continue;
    std::vector<std::string_view> lines;
    size_t start = 0;
    while (start < bytes->size()) {
      const auto end = bytes->find('\n', start);
      const auto length = (end == std::string::npos ? bytes->size() : end) - start;
      lines.emplace_back(bytes->data() + start, length);
      start += length + 1;
    }
    for (auto line = lines.rbegin(); line != lines.rend() && matches.size() < 50; ++line) {
      auto raw = *line;
      if (!raw.empty() && raw.back() == '\r')
        raw.remove_suffix(1);
      if (raw.find(error_id) == std::string_view::npos)
        continue;
      const auto value = Json::parse(raw, nullptr, false);
      if (!value.is_object())
        continue;
      const bool top = value.value("errorId", Json()) == error_id;
      const auto nested = value.find("err");
      if (top || (nested != value.end() && nested->is_object() &&
                  nested->value("errorId", Json()) == error_id))
        matches.emplace_back(raw);
    }
  }
  std::reverse(matches.begin(), matches.end());
  return Json{{"lines", std::move(matches)}};
}
Result<void> DeleteSessionLogs(const fs::path& node_root, const std::string& session_id) {
  const auto directory = node_root / "logs/browser";
  RK_ASSIGN_OR_RETURN(exists, FileExists(directory));
  if (exists) {
    RK_ASSIGN_OR_RETURN(entries, DirectoryEntries(directory));
    const auto prefix = session_id + ".log";
    for (const auto& entry : entries) {
      const auto name = entry.path().filename().string();
      if (name == prefix || name.starts_with(prefix + "."))
        RK_RETURN_IF_ERROR(RemoveFile(entry.path()));
    }
  }
  return RemoveTree(node_root / "logs/crashes" / session_id);
}

std::vector<fs::path> RecentCrashDumps(const fs::path& directory) {
  std::vector<std::pair<fs::file_time_type, fs::path>> dumps;
  std::error_code error;
  for (fs::recursive_directory_iterator it(directory, error), end; it != end; it.increment(error)) {
    if (error)
      break;
    if (!it->is_regular_file(error) || it->path().extension() != ".dmp")
      continue;
    const auto time = it->last_write_time(error);
    if (!error)
      dumps.emplace_back(time, it->path());
  }
  std::sort(dumps.begin(), dumps.end(),
            [](const auto& a, const auto& b) { return a.first > b.first; });
  std::vector<fs::path> paths;
  for (size_t i = 0; i < std::min<size_t>(3, dumps.size()); ++i)
    paths.push_back(dumps[i].second);
  return paths;
}

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
    return WithOsError(ErrorCode::kUnavailable, "log open failed " + std::to_string(error),
                       OsError::Kind::kWin32, error);
  }
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(file.value, &size))
    return WithOsError(ErrorCode::kUnavailable, "log size failed", OsError::Kind::kWin32,
                       GetLastError());
  const auto total = static_cast<uint64_t>(size.QuadPart);
  const uint64_t stop = std::min(end.value_or(total), total);
  const uint64_t start = stop > max_bytes ? stop - max_bytes : 0;
  std::vector<uint8_t> bytes(static_cast<size_t>(stop - start));
  LARGE_INTEGER offset{};
  offset.QuadPart = static_cast<LONGLONG>(start);
  if (!bytes.empty()) {
    if (!SetFilePointerEx(file.value, offset, nullptr, FILE_BEGIN))
      return WithOsError(ErrorCode::kUnavailable, "log seek failed", OsError::Kind::kWin32,
                         GetLastError());
    DWORD read = 0;
    if (!ReadFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr))
      return WithOsError(ErrorCode::kUnavailable, "log read failed", OsError::Kind::kWin32,
                         GetLastError());
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
Result<Json> ReadSessionLog(const fs::path& node_root,
                            const std::string& session_id,
                            const Json& request) {
  const auto name = Required(request, "log");
  fs::path path;
  if (name == "browser")
    path = node_root / "logs/browser" / (session_id + ".log");
  else if (name == "endpoint")
    path = node_root / "logs" / "endpoint.log";
  else if (name == "endpoint.1")
    path = node_root / "logs" / "endpoint.log.1";
  else if (name == "crashes")
    path = node_root / "logs/crashes" / session_id / "events.jsonl";
  else if (name.starts_with("dump/")) {
    for (const auto& dump : RecentCrashDumps(node_root / "logs/crashes" / session_id))
      if (name == "dump/" + Utf8(dump.filename()))
        path = dump;
    if (path.empty())
      return Error{ErrorCode::kNotFound, "crash dump not found"};
  } else
    return Error{ErrorCode::kInvalidRequest, "unknown log"};
  if (!request.contains("maxBytes"))
    return Error{ErrorCode::kInvalidRequest, "invalid log window"};
  const auto& max = request.at("maxBytes");
  const auto* end = request.contains("end") ? &request.at("end") : nullptr;
  if (!max.is_number_unsigned() || (end && !end->is_number_unsigned()))
    return Error{ErrorCode::kInvalidRequest, "invalid log window"};
  auto window = ReadLogWindow(path, end ? std::optional(end->get<uint64_t>()) : std::nullopt,
                              max.get<uint64_t>());
  if (window && name == "crashes") {
    window.value()["dumps"] = Json::array();
    for (const auto& dump : RecentCrashDumps(node_root / "logs/crashes" / session_id)) {
      std::error_code error;
      const auto size = fs::file_size(dump, error);
      if (!error)
        window.value()["dumps"].push_back({{"name", Utf8(dump.filename())}, {"size", size}});
    }
  }
  return window;
}
}  // namespace remotekit
