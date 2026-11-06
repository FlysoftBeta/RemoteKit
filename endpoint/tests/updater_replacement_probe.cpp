#include <filesystem>
#include <fstream>
#include <string_view>
int wmain(int argc, wchar_t** argv) {
  if (argc != 3 || std::wstring_view(argv[1]) != L"run" ||
      !std::wstring_view(argv[2]).starts_with(L"--root="))
    return 1;
  std::filesystem::path root(argv[2] + 7);
  std::ofstream(root / L"replacement-started") << "run";
  return 0;
}
