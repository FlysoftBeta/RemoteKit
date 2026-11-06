#include "supervisor.hpp"
#include <thread>
#include <iostream>
int wmain(int argc, wchar_t** argv) {
  using namespace remotekit::updater;
  if (argc != 2)
    return 2;
  try {
    fs::path root = fs::absolute(argv[1]);
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
