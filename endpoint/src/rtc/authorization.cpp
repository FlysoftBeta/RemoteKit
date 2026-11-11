#include "util/log.hpp"
#include "media/gpu_device.hpp"
#include "rtc/authorization.hpp"
#include "media/server_trace.hpp"
namespace remotekit {
using media::QpcFrequency;
using media::QpcNow;
using media::TraceIds;
int AuthorizationController::RevokeProduct() {
  {
    auto admission = LockAdmission();
    authorization_.Close();
    frame_authorization_ = 0;
    input_authorization_ = 0;
    hooks_.files_closed();
  }
  hooks_.revoked();
  const auto handle = hooks_.peer();
  const int status = handle ? sdk_.remotekit_rtc_set_media_authorized(handle, 0) : 0;
  hooks_.wake();
  return status;
}

Result<uint64_t> AuthorizationController::AuthorizationEpoch(const Json& request) {
  if (!request.contains("epoch"))
    return Error{ErrorCode::kInvalidRequest, "invalid_authorization_epoch"};
  const auto& value = request.at("epoch");
  if (!value.is_number_unsigned() || !value.get<uint64_t>() ||
      value.get<uint64_t>() > 9007199254740991ULL)
    return Error{ErrorCode::kInvalidRequest, "invalid_authorization_epoch"};
  return value.get<uint64_t>();
}

Result<void> AuthorizationController::RequireAuthPeer(const Json& request) {
  if (!hooks_.peer() || Required(request, "connectionId") != hooks_.connection())
    return Error{ErrorCode::kConflict, "stale_rtc_connection"};

  return {};
}

Result<Json> AuthorizationController::Authorize(const Json& request,
                                                uint64_t generation,
                                                const std::function<bool()>& management_current) {
  if (!request.contains("unlocked") || !request["unlocked"].is_boolean())
    return Error{ErrorCode::kInvalidRequest, "unlocked boolean required"};
  auto transition = LockTransition();
  {
    auto require_auth_peer_result = RequireAuthPeer(request);
    if (!require_auth_peer_result)
      return require_auth_peer_result.error();
  }
  if (!management_current())
    return Error{ErrorCode::kUnavailable, "management_disconnected"};
  auto authorization_epoch_result = AuthorizationEpoch(request);
  if (!authorization_epoch_result)
    return authorization_epoch_result.error();
  const auto epoch = std::move(authorization_epoch_result).value();
  const bool unlocked = request.at("unlocked").get<bool>();
  const auto decision = authorization_.Check(epoch, unlocked);
  using Decision = remotekit::ProductAuthorization::Decision;
  if (decision == Decision::reject)
    return Error{ErrorCode::kConflict, "stale_authorization_epoch"};
  if (decision == Decision::change) {
    management_generation_ = generation;
    if (RevokeProduct() != 0)
      return Error{ErrorCode::kInternal, "RTC media authorization failed"};
    if (unlocked) {
      const auto handle = hooks_.peer();
      if (sdk_.remotekit_rtc_set_media_authorized(handle, 1) != 0)
        return Error{ErrorCode::kInternal, "RTC media authorization failed"};
      {
        auto admission = LockAdmission();
        hooks_.files_opened(handle);
        audio_authorized_after_ = QpcNow();
        authorization_.Commit(epoch, true);
        authorization_.Open();
      }
      hooks_.opened(handle);
      if (!management_current()) {
        RevokeProduct();
        return Error{ErrorCode::kOutcomeUnknown, "management_disconnected"};
      }
    }
    if (!unlocked)
      authorization_.Commit(epoch, false);
    hooks_.wake();
  }
  management_generation_ = generation;
  return Json{{"applied", true}, {"epoch", epoch}};
}

void AuthorizationController::Bind() {
  auto transition = LockTransition();
  auto admission = LockAdmission();
  authorization_.Bind();
  frame_authorization_ = 0;
  input_authorization_ = 0;
  management_generation_ = 0;
}
void AuthorizationController::Close() {
  auto transition = LockTransition();
  RevokeProduct();
  management_generation_ = 0;
}
Result<void> AuthorizationController::ManagementLost(uint64_t generation) {
  auto transition = LockTransition();
  if (management_generation_ == generation && RevokeProduct() != 0)
    LogEvent(LogLevel::kError, "rtc.authorization_revoke_failed");
  return {};
}
}  // namespace remotekit
