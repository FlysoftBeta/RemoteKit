#include "remotekit_sdk.h"

#include <cstdio>
#include <iostream>
#include <string>
#include <vector>

int main(int argc, char** argv) {
  if (argc != 2) {
    std::fputs("usage: remotekit_control_client CHANNEL_NAME\n", stderr);
    return 1;
  }
  if (remotekit_sdk_initialize() != REMOTEKIT_SDK_OK)
    return 2;
  uint64_t handle = 0;
  int status = remotekit_sdk_control_connect(argv[1], &handle);
  if (status != REMOTEKIT_SDK_OK) {
    std::fprintf(stderr, "control_connect failed: %d\n", status);
    remotekit_sdk_shutdown();
    return 3;
  }
  constexpr size_t kLimit = 1024 * 1024;
  std::vector<char> output(kLimit);
  int exit_code = 0;
  for (;;) {
    std::string request;
    int c = 0;
    while ((c = std::cin.get()) != EOF && c != '\n') {
      if (request.size() == kLimit) {
        std::fputs("request exceeds 1 MiB\n", stderr);
        exit_code = 4;
        break;
      }
      request.push_back(static_cast<char>(c));
    }
    if (exit_code || (c == EOF && request.empty()))
      break;
    size_t size = 0;
    status = remotekit_sdk_control_request(handle, request.data(), request.size(), output.data(),
                                           output.size(), &size, 5000);
    if (status != REMOTEKIT_SDK_OK) {
      std::fprintf(stderr, "control_request failed: %d (required=%zu)\n", status, size);
      exit_code = 5;
      break;
    }
    if (std::fwrite(output.data(), 1, size, stdout) != size || std::fputc('\n', stdout) == EOF ||
        std::fflush(stdout) != 0) {
      exit_code = 6;
      break;
    }
    if (c == EOF)
      break;
  }
  if (std::cin.bad())
    exit_code = 7;
  remotekit_sdk_control_close(handle);
  if (remotekit_sdk_shutdown() != REMOTEKIT_SDK_OK)
    exit_code = 8;
  return exit_code;
}
