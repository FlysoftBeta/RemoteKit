#include "download.hpp"
#include <fstream>
#include <iostream>
using namespace remotekit;
using namespace remotekit::cluster;
using namespace remotekit::updater;
namespace {
void Check(bool value) {
  if (!value)
    throw std::runtime_error("node files/log assertion failed");
}
void Write(const fs::path& path, const Json& value) {
  std::ofstream(path) << value.dump();
}
}  // namespace
int wmain(int argc, wchar_t** argv) {
  if (argc != 2)
    return 2;
  auto root = fs::path(argv[1]) / (L"node-files-" + std::to_wstring(GetCurrentProcessId()));
  try {
    fs::create_directories(root);
    Json config = {{"control", "ws://example.test/api/node"},
                   {"key", std::string(43, 'A') + "="},
                   {"nodeId", "node-1"}};
    Write(root / L"node.json", config);
    auto files = LoadNodeFiles(root);
    Check(static_cast<bool>(files));
    Check(files.value().node_id == "node-1" && files.value().key == Key{});
    config["extra"] = true;
    Write(root / L"node.json", config);
    Check(!LoadNodeFiles(root));
    config.erase("extra");
    config["key"] = std::string(42, 'A') + "B=";
    Write(root / L"node.json", config);
    Check(!LoadNodeFiles(root));
    config["key"] = std::string(43, 'A') + "=";
    for (auto id : {"Upper", "-node", "node/name", ""}) {
      config["nodeId"] = id;
      Write(root / L"node.json", config);
      Check(!LoadNodeFiles(root));
    }
    config["nodeId"] = "node";
    config["control"] = "wss://example.test/api/node?key=secret";
    Write(root / L"node.json", config);
    Check(!LoadNodeFiles(root));
    Check(ReadBuildId(root).value() == "dev");
    Write(root / L"build.json", {{"buildId", std::string(64, 'a')}});
    Check(ReadBuildId(root).value() == std::string(64, 'a'));
    Write(root / L"build.json", {{"buildId", "dev"}});
    Check(!ReadBuildId(root));
    Write(root / L"build.json", {{"buildId", std::string(64, 'a')}, {"extra", true}});
    Check(!ReadBuildId(root));
    auto runtime = root / L"runtime" / std::string(64, 'a');
    fs::create_directories(runtime / L"bin");
    Write(runtime / L"build.json", {{"buildId", std::string(64, 'a')}});
    std::ofstream(runtime / L"bin/endpoint_service.exe") << "dummy";
    std::ofstream(root / L"current") << std::string(64, 'a') << '\n';
    Check(ReadCurrent(root) == std::string(64, 'a'));
    std::ofstream(root / L"current") << "../escape";
    Check(ReadCurrent(root).empty());
    Log log(root / L"logs/test.log");
    Bytes bytes(16 * 1024 * 1024);
    for (uint8_t marker = 0; marker < 6; ++marker) {
      std::fill(bytes.begin(), bytes.end(), marker);
      log.Write(bytes);
    }
    log.Write(Bytes{99});
    Check(fs::file_size(root / L"logs/test.log") == 1);
    for (int i = 1; i <= 4; ++i) {
      auto path = root / L"logs" / (L"test.log." + std::to_wstring(i));
      Check(fs::file_size(path) == 16 * 1024 * 1024);
      std::ifstream file(path, std::ios::binary);
      Check(file.get() == 6 - i);
    }
    Check(!fs::exists(root / L"logs/test.log.5"));
    fs::remove_all(root);
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    std::error_code ec;
    fs::remove_all(root, ec);
    return 1;
  }
}
