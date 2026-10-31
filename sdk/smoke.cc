#include "remotekit_sdk.h"

#include <array>
#include <cstdio>
#include <cstring>

int main() {
  if (remotekit_sdk_abi_version() != 1 || remotekit_sdk_initialize() != REMOTEKIT_SDK_OK ||
      remotekit_sdk_initialize() != REMOTEKIT_SDK_OK) {
    std::fputs("SDK initialization failed\n", stderr);
    return 1;
  }
  const std::array<unsigned char, 8> input = {0, 1, 255, 7, 0, 13, 42, 128};
  std::array<unsigned char, 8> output{};
  size_t size = 0;
  int64_t timestamp = 0;
  bool success = remotekit_sdk_mojo_roundtrip(input.data(), input.size(), output.data(),
                                              output.size(), &size) == REMOTEKIT_SDK_OK &&
                 size == input.size() && std::memcmp(input.data(), output.data(), size) == 0 &&
                 remotekit_sdk_webrtc_time_millis(&timestamp) == REMOTEKIT_SDK_OK && timestamp > 0;
  size_t empty_size = 42;
  success = success &&
            remotekit_sdk_mojo_roundtrip(nullptr, 0, nullptr, 0, &empty_size) == REMOTEKIT_SDK_OK &&
            empty_size == 0;
  size_t rejected_size = 42;
  success =
      success &&
      remotekit_sdk_mojo_roundtrip(input.data(), input.size(), output.data(), output.size() - 1,
                                   &rejected_size) == REMOTEKIT_SDK_INVALID_ARGUMENT &&
      rejected_size == 0 &&
      remotekit_sdk_mojo_roundtrip(nullptr, 1, output.data(), output.size(), &rejected_size) ==
          REMOTEKIT_SDK_INVALID_ARGUMENT &&
      remotekit_sdk_webrtc_time_millis(nullptr) == REMOTEKIT_SDK_INVALID_ARGUMENT;
  const int shutdown = remotekit_sdk_shutdown();
  success = success && remotekit_sdk_initialize() == REMOTEKIT_SDK_INVALID_STATE &&
            remotekit_sdk_webrtc_time_millis(&timestamp) == REMOTEKIT_SDK_INVALID_STATE &&
            remotekit_sdk_shutdown() == REMOTEKIT_SDK_INVALID_STATE;
  if (!success || shutdown != REMOTEKIT_SDK_OK) {
    std::fputs("SDK Mojo/WebRTC probe failed\n", stderr);
    return 2;
  }
  std::printf("RemoteKit SDK ABI 1: Mojo binary roundtrip OK; WebRTC clock %lld\n",
              static_cast<long long>(timestamp));
  return 0;
}
