#pragma once
#include "util/error.hpp"
#include "../../../sdk/include/remotekit_sdk.h"

namespace remotekit {
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
}  // namespace remotekit
