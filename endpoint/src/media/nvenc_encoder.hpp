#pragma once
#include "hardware_encoder.hpp"
#include <nvEncodeAPI.h>
#include <chrono>
#include <functional>

namespace remotekit::media {
// CPU-only seam: construct an already accepted task, then exercise the same
// Poll/Drain/close code used by the driver-backed encoder. No GPU is created.
struct NvencTestHooks {
  enum class Stage { kAcceptedTask, kInitializeEvents };
  std::function<std::chrono::steady_clock::time_point()> now;
  std::function<DWORD(HANDLE, DWORD)> wait;
  Stage stage = Stage::kAcceptedTask;
};
std::unique_ptr<HardwareEncoder> CreateNvencEncoderForTest(const NV_ENCODE_API_FUNCTION_LIST&,
                                                           void* session,
                                                           HANDLE completion,
                                                           NV_ENC_OUTPUT_PTR output,
                                                           NV_ENC_INPUT_PTR input,
                                                           uint64_t cookie,
                                                           NvencTestHooks);
struct NvencQuarantineInfo {
  size_t sessions;
  bool unavailable;
};
NvencQuarantineInfo GetNvencQuarantineInfo();
}  // namespace remotekit::media
