#include "diagnostics/log_files.hpp"
#include "management/coordination.hpp"
#include "management/reply.hpp"
#include "util/log.hpp"
#include "util/file_io.hpp"
#include "util/result_macros.hpp"
#include <windows.h>
#include <algorithm>
#include <regex>
#include <functional>

namespace remotekit {
namespace {
struct FileHandle {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~FileHandle() {
    if (value != INVALID_HANDLE_VALUE)
      CloseHandle(value);
  }
};
bool LogName(const std::string& name) {
  static const std::regex pattern(
      R"(^(?:control|manager|node|endpoint|snapshot|browser-[A-Za-z0-9_-]+)(?:\.[1-9][0-9]*)?\.jsonl$)");
  return std::regex_match(name, pattern);
}
// The configured logs root may itself sit behind a junction; only names below it are checked.
Result<void> NoReparsePoints(const fs::path& root, const fs::path& path) {
  const auto relative = path.lexically_relative(root);
  if (relative.empty() || *relative.begin() == "..")
    return Error{ErrorCode::kInvalidRequest, "log path outside root"};
  fs::path current = root;
  for (const auto& component : relative) {
    if (component == ".")
      continue;
    current /= component;
    auto identity = FileIdentityNoReparse(current);
    if (!identity) {
      auto error = identity.error();
      if (error.code == ErrorCode::kRejected)
        error.code = ErrorCode::kInvalidRequest;
      else if (error.os &&
               (error.os->value == ERROR_FILE_NOT_FOUND || error.os->value == ERROR_PATH_NOT_FOUND))
        error.code = ErrorCode::kNotFound;
      return error;
    }
  }
  return {};
}
Result<std::vector<fs::directory_entry>> Entries(const fs::path& root, const fs::path& path) {
  auto safe = NoReparsePoints(root, path);
  if (!safe) {
    if (safe.error().code == ErrorCode::kNotFound)
      return std::vector<fs::directory_entry>();
    return safe.error();
  }
  return DirectoryEntries(path);
}
Result<void> WalkFiles(const fs::path& root,
                       const fs::path& relative,
                       bool recursive,
                       Json& files,
                       const std::string& date,
                       bool whole_day) {
  RK_ASSIGN_OR_RETURN(entries, Entries(root, root / relative));
  for (const auto& entry : entries) {
    const auto path = relative / entry.path().filename();
    auto safe = NoReparsePoints(root, root / path);
    if (!safe) {
      if (safe.error().code == ErrorCode::kInvalidRequest ||
          safe.error().code == ErrorCode::kNotFound)
        continue;
      return safe.error();
    }
    std::error_code error;
    if (entry.is_directory(error)) {
      if (recursive)
        RK_RETURN_IF_ERROR(WalkFiles(root, path, true, files, date, false));
      continue;
    }
    if (!entry.is_regular_file(error) || (!recursive && !LogName(Utf8(entry.path().filename()))))
      continue;
    // Directory enumeration caches size and mtime; files still open for append report stale
    // values there, so read both from the file itself.
    auto info = FileIdentityNoReparse(root / path);
    if (!info) {
      if (info.error().code == ErrorCode::kRejected ||
          (info.error().os && (info.error().os->value == ERROR_FILE_NOT_FOUND ||
                               info.error().os->value == ERROR_PATH_NOT_FOUND)))
        continue;
      return info.error();
    }
    const auto ticks = (uint64_t(info.value().ftLastWriteTime.dwHighDateTime) << 32) |
                       info.value().ftLastWriteTime.dwLowDateTime;
    const auto system = FileTimeToLogClock(static_cast<int64_t>(ticks));
    if (!whole_day && LocalLogDate(system) != date)
      continue;
    const uint64_t size = (uint64_t(info.value().nFileSizeHigh) << 32) | info.value().nFileSizeLow;
    files.push_back(
        {{"path", Utf8(path.generic_wstring())},
         {"size", size},
         {"mtime", std::chrono::duration_cast<std::chrono::milliseconds>(system.time_since_epoch())
                       .count()}});
  }
  return {};
}
// Stop once the consumer has enough records. A partial first line is omitted.
Result<void> ReverseLines(const fs::path& path,
                          uint64_t tail_bytes,
                          const std::function<bool(std::string_view)>& consume) {
  FileHandle file{CreateFileW(path.c_str(), GENERIC_READ,
                              FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                              OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  if (file.value == INVALID_HANDLE_VALUE)
    return WithOsError(ErrorCode::kUnavailable, "log open failed", OsError::Kind::kWin32,
                       GetLastError());
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(file.value, &size))
    return WithOsError(ErrorCode::kUnavailable, "log size failed", OsError::Kind::kWin32,
                       GetLastError());
  uint64_t position = static_cast<uint64_t>(size.QuadPart);
  const uint64_t start = position > tail_bytes ? position - tail_bytes : 0;
  std::string pending;
  bool oversize = false;
  while (position > start) {
    const auto count = static_cast<DWORD>(std::min<uint64_t>(65536, position - start));
    position -= count;
    LARGE_INTEGER offset{};
    offset.QuadPart = static_cast<LONGLONG>(position);
    if (!SetFilePointerEx(file.value, offset, nullptr, FILE_BEGIN))
      return WithOsError(ErrorCode::kUnavailable, "log seek failed", OsError::Kind::kWin32,
                         GetLastError());
    std::string block(count, '\0');
    DWORD read = 0;
    if (!ReadFile(file.value, block.data(), count, &read, nullptr))
      return WithOsError(ErrorCode::kUnavailable, "log read failed", OsError::Kind::kWin32,
                         GetLastError());
    block.resize(read);
    block += pending;
    size_t end = block.size();
    for (;;) {
      const auto newline = end ? block.rfind('\n', end - 1) : std::string::npos;
      if (newline == std::string::npos)
        break;
      auto line = std::string_view(block).substr(newline + 1, end - newline - 1);
      if (!line.empty() && line.back() == '\r')
        line.remove_suffix(1);
      if (!oversize && !line.empty() && !consume(line))
        return {};
      oversize = false;
      end = newline;
    }
    // Search replies cannot contain a line larger than the management frame.
    if (end > 2 * limits::managementBytes) {
      oversize = true;
      pending.clear();
    } else {
      pending = block.substr(0, end);
    }
  }
  if (!start && !oversize && !pending.empty()) {
    std::string_view line(pending);
    if (line.back() == '\r')
      line.remove_suffix(1);
    consume(line);
  }
  return {};
}
unsigned Part(const fs::path& path) {
  const auto stem = path.stem().string();
  const auto dot = stem.rfind('.');
  if (dot == std::string::npos)
    return 0;
  try {
    return static_cast<unsigned>(std::stoul(stem.substr(dot + 1)));
  } catch (...) {
    return 0;
  }
}
}  // namespace
Result<fs::path> ValidateLogPath(const fs::path& root, const std::string& relative) {
  if (relative.empty() || relative.find_first_of("\\:\0", 0, 3) != std::string::npos ||
      relative.front() == '/' || relative.back() == '/')
    return Error{ErrorCode::kInvalidRequest, "invalid log path"};
  std::vector<std::string> parts;
  size_t start = 0;
  for (;;) {
    const auto end = relative.find('/', start);
    const auto part = relative.substr(start, end == std::string::npos ? end : end - start);
    if (part.empty() || part == "." || part == ".." || part.back() == '.' || part.back() == ' ')
      return Error{ErrorCode::kInvalidRequest, "invalid log path"};
    parts.push_back(part);
    if (end == std::string::npos)
      break;
    start = end + 1;
  }
  if (!((parts.size() == 2 && ValidLogDate(parts[0]) && LogName(parts[1])) ||
        (parts.size() >= 3 && parts[0] == "crashes")))
    return Error{ErrorCode::kInvalidRequest, "invalid log path"};
  const auto path = root / Utf8Path(relative);
  RK_RETURN_IF_ERROR(NoReparsePoints(root, path));
  return path;
}
Result<Json> NodeLogDays(const fs::path& root) {
  RK_ASSIGN_OR_RETURN(entries, Entries(root, root));
  std::vector<std::string> days;
  for (const auto& entry : entries) {
    const auto name = Utf8(entry.path().filename());
    if (!ValidLogDate(name))
      continue;
    const auto safe = NoReparsePoints(root, entry.path());
    if (!safe) {
      if (safe.error().code == ErrorCode::kInvalidRequest ||
          safe.error().code == ErrorCode::kNotFound)
        continue;
      return safe.error();
    }
    std::error_code error;
    if (entry.is_directory(error))
      days.push_back(name);
  }
  std::sort(days.begin(), days.end(), std::greater<>());
  return Json{{"days", days}};
}
Result<Json> NodeLogList(const fs::path& root, const std::string& date) {
  if (!ValidLogDate(date))
    return Error{ErrorCode::kInvalidRequest, "invalid log date"};
  RK_ASSIGN_OR_RETURN(days, NodeLogDays(root));
  Json files = Json::array();
  for (const auto& day : days.at("days")) {
    const auto text = day.get<std::string>();
    if (text <= date)
      RK_RETURN_IF_ERROR(WalkFiles(root, text, false, files, date, text == date));
  }
  RK_RETURN_IF_ERROR(WalkFiles(root, "crashes", true, files, date, false));
  std::sort(files.begin(), files.end(), [](const Json& a, const Json& b) {
    return a["mtime"] != b["mtime"] ? a["mtime"] > b["mtime"] : a["path"] > b["path"];
  });
  return Json{{"files", std::move(files)}};
}
Result<Json> ReadNodeLog(const fs::path& root, const Json& params) {
  if (!coordination::Keys(params, {"path", "offset", "length"}) || !params["path"].is_string() ||
      !coordination::Epoch(params["offset"], true) ||
      !coordination::Epoch(params["length"], true) || params["length"] > kLogWindowBytes)
    return Error{ErrorCode::kInvalidRequest, "invalid log read"};
  const auto relative = params["path"].get<std::string>();
  RK_ASSIGN_OR_RETURN(path, ValidateLogPath(root, relative));
  FileHandle file{CreateFileW(path.c_str(), GENERIC_READ,
                              FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                              OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  if (file.value == INVALID_HANDLE_VALUE)
    return WithOsError(ErrorCode::kUnavailable, "log open failed", OsError::Kind::kWin32,
                       GetLastError());
  BY_HANDLE_FILE_INFORMATION info{};
  if (!GetFileInformationByHandle(file.value, &info))
    return WithOsError(ErrorCode::kUnavailable, "log size failed", OsError::Kind::kWin32,
                       GetLastError());
  if (info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY))
    return Error{ErrorCode::kInvalidRequest, "invalid log file"};
  const uint64_t size = (uint64_t(info.nFileSizeHigh) << 32) | info.nFileSizeLow;
  const auto offset = params["offset"].get<uint64_t>();
  const auto length = params["length"].get<uint64_t>();
  std::vector<uint8_t> bytes(
      static_cast<size_t>(std::min(length, size > offset ? size - offset : 0)));
  if (!bytes.empty()) {
    LARGE_INTEGER position{};
    position.QuadPart = static_cast<LONGLONG>(offset);
    if (!SetFilePointerEx(file.value, position, nullptr, FILE_BEGIN))
      return WithOsError(ErrorCode::kUnavailable, "log seek failed", OsError::Kind::kWin32,
                         GetLastError());
    DWORD read = 0;
    if (!ReadFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr))
      return WithOsError(ErrorCode::kUnavailable, "log read failed", OsError::Kind::kWin32,
                         GetLastError());
    if (read != bytes.size())
      return Error{ErrorCode::kUnavailable, "log truncated during read"};
  }
  return Json{
      {"path", relative}, {"offset", offset}, {"size", size}, {"data", Json::binary(bytes)}};
}
Result<Json> SearchErrorLogs(const fs::path& node_root, const std::string& error_id) {
  if (!ValidErrorId(error_id))
    return Error{ErrorCode::kInvalidRequest, "invalid error id"};
  const auto root = node_root / "logs";
  RK_ASSIGN_OR_RETURN(days, NodeLogDays(root));
  std::vector<std::string> matches;
  bool truncated = false;
  size_t encoded_bytes = Json{{"lines", Json::array()}, {"truncated", true}}.dump().size();
  constexpr auto budget = limits::managementBytes - kReplyEnvelopeReserve;
  for (const auto& day : days["days"]) {
    RK_ASSIGN_OR_RETURN(entries, Entries(root, root / day.get<std::string>()));
    std::sort(entries.begin(), entries.end(), [](const auto& a, const auto& b) {
      if (a.path().stem().stem() == b.path().stem().stem())
        return Part(a.path()) > Part(b.path());
      return a.path().filename() > b.path().filename();
    });
    for (const auto& entry : entries) {
      std::error_code error;
      if (!LogName(Utf8(entry.path().filename())) || !entry.is_regular_file(error))
        continue;
      auto safe = NoReparsePoints(root, entry.path());
      if (!safe) {
        if (safe.error().code == ErrorCode::kInvalidRequest ||
            safe.error().code == ErrorCode::kNotFound)
          continue;
        return safe.error();
      }
      RK_RETURN_IF_ERROR(ReverseLines(entry.path(), UINT64_MAX, [&](std::string_view raw) {
        if (raw.find(error_id) == std::string_view::npos)
          return true;
        const auto value = Json::parse(raw, nullptr, false);
        if (!value.is_object())
          return true;
        const bool top = value.value("errorId", Json()) == error_id;
        const auto nested = value.find("err");
        if (!top && !(nested != value.end() && nested->is_object() &&
                      nested->value("errorId", Json()) == error_id))
          return true;
        const auto size = Json(raw).dump().size() + (matches.empty() ? 0 : 1);
        if (matches.size() >= limits::logSearchLines || encoded_bytes + size > budget) {
          truncated = true;
          return matches.size() < limits::logSearchLines;
        }
        encoded_bytes += size;
        matches.emplace_back(raw);
        return true;
      }));
      if (matches.size() == limits::logSearchLines && truncated)
        break;
    }
    if (matches.size() == limits::logSearchLines && truncated)
      break;
  }
  std::reverse(matches.begin(), matches.end());
  Json result{{"lines", std::move(matches)}};
  if (truncated)
    result["truncated"] = true;
  return result;
}
Result<void> DeleteSessionLogs(const fs::path& node_root, const std::string& session_id) {
  return RemoveTree(node_root / "logs/crashes" / session_id);
}
std::vector<fs::path> RecentCrashDumps(const fs::path& directory) {
  std::vector<std::pair<fs::file_time_type, fs::path>> dumps;
  std::error_code error;
  for (fs::recursive_directory_iterator it(directory, error), end; it != end; it.increment(error)) {
    if (error)
      break;
    if (!NoReparsePoints(directory, it->path())) {
      it.disable_recursion_pending();
      continue;
    }
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
std::string LastBrowserFatal(const fs::path& root, const std::string& session_id) {
  auto days = NodeLogDays(root);
  if (!days)
    return {};
  for (const auto& day : days.value()["days"]) {
    auto entries = Entries(root, root / day.get<std::string>());
    if (!entries)
      continue;
    std::vector<fs::path> files;
    const auto base = "browser-" + session_id;
    for (const auto& entry : entries.value()) {
      const auto name = Utf8(entry.path().filename());
      if ((name == base + ".jsonl" || name.starts_with(base + ".")) && LogName(name) &&
          NoReparsePoints(root, entry.path()))
        files.push_back(entry.path());
    }
    std::sort(files.begin(), files.end(),
              [](const auto& a, const auto& b) { return Part(a) > Part(b); });
    if (files.empty())
      continue;
    std::string fatal;
    auto read = ReverseLines(files.front(), 1024 * 1024, [&](std::string_view raw) {
      const auto record = Json::parse(raw, nullptr, false);
      if (record.is_object() && record.value("ev", Json()) == "chromium.log" &&
          record.value("severity", Json()) == "FATAL" &&
          record.value("message", Json()).is_string()) {
        fatal = record["message"].get<std::string>();
        return false;
      }
      return true;
    });
    return fatal;
  }
  return {};
}
}  // namespace remotekit
