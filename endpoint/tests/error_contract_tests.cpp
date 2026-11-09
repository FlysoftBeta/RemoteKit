#include "util/error_policy.hpp"
#include "util/wire_error.hpp"
#include "media/sdk_loader.hpp"
#include <cstdlib>
#include <cstring>
#include <iostream>
using namespace remotekit;
#define CHECK(x)                             \
  do {                                       \
    if (!(x)) {                              \
      std::cerr << __LINE__ << ": " #x "\n"; \
      std::exit(1);                          \
    }                                        \
  } while (false)
int main() {
  using Json = nlohmann::json;
  using namespace std::chrono;
  for (auto code :
       {ErrorCode::kInvalidRequest, ErrorCode::kUnauthenticated, ErrorCode::kForbidden,
        ErrorCode::kLocked, ErrorCode::kNotFound, ErrorCode::kConflict, ErrorCode::kLimitExceeded,
        ErrorCode::kRateLimited, ErrorCode::kBusy, ErrorCode::kUnavailable, ErrorCode::kRejected,
        ErrorCode::kCanceled, ErrorCode::kOutcomeUnknown, ErrorCode::kInternal}) {
    CHECK(ParseErrorCode(ErrorCodeName(code)) == code);
    Error error{code, "Operator diagnosis", ErrorReason::kFileTooLarge, 700};
    auto wire = WireError(error);
    auto parsed = ParseWireError(wire);
    CHECK(parsed.code == code && parsed.message == error.message && parsed.reason == error.reason);
    CHECK(wire.contains("retryAfterMs") == SupportsRetryHint(code));
    CHECK(parsed.retry_after_ms == error.retry_after_ms);
    CHECK(RetryDelay(error, 0).has_value() == SupportsRetryHint(code));
  }
  CHECK(!ParseErrorCode("unsupported"));
  CHECK(!ParseErrorReason("arbitrary"));
  for (const auto& wire : {Json(), Json::object(), Json{{"code", 1}}, Json{{"code", "future"}}})
    CHECK(ParseWireError(wire).code == ErrorCode::kOutcomeUnknown);
  for (const auto& hint : {Json(-1), Json(86400001), Json(1.2), Json("1")})
    CHECK(!ParseWireError({{"code", "busy"}, {"message", "slots full"}, {"retryAfterMs", hint}})
               .retry_after_ms);
  CHECK(!Error(ErrorCode::kBusy, "", {}, 86400001).retry_after_ms);
  CHECK(RetryDelay({ErrorCode::kUnavailable, ""}, 0) == milliseconds(1000));
  CHECK(RetryDelay({ErrorCode::kUnavailable, ""}, 100) == milliseconds(300000));
  CHECK(RetryDelay({ErrorCode::kRateLimited, ""}, 100) == milliseconds(30000));
  for (unsigned attempt = 0; attempt < 20; ++attempt) {
    const auto delay = RetryDelay({ErrorCode::kBusy, ""}, attempt)->count();
    const auto base = std::min(5000u, 250u << std::min(attempt, 10u));
    CHECK(delay >= base * 8 / 10 && delay <= std::min(5000u, base * 12 / 10));
  }
  CHECK(media::SdkErrorCode(REMOTEKIT_SDK_CHANNEL_CLOSED) == ErrorCode::kUnavailable);
  CHECK(media::SdkErrorCode(REMOTEKIT_SDK_MOJO_ERROR) == ErrorCode::kUnavailable);
  CHECK(media::SdkErrorCode(REMOTEKIT_SDK_INVALID_STATE) == ErrorCode::kUnavailable);
  CHECK(media::SdkErrorCode(REMOTEKIT_SDK_INVALID_ARGUMENT) == ErrorCode::kInternal);
  CHECK(media::SdkErrorCode(REMOTEKIT_SDK_BUSY) == ErrorCode::kBusy);
  CHECK(media::SdkErrorCode(REMOTEKIT_SDK_LOST) == ErrorCode::kOutcomeUnknown);
  CHECK(media::SdkErrorCode(REMOTEKIT_SDK_DATA_MISMATCH) == ErrorCode::kOutcomeUnknown);
  remotekit_sdk_failure refusal{};
  std::strcpy(refusal.code, "rate_limited");
  std::strcpy(refusal.reason, "document_corrupt");
  std::strcpy(refusal.message, "Browser refusal");
  refusal.has_retry_after = 1;
  refusal.retry_after_ms = 900;
  const auto error = media::SdkFailure(REMOTEKIT_SDK_REFUSED, refusal);
  CHECK(error.code == ErrorCode::kRateLimited && error.retry_after_ms == 900 &&
        error.reason == ErrorReason::kDocumentCorrupt);
}
