#include "common.hpp"
#include <algorithm>

namespace remotekit::release {
Bytes Read(const fs::path& path, uint64_t limit) {
  std::ifstream file(path, std::ios::binary | std::ios::ate);
  Io(file.is_open(), "cannot open release file");
  auto length = file.tellg();
  Require(length >= 0 && static_cast<uint64_t>(length) <= limit, "release file too large");
  Bytes bytes(static_cast<size_t>(length));
  file.seekg(0);
  Io(static_cast<bool>(file.read(reinterpret_cast<char*>(bytes.data()), bytes.size())),
     "cannot read release file");
  return bytes;
}
void Write(const fs::path& path, std::span<const uint8_t> bytes) {
  std::ofstream file(path, std::ios::binary | std::ios::trunc);
  Io(static_cast<bool>(file.write(reinterpret_cast<const char*>(bytes.data()), bytes.size())),
     "cannot write release file");
  file.close();
  Io(!file.fail(), "cannot close release file");
}
void WriteText(const fs::path& path, const std::string& text) {
  Write(path, {reinterpret_cast<const uint8_t*>(text.data()), text.size()});
}
Json ParseJson(std::string_view text) {
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
void Keys(const Json& json,
          std::initializer_list<std::string_view> required,
          std::initializer_list<std::string_view> optional) {
  Require(json.is_object(), "expected JSON object");
  for (auto key : required)
    Require(json.contains(key), "missing JSON field");
  for (auto it = json.begin(); it != json.end(); ++it)
    Require(std::find(required.begin(), required.end(), it.key()) != required.end() ||
                std::find(optional.begin(), optional.end(), it.key()) != optional.end(),
            "unknown JSON field");
}
uint64_t Unsigned(const Json& json) {
  Require(json.is_number_unsigned(), "expected unsigned integer");
  return json.get<uint64_t>();
}
std::string HexString(const Json& json) {
  Require(json.is_string() && cluster::ValidBuildId(json.get_ref<const std::string&>()),
          "expected lowercase 64 hex digits");
  return json.get<std::string>();
}
Key Unhex(const std::string& hex) {
  Require(cluster::ValidBuildId(hex), "invalid hex key");
  auto digit = [](char c) { return c <= '9' ? c - '0' : c - 'a' + 10; };
  Key out;
  for (size_t i = 0; i < out.size(); ++i)
    out[i] = static_cast<uint8_t>(digit(hex[i * 2]) * 16 + digit(hex[i * 2 + 1]));
  return out;
}
std::string HashFile(const fs::path& path) {
  return cluster::Hex(Take(cluster::Sha256File(path)));
}
void AtomicText(const fs::path& path, const std::string& text) {
  auto temporary = fs::path(path.wstring() + L".tmp");
  WriteText(temporary, text);
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
Mapping::Mapping(const fs::path& path, std::optional<uint64_t> output_size) {
  file_.value = CreateFileW(path.c_str(), output_size ? GENERIC_READ | GENERIC_WRITE : GENERIC_READ,
                            FILE_SHARE_READ, nullptr, output_size ? CREATE_ALWAYS : OPEN_EXISTING,
                            FILE_ATTRIBUTE_NORMAL, nullptr);
  Io(file_.value != INVALID_HANDLE_VALUE, "cannot open mapped payload");
  LARGE_INTEGER length{};
  if (output_size) {
    Require(*output_size <= INT64_MAX, "payload too large");
    length.QuadPart = static_cast<int64_t>(*output_size);
    Io(SetFilePointerEx(file_.value, length, nullptr, FILE_BEGIN) && SetEndOfFile(file_.value),
       "cannot size mapped payload");
  } else {
    Io(GetFileSizeEx(file_.value, &length), "cannot size payload");
  }
  size_ = static_cast<size_t>(length.QuadPart);
  if (!size_)
    return;
  mapping_.value = CreateFileMappingW(file_.value, nullptr,
                                      output_size ? PAGE_READWRITE : PAGE_READONLY, 0, 0, nullptr);
  Io(mapping_.value != nullptr, "cannot map payload");
  data_ = static_cast<uint8_t*>(
      MapViewOfFile(mapping_.value, output_size ? FILE_MAP_WRITE : FILE_MAP_READ, 0, 0, 0));
  Io(data_ != nullptr, "cannot view mapped payload");
}
Mapping::~Mapping() {
  if (data_)
    UnmapViewOfFile(data_);
}
}  // namespace remotekit::release
