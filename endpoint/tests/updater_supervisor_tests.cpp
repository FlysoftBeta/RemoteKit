#include "supervisor.hpp"
#include <thread>
#include <iostream>
int wmain(int argc, wchar_t** argv) {
  using namespace remotekit::updater;
  try {
    if (argc == 3 && (std::wstring_view(argv[1]) == L"--lock-exclusive" ||
                      std::wstring_view(argv[1]) == L"--lock-readable")) {
      const DWORD share = std::wstring_view(argv[1]) == L"--lock-readable" ? FILE_SHARE_READ : 0;
      Handle file(CreateFileW(argv[2], GENERIC_READ, share, nullptr, OPEN_EXISTING,
                              FILE_ATTRIBUTE_NORMAL, nullptr));
      if (file.value == INVALID_HANDLE_VALUE)
        throw std::runtime_error("cannot lock fixture file");
      std::cout << "locked" << std::endl;
      char byte;
      DWORD count = 0;
      while (ReadFile(GetStdHandle(STD_INPUT_HANDLE), &byte, 1, &count, nullptr) && count) {
      }
      return 0;
    }
    fs::path requested;
    if (argc == 2)
      requested = argv[1];
    else if (argc == 3 && std::wstring_view(argv[1]) == L"run" &&
             std::wstring_view(argv[2]).starts_with(L"--root="))
      requested = argv[2] + 7;
    else
      return 2;
    fs::path root = fs::absolute(requested);
    Handle stop(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    std::jthread watcher([&](std::stop_token token) {
      while (!token.stop_requested()) {
        if (fs::exists(root / L"test-stop")) {
          SetEvent(stop.value);
          return;
        }
        Sleep(20);
      }
    });
    int code = Supervise(root, stop.value, false);
    watcher.request_stop();
    return code;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
