#pragma once

#include <optional>
#include <string_view>

namespace remotekit::protocol {
enum class ErrorCode {
  kInvalidRequest,
  kUnauthenticated,
  kForbidden,
  kLocked,
  kNotFound,
  kConflict,
  kLimitExceeded,
  kRateLimited,
  kBusy,
  kUnavailable,
  kRejected,
  kCanceled,
  kOutcomeUnknown,
  kInternal
};
constexpr std::string_view ErrorCodeName(ErrorCode value) {
  switch (value) {
    case ErrorCode::kInvalidRequest:
      return "invalid_request";
    case ErrorCode::kUnauthenticated:
      return "unauthenticated";
    case ErrorCode::kForbidden:
      return "forbidden";
    case ErrorCode::kLocked:
      return "locked";
    case ErrorCode::kNotFound:
      return "not_found";
    case ErrorCode::kConflict:
      return "conflict";
    case ErrorCode::kLimitExceeded:
      return "limit_exceeded";
    case ErrorCode::kRateLimited:
      return "rate_limited";
    case ErrorCode::kBusy:
      return "busy";
    case ErrorCode::kUnavailable:
      return "unavailable";
    case ErrorCode::kRejected:
      return "rejected";
    case ErrorCode::kCanceled:
      return "canceled";
    case ErrorCode::kOutcomeUnknown:
      return "outcome_unknown";
    case ErrorCode::kInternal:
      return "internal";
  }
  return "";
}
constexpr std::optional<ErrorCode> ParseErrorCode(std::string_view name) {
  if (name == "invalid_request")
    return ErrorCode::kInvalidRequest;
  if (name == "unauthenticated")
    return ErrorCode::kUnauthenticated;
  if (name == "forbidden")
    return ErrorCode::kForbidden;
  if (name == "locked")
    return ErrorCode::kLocked;
  if (name == "not_found")
    return ErrorCode::kNotFound;
  if (name == "conflict")
    return ErrorCode::kConflict;
  if (name == "limit_exceeded")
    return ErrorCode::kLimitExceeded;
  if (name == "rate_limited")
    return ErrorCode::kRateLimited;
  if (name == "busy")
    return ErrorCode::kBusy;
  if (name == "unavailable")
    return ErrorCode::kUnavailable;
  if (name == "rejected")
    return ErrorCode::kRejected;
  if (name == "canceled")
    return ErrorCode::kCanceled;
  if (name == "outcome_unknown")
    return ErrorCode::kOutcomeUnknown;
  if (name == "internal")
    return ErrorCode::kInternal;
  return std::nullopt;
}
enum class ErrorReason {
  kBrowserCrashed,
  kBrowserRestarting,
  kOutputFailed,
  kDocumentEncrypted,
  kDocumentCorrupt,
  kDocumentUnsupported,
  kDocumentTooComplex,
  kFileTooLarge,
  kStorageQuotaExceeded,
  kBrowserStateTooLarge,
  kNoDocumentContour,
  kCorruptState,
  kSessionDataOnOfflineNode,
  kNoEligibleNode
};
constexpr std::string_view ErrorReasonName(ErrorReason value) {
  switch (value) {
    case ErrorReason::kBrowserCrashed:
      return "browser_crashed";
    case ErrorReason::kBrowserRestarting:
      return "browser_restarting";
    case ErrorReason::kOutputFailed:
      return "output_failed";
    case ErrorReason::kDocumentEncrypted:
      return "document_encrypted";
    case ErrorReason::kDocumentCorrupt:
      return "document_corrupt";
    case ErrorReason::kDocumentUnsupported:
      return "document_unsupported";
    case ErrorReason::kDocumentTooComplex:
      return "document_too_complex";
    case ErrorReason::kFileTooLarge:
      return "file_too_large";
    case ErrorReason::kStorageQuotaExceeded:
      return "storage_quota_exceeded";
    case ErrorReason::kBrowserStateTooLarge:
      return "browser_state_too_large";
    case ErrorReason::kNoDocumentContour:
      return "no_document_contour";
    case ErrorReason::kCorruptState:
      return "corrupt_state";
    case ErrorReason::kNoEligibleNode:
      return "no_eligible_node";
    case ErrorReason::kSessionDataOnOfflineNode:
      return "session_data_on_offline_node";
  }
  return "";
}
constexpr std::optional<ErrorReason> ParseErrorReason(std::string_view name) {
  if (name == "browser_crashed")
    return ErrorReason::kBrowserCrashed;
  if (name == "browser_restarting")
    return ErrorReason::kBrowserRestarting;
  if (name == "output_failed")
    return ErrorReason::kOutputFailed;
  if (name == "document_encrypted")
    return ErrorReason::kDocumentEncrypted;
  if (name == "document_corrupt")
    return ErrorReason::kDocumentCorrupt;
  if (name == "document_unsupported")
    return ErrorReason::kDocumentUnsupported;
  if (name == "document_too_complex")
    return ErrorReason::kDocumentTooComplex;
  if (name == "file_too_large")
    return ErrorReason::kFileTooLarge;
  if (name == "storage_quota_exceeded")
    return ErrorReason::kStorageQuotaExceeded;
  if (name == "browser_state_too_large")
    return ErrorReason::kBrowserStateTooLarge;
  if (name == "no_document_contour")
    return ErrorReason::kNoDocumentContour;
  if (name == "corrupt_state")
    return ErrorReason::kCorruptState;
  if (name == "no_eligible_node")
    return ErrorReason::kNoEligibleNode;
  if (name == "session_data_on_offline_node")
    return ErrorReason::kSessionDataOnOfflineNode;
  return std::nullopt;
}
}  // namespace remotekit::protocol
