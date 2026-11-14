#pragma once
#include "../updater/platform.hpp"
#include <fstream>
#include <algorithm>
#include <set>

namespace remotekit::release {
namespace fs = std::filesystem;
using cluster::Bytes;
using cluster::Json;
using cluster::Key;
struct Failure : std::exception {
  Error error;
  explicit Failure(Error value) : error(std::move(value)) {}
  const char* what() const noexcept override { return error.message.c_str(); }
};
inline void Fail(ErrorCode code, std::string message) {
  throw Failure({code, std::move(message)});
}
inline void Require(bool value, const char* message) {
  if (!value)
    Fail(ErrorCode::kRejected, message);
}
inline void Io(bool value, const char* message) {
  if (!value)
    Fail(ErrorCode::kUnavailable, message);
}
template <class T>
T Take(Result<T> result) {
  if (!result)
    throw Failure(result.error());
  return std::move(result).value();
}
inline void Take(Result<void> result) {
  if (!result)
    throw Failure(result.error());
}
Bytes Read(const fs::path& path, uint64_t limit = UINT64_MAX);
Key Unhex(const std::string& hex);
std::string HashFile(const fs::path& path);
inline void Write(const fs::path& path, std::span<const uint8_t> bytes) {
  std::ofstream file(path, std::ios::binary | std::ios::trunc);
  Io(static_cast<bool>(file.write(reinterpret_cast<const char*>(bytes.data()), bytes.size())),
     "cannot write release file");
  file.close();
  Io(!file.fail(), "cannot close release file");
}
inline void WriteText(const fs::path& path, const std::string& text) {
  Write(path, {reinterpret_cast<const uint8_t*>(text.data()), text.size()});
}
inline Json ParseJson(std::string_view text) {
  std::vector<std::set<std::string>> objects;
  bool duplicate = false;
  auto callback = [&](int, Json::parse_event_t event, Json& parsed) {
    if (event == Json::parse_event_t::object_start)
      objects.emplace_back();
    if (event == Json::parse_event_t::key &&
        !objects.back().insert(parsed.get<std::string>()).second)
      duplicate = true;
    if (event == Json::parse_event_t::object_end)
      objects.pop_back();
    return true;
  };
  auto json = Json::parse(text, callback, false);
  Require(!json.is_discarded() && !duplicate, "invalid release JSON");
  return json;
}
inline void Keys(const Json& json,
                 std::initializer_list<std::string_view> required,
                 std::initializer_list<std::string_view> optional = {}) {
  Require(json.is_object(), "expected JSON object");
  for (auto key : required)
    Require(json.contains(key), "missing JSON field");
  for (auto it = json.begin(); it != json.end(); ++it)
    Require(std::find(required.begin(), required.end(), it.key()) != required.end() ||
                std::find(optional.begin(), optional.end(), it.key()) != optional.end(),
            "unknown JSON field");
}
inline uint64_t Unsigned(const Json& json) {
  Require(json.is_number_unsigned(), "expected unsigned integer");
  return json.get<uint64_t>();
}
inline std::string HexString(const Json& json) {
  Require(json.is_string() && cluster::ValidBuildId(json.get_ref<const std::string&>()),
          "expected lowercase 64 hex digits");
  return json.get<std::string>();
}
inline void AtomicText(const fs::path& path, const std::string& text) {
  auto temporary = fs::path(path.wstring() + L".tmp");
  WriteText(temporary, text);
  updater::Handle file(CreateFileW(temporary.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr,
                                   OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  Io(file.value != INVALID_HANDLE_VALUE && FlushFileBuffers(file.value),
     "cannot flush release file");
  Io(CloseHandle(file.Release()) != FALSE, "cannot close flushed release file");
  // Scanners and indexers briefly open fresh files without FILE_SHARE_DELETE.
  for (int attempt = 1;; ++attempt) {
    if (MoveFileExW(temporary.c_str(), path.c_str(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
      return;
    const DWORD error = GetLastError();
    if ((error != ERROR_ACCESS_DENIED && error != ERROR_SHARING_VIOLATION) || attempt == 50)
      Fail(ErrorCode::kUnavailable,
           "cannot activate release file (Windows error " + std::to_string(error) + ")");
    Sleep(20);
  }
}
class Mapping {
 public:
  explicit Mapping(const fs::path& path, std::optional<uint64_t> output_size = {});
  ~Mapping();
  Mapping(const Mapping&) = delete;
  Mapping& operator=(const Mapping&) = delete;
  std::span<uint8_t> bytes() { return {data_, size_}; }

 private:
  updater::Handle file_, mapping_;
  uint8_t* data_ = nullptr;
  size_t size_ = 0;
};
}  // namespace remotekit::release
