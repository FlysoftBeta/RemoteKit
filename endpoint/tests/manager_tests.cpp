#include "release_fixtures.hpp"
#include "release/payload.hpp"
#include "manager/supervisor.hpp"
#include "updater/archive.hpp"
#include "updater/download.hpp"
#include <iostream>
using namespace remotekit;
using namespace remotekit::release;
using namespace release_test;
int wmain(int argc, wchar_t** argv) {
  if (argc != 2)
    return 2;
  auto root = fs::path(argv[1]) / (L"manager-files-" + std::to_wstring(GetCurrentProcessId()));
  try {
    fs::create_directories(root);
    std::string id(64, 'a');
    auto tar = PayloadTar(id);
    tar.resize(tar.size() - 1024);
    std::string long_path = "node/" + std::string(120, 'x') + "/asset.txt";
    std::string record = " path=" + long_path + "\n";
    size_t length = record.size() + 1;
    while (std::to_string(length).size() + record.size() != length)
      length = std::to_string(length).size() + record.size();
    Entry(tar, "PaxHeader", std::to_string(length) + record, 'x');
    Entry(tar, "placeholder", "raw PAX record");
    tar.resize(tar.size() + 1024);
    Write(root / L"input.tar", tar);
    auto payload_hash = HashFile(root / L"input.tar");
    Check(PayloadBuildId(root / L"input.tar") == id, "payload identity");
    auto version = InstallPayload(root, root / L"input.tar", id, PayloadSource::kMove);
    Check(HashFile(version / L"payload.tar") == payload_hash && !fs::exists(root / L"input.tar"),
          "payload base retained");
    Check(!fs::exists(version / L"node"), "node files extracted into version");
    Take(updater::ExtractArchive(version / L"release/node.tar.zst", root / L"extracted"));
    auto long_file = Read(root / L"extracted" / long_path);
    Check(std::string(long_file.begin(), long_file.end()) == "raw PAX record",
          "raw PAX node record");
    Check(Take(cluster::ReadBuildId(root / L"extracted/node")) == id,
          "node archive build identity");
    Take(updater::InstallBundled(root / L"local-node", version));
    fs::create_directories(root / L"local-node/runtime/obsolete");
    Take(updater::InstallBundled(root / L"local-node", version));
    Check(!fs::exists(root / L"local-node/runtime/obsolete"), "bundled runtime cleanup");
    auto reserved = tar;
    reserved.resize(reserved.size() - 1024);
    Entry(reserved, "release/evil", "bad");
    reserved.resize(reserved.size() + 1024);
    Write(root / L"reserved.tar", reserved);
    Reject(
        [&] { InstallPayload(root / L"reject", root / L"reserved.tar", id, PayloadSource::kCopy); },
        "reserved release path accepted");
    auto global = Bytes{};
    Entry(global, "global", "", 'g');
    global.insert(global.end(), tar.begin(), tar.end());
    Write(root / L"global.tar", global);
    Reject([&] { PayloadBuildId(root / L"global.tar"); }, "global PAX header accepted");
    Reject(
        [&] {
          InstallPayload(root / L"wrong", version / L"payload.tar", std::string(64, 'b'),
                         PayloadSource::kCopy);
        },
        "wrong build accepted");
    {
      auto lock = manager::Lock(root);
      Reject([&] { manager::Lock(root); }, "manager lock not exclusive");
    }
    AtomicText(root / L"current", id);
    Check(manager::Current(root) == id, "current version validation");
    fs::create_directories(root / L"versions/obsolete");
    fs::create_directories(root / L"work/stage-obsolete");
    fs::create_directories(root / L"work/assets/keep");
    WriteText(root / L"work/payload-obsolete.tar", "old");
    manager::Cleanup(root, id);
    Check(!fs::exists(root / L"versions/obsolete") && !fs::exists(root / L"work/stage-obsolete") &&
              !fs::exists(root / L"work/payload-obsolete.tar") &&
              fs::exists(root / L"work/assets/keep"),
          "manager cleanup");
    fs::remove_all(updater::ExtendedPath(root));
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
