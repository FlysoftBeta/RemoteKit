#include "remotekit_sdk.h"

#include <cstdio>
#include <vector>

int main(int argc, char** argv) {
  if (argc != 2) {
    std::fputs("usage: remotekit_control_smoke CHANNEL_NAME\n", stderr);
    return 1;
  }
  if (remotekit_sdk_abi_version() != REMOTEKIT_SDK_ABI_VERSION)
    return 2;
  if (remotekit_sdk_initialize() != REMOTEKIT_SDK_OK)
    return 2;
  uint64_t handle = 0;
  int status = remotekit_sdk_control_connect(argv[1], &handle);
  if (status != REMOTEKIT_SDK_OK) {
    std::fprintf(stderr, "control_connect failed: %d\n", status);
    remotekit_sdk_shutdown();
    return 3;
  }
  constexpr char request[] = "{\"version\":1,\"id\":1,\"method\":\"snapshot\"}";
  std::vector<char> output(1024 * 1024);
  size_t size = 0;
  status = remotekit_sdk_control_request(handle, request, sizeof(request) - 1, output.data(),
                                         output.size(), &size, 5000);
  if (status == REMOTEKIT_SDK_OK) {
    std::fwrite(output.data(), 1, size, stdout);
    std::fputc('\n', stdout);
  } else {
    std::fprintf(stderr, "control_request failed: %d (required=%zu)\n", status, size);
  }
  remotekit_sdk_failure failure{};
  if (status == REMOTEKIT_SDK_OK) {
    status = remotekit_sdk_control_command(handle, request, sizeof(request) - 1, 5000, &failure);
    if (status == REMOTEKIT_SDK_REFUSED)
      std::fprintf(stderr, "Browser %s: %s\n", failure.code, failure.message);
  }
  remotekit_sdk_control_close(handle);
  const int stopped = remotekit_sdk_shutdown();
  return status == REMOTEKIT_SDK_OK && stopped == REMOTEKIT_SDK_OK ? 0 : 4;
}
