#include "cluster/frames.hpp"
#include "cluster/channel.hpp"
#include "cluster/node_files.hpp"
#include <windows.h>
#include <fstream>
#include <iostream>

namespace {
int ClusterEndpoint(const std::filesystem::path& root) {
  using namespace remotekit;
  using namespace std::chrono_literals;
  auto files = cluster::LoadNodeFiles(root);
  std::string id;
  std::ifstream(root / L"current") >> id;
  auto build = cluster::ReadBuildId(root / L"runtime" / id);
  if (!files || !build)
    return 1;
  while (true) {
    DWORD available = 0;
    if (!PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr, &available, nullptr))
      return 0;
    auto connected = cluster::ConnectWebSocket(
        files.value().control, files.value().key,
        {"endpoint", files.value().node_id, build.value(), std::string(32, '1')});
    if (!connected) {
      Sleep(100);
      continue;
    }
    auto& established = connected.value();
    std::cout << "dummy cluster " << build.value() << " " << established.reply.value("type", "")
              << " " << established.reply.value("code", "") << std::endl;
    if (established.reply.value("type", "") == "node.reject")
      return established.reply.value("code", "") == "build_mismatch" ? 3 : 1;
    std::ofstream(root / L"dummy-active") << build.value();
    while (
        PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr, &available, nullptr)) {
      auto message = established.channel->Receive(100ms);
      if (!message && message.error().code != ErrorCode::kBusy)
        break;
    }
    established.channel->Close();
  }
}
}  // namespace
int wmain(int argc, wchar_t** argv) {
  namespace fs = std::filesystem;
  using remotekit::cluster::Json;
  if (argc != 2 || !std::wstring_view(argv[1]).starts_with(L"--node-root="))
    return 1;
  fs::path root(argv[1] + 12);
  if (fs::exists(root / L"dummy-cluster"))
    return ClusterEndpoint(root);
  Json sequence;
  std::ifstream(root / L"dummy.json") >> sequence;
  size_t step = 0;
  std::ifstream(root / L"dummy-step") >> step;
  {
    std::ofstream file(root / L"dummy-step");
    file << step + 1;
  }
  {
    std::ofstream file(root / L"dummy-runs.jsonl", std::ios::app);
    file << Json{{"step", step}, {"time", GetTickCount64()}}.dump() << '\n';
  }
  std::cout << "dummy endpoint step " << step << std::endl;
  if (step >= sequence.size() || sequence[step].is_null()) {
    std::array<uint8_t, 16> bytes;
    DWORD count = 0;
    while (ReadFile(GetStdHandle(STD_INPUT_HANDLE), bytes.data(), static_cast<DWORD>(bytes.size()),
                    &count, nullptr) &&
           count) {
    }
    std::ofstream(root / L"dummy-stopped") << "stdin EOF";
    return 0;
  }
  return sequence[step].get<int>();
}
