#include "archive.hpp"
#include <fstream>
#include <iostream>
int wmain(int argc, wchar_t** argv) {
  if (argc != 4)
    return 2;
  remotekit::Result<void> result;
  if (std::wstring_view(argv[1]) == L"zstd")
    result = remotekit::updater::ExtractArchive(argv[2], argv[3]);
  else {
    std::ifstream file(argv[2], std::ios::binary);
    result = remotekit::updater::ExtractTar(
        [&](std::span<uint8_t> bytes) {
          file.read(reinterpret_cast<char*>(bytes.data()), bytes.size());
          return static_cast<size_t>(file.gcount());
        },
        argv[3]);
  }
  if (!result) {
    std::cerr << result.error().message << '\n';
    return 1;
  }
  return 0;
}
