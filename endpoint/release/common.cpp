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
