#pragma once
#include "release/common.hpp"
#include <cstdio>
namespace release_test {
using namespace remotekit::release;
inline void Check(bool value, const char* message) {
  if (!value)
    throw std::runtime_error(message);
}
template <class F>
void Reject(F&& operation, const char* message) {
  try {
    operation();
  } catch (const Failure&) {
    return;
  }
  throw std::runtime_error(message);
}
inline void Entry(Bytes& tar, const std::string& path, std::string_view data, char type = '0') {
  std::array<uint8_t, 512> header{};
  Check(path.size() <= 100, "fixture path too long");
  std::copy(path.begin(), path.end(), header.begin());
  auto field = [&](size_t offset, size_t width, uint64_t value) {
    char text[32];
    snprintf(text, sizeof(text), "%0*llo", static_cast<int>(width - 1),
             static_cast<unsigned long long>(value));
    std::copy_n(text, width - 1, header.begin() + offset);
  };
  field(100, 8, type == '5' ? 0755 : 0644);
  field(108, 8, 0);
  field(116, 8, 0);
  field(124, 12, data.size());
  field(136, 12, 0);
  std::fill(header.begin() + 148, header.begin() + 156, ' ');
  header[156] = type;
  std::copy_n("ustar", 5, header.begin() + 257);
  header[263] = header[264] = '0';
  uint64_t sum = 0;
  for (auto byte : header)
    sum += byte;
  field(148, 7, sum);
  header[155] = ' ';
  tar.insert(tar.end(), header.begin(), header.end());
  tar.insert(tar.end(), data.begin(), data.end());
  tar.resize((tar.size() + 511) / 512 * 512);
}
inline Bytes PayloadTar(const std::string& id) {
  Bytes tar;
  std::string build = Json{{"buildId", id}}.dump();
  for (auto path : {"build.json", "node/build.json"})
    Entry(tar, path, build);
  for (auto path :
       {"bin/node.exe", "bin/remotekit_control.exe", "bin/remotekit_node.exe",
        "control/dist/server.mjs", "node/bin/endpoint_service.exe", "node/bin/remotekit_node.exe"})
    Entry(tar, path, "fixture");
  tar.resize(tar.size() + 1024);
  return tar;
}
}  // namespace release_test
