#pragma once
#include "remotekit_sdk.h"
#include "util/error.hpp"
#include "remotekit_rtc.h"
#include <windows.h>
#include <filesystem>
#include <stdexcept>
namespace remotekit::media {
inline ErrorCode SdkErrorCode(int status) {
  switch (status) {
    case REMOTEKIT_SDK_INVALID_ARGUMENT:
      return ErrorCode::kInternal;
    case REMOTEKIT_SDK_INVALID_STATE:
    case REMOTEKIT_SDK_MOJO_ERROR:
    case REMOTEKIT_SDK_CHANNEL_CLOSED:
      return ErrorCode::kUnavailable;
    case REMOTEKIT_SDK_DATA_MISMATCH:
    case REMOTEKIT_SDK_TIMEOUT:
    case REMOTEKIT_SDK_LOST:
    case REMOTEKIT_SDK_BUFFER_TOO_SMALL:
      return ErrorCode::kOutcomeUnknown;
    case REMOTEKIT_SDK_BUSY:
      return ErrorCode::kBusy;
    default:
      return ErrorCode::kInternal;
  }
}
inline Error SdkFailure(int status, const remotekit_sdk_failure& failure) {
  if (status != REMOTEKIT_SDK_REFUSED)
    return {SdkErrorCode(status), "Browser SDK status " + std::to_string(status)};
  auto code = ParseErrorCode(failure.code);
  return {code.value_or(ErrorCode::kOutcomeUnknown), failure.message,
          ParseErrorReason(failure.reason),
          failure.has_retry_after ? std::optional<uint32_t>(failure.retry_after_ms) : std::nullopt};
}
struct Sdk {
  HMODULE module = nullptr;
  int (*encoder_drop)(uint64_t, uint32_t) = nullptr;
  int (*request_stats)(uint64_t) = nullptr;
  decltype(&remotekit_rtc_sample_clock) sample_clock = nullptr;
#define RK_SDK_FUNCTION(name) decltype(&name) name = nullptr;
  RK_SDK_FUNCTION(remotekit_sdk_abi_version)
  RK_SDK_FUNCTION(remotekit_sdk_initialize)
  RK_SDK_FUNCTION(remotekit_sdk_shutdown)
  RK_SDK_FUNCTION(remotekit_sdk_control_connect)
  RK_SDK_FUNCTION(remotekit_sdk_control_close)
  RK_SDK_FUNCTION(remotekit_sdk_control_request)
  RK_SDK_FUNCTION(remotekit_sdk_control_open_render)
  RK_SDK_FUNCTION(remotekit_sdk_render_connect)
  RK_SDK_FUNCTION(remotekit_sdk_render_begin)
  RK_SDK_FUNCTION(remotekit_sdk_render_close)
  RK_SDK_FUNCTION(remotekit_sdk_render_observe_signal)
  RK_SDK_FUNCTION(remotekit_sdk_render_stop)
  RK_SDK_FUNCTION(remotekit_rtc_set_source_max_fps)
  RK_SDK_FUNCTION(remotekit_rtc_adapt_frame)
  RK_SDK_FUNCTION(remotekit_rtc_get_receive_level)
  RK_SDK_FUNCTION(remotekit_rtc_set_playout_delay)
  RK_SDK_FUNCTION(remotekit_rtc_create)
  RK_SDK_FUNCTION(remotekit_rtc_close)
  RK_SDK_FUNCTION(remotekit_rtc_set_av_sync)
  RK_SDK_FUNCTION(remotekit_rtc_set_audio_enabled)
  RK_SDK_FUNCTION(remotekit_rtc_set_media_authorized)
  RK_SDK_FUNCTION(remotekit_rtc_set_degradation_preference)
  RK_SDK_FUNCTION(remotekit_rtc_set_remote_description)
  RK_SDK_FUNCTION(remotekit_rtc_add_ice)
  RK_SDK_FUNCTION(remotekit_rtc_send_data)
  RK_SDK_FUNCTION(remotekit_rtc_send_auth_data)
  RK_SDK_FUNCTION(remotekit_rtc_submit_texture)
  RK_SDK_FUNCTION(remotekit_rtc_submit_audio)
  RK_SDK_FUNCTION(remotekit_rtc_encoded)
#undef RK_SDK_FUNCTION
  Result<void> Open(const std::filesystem::path& path) {
    module = LoadLibraryExW(path.c_str(), nullptr,
                            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
    if (!module)
      return Error{ErrorCode::kUnavailable, "Cannot load SDK runtime beside browser: Windows " +
                                                std::to_string(GetLastError())};
#define RK_LOAD(name)                                                     \
  name = reinterpret_cast<decltype(name)>(GetProcAddress(module, #name)); \
  if (!name)                                                              \
    return Error{ErrorCode::kUnavailable, "SDK missing " #name};
    RK_LOAD(remotekit_sdk_abi_version)
    if (remotekit_sdk_abi_version() != REMOTEKIT_SDK_ABI_VERSION)
      return Error{ErrorCode::kUnavailable, "Browser SDK ABI version mismatch"};
    RK_LOAD(remotekit_sdk_initialize)
    RK_LOAD(remotekit_sdk_shutdown)
    RK_LOAD(remotekit_sdk_control_connect)
    RK_LOAD(remotekit_sdk_control_close)
    RK_LOAD(remotekit_sdk_control_request)
    RK_LOAD(remotekit_sdk_control_open_render)
    RK_LOAD(remotekit_rtc_set_av_sync)
    RK_LOAD(remotekit_rtc_set_audio_enabled)
    RK_LOAD(remotekit_rtc_create)
    RK_LOAD(remotekit_rtc_close)
    RK_LOAD(remotekit_rtc_set_media_authorized)
    RK_LOAD(remotekit_rtc_set_remote_description)
    RK_LOAD(remotekit_rtc_add_ice)
    RK_LOAD(remotekit_rtc_send_data)
    RK_LOAD(remotekit_rtc_send_auth_data) RK_LOAD(remotekit_rtc_get_receive_level)
        RK_LOAD(remotekit_sdk_render_connect) RK_LOAD(remotekit_sdk_render_begin)
            RK_LOAD(remotekit_sdk_render_close) RK_LOAD(remotekit_sdk_render_observe_signal)
                RK_LOAD(remotekit_sdk_render_stop) RK_LOAD(remotekit_rtc_set_source_max_fps)
                    RK_LOAD(remotekit_rtc_adapt_frame)
                        RK_LOAD(remotekit_rtc_set_degradation_preference)
                            RK_LOAD(remotekit_rtc_set_playout_delay)
                                RK_LOAD(remotekit_rtc_submit_texture) RK_LOAD(remotekit_rtc_encoded)
                                    RK_LOAD(remotekit_rtc_submit_audio)
#undef RK_LOAD
                                        sample_clock = reinterpret_cast<decltype(sample_clock)>(
                                            GetProcAddress(module, "remotekit_rtc_sample_clock"));
    request_stats = reinterpret_cast<decltype(request_stats)>(
        GetProcAddress(module, "remotekit_rtc_request_stats"));
    encoder_drop = reinterpret_cast<decltype(encoder_drop)>(
        GetProcAddress(module, "remotekit_rtc_encoder_drop"));
    if (remotekit_sdk_initialize() != 0)
      return Error{ErrorCode::kUnavailable, "SDK initialization failed"};
    return {};
  }
  ~Sdk() {
    if (module) {
      if (remotekit_sdk_shutdown)
        remotekit_sdk_shutdown();
      FreeLibrary(module);
    }
  }
};
}  // namespace remotekit::media
