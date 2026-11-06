#include "cluster/frames.hpp"
#include <windows.h>
#include <fstream>
#include <iostream>
int wmain(int argc, wchar_t** argv) {
  namespace fs = std::filesystem;
  using remotekit::cluster::Json;
  if (argc != 2 || !std::wstring_view(argv[1]).starts_with(L"--node-root="))
    return 1;
  fs::path root(argv[1] + 12);
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
