#include "remotekit_sdk.h"

#include <array>
#include <atomic>
#include <io.h>
#include <cstdio>
#include <cstring>

namespace {
std::atomic<unsigned> records{0};
std::atomic<bool> invalid_record{false};
void LogSink(void* context, int level, const char* event, const char* fields) {
  if (context != &records || level < REMOTEKIT_SDK_LOG_DEBUG || level > REMOTEKIT_SDK_LOG_ERROR ||
      !event || !std::strchr(event, '.') || !fields || fields[0] != '{' ||
      fields[std::strlen(fields) - 1] != '}')
    invalid_record.store(true);
  records.fetch_add(1);
}

bool InitializeWithSilentStderr(bool expect_records = true) {
  FILE* capture = nullptr;
  if (tmpfile_s(&capture) != 0)
    return false;
  const int saved = _dup(_fileno(stderr));
  if (saved < 0 || _dup2(_fileno(capture), _fileno(stderr)) != 0) {
    if (saved >= 0)
      _close(saved);
    std::fclose(capture);
    return false;
  }
  const int initialized = remotekit_sdk_initialize();
  const int repeated = remotekit_sdk_initialize();
  std::fflush(stderr);
  const auto bytes = _filelengthi64(_fileno(capture));
  const int restored = _dup2(saved, _fileno(stderr));
  _close(saved);
  std::fclose(capture);
  return initialized == REMOTEKIT_SDK_OK && repeated == REMOTEKIT_SDK_OK && bytes == 0 &&
         restored == 0 && (records.load() != 0) == expect_records && !invalid_record.load();
}
}  // namespace

int main(int argc, char** argv) {
  if (argc == 2 && std::strcmp(argv[1], "--no-sink") == 0) {
    const bool success =
        InitializeWithSilentStderr(false) &&
        remotekit_sdk_set_log_sink(LogSink, &records) == REMOTEKIT_SDK_INVALID_STATE &&
        remotekit_sdk_shutdown() == REMOTEKIT_SDK_OK;
    return success ? 0 : 3;
  }
  if (remotekit_sdk_abi_version() != REMOTEKIT_SDK_ABI_VERSION ||
      remotekit_sdk_set_log_sink(nullptr, nullptr) != REMOTEKIT_SDK_INVALID_ARGUMENT ||
      remotekit_sdk_set_log_sink(LogSink, &records) != REMOTEKIT_SDK_OK ||
      remotekit_sdk_set_log_sink(LogSink, &records) != REMOTEKIT_SDK_INVALID_STATE ||
      !InitializeWithSilentStderr() ||
      remotekit_sdk_set_log_sink(LogSink, &records) != REMOTEKIT_SDK_INVALID_STATE) {
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
  std::printf("RemoteKit SDK ABI %u: Mojo binary roundtrip OK; WebRTC clock %lld\n",
              static_cast<unsigned>(REMOTEKIT_SDK_ABI_VERSION), static_cast<long long>(timestamp));
  return 0;
}
