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
}  // namespace remotekit::release
