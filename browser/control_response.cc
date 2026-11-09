#include "remotekit/browser/control_response.h"
#include "browser/control_clipboard.h"

#include "base/json/json_writer.h"
#include <algorithm>

namespace remotekit::browser {
ControlResult::ControlResult(base::DictValue fields) {
  const int id = fields.FindInt("id").value_or(0);
  fields_ = FromFields(id, std::move(fields));
}
base::DictValue ControlResult::TakeFields() && {
  return std::move(fields_);
}
base::DictValue ControlResult::Success(int id, base::DictValue fields) {
  fields.Set("version", protocol::kControlVersion);
  fields.Set("id", id);
  fields.Set("ok", true);
  return fields;
}
base::DictValue ControlResult::Failure(int id,
                                       protocol::ErrorCode code,
                                       std::string_view message,
                                       base::DictValue fields,
                                       std::optional<protocol::ErrorReason> reason,
                                       std::optional<uint32_t> retry_after_ms) {
  fields.Set("version", protocol::kControlVersion);
  fields.Set("id", id);
  fields.Set("ok", false);
  base::DictValue error;
  error.Set("code", protocol::ErrorCodeName(code));
  error.Set("message", message);
  if (reason)
    error.Set("reason", protocol::ErrorReasonName(*reason));
  if (retry_after_ms && *retry_after_ms <= 86400000 &&
      (code == protocol::ErrorCode::kBusy || code == protocol::ErrorCode::kRateLimited ||
       code == protocol::ErrorCode::kUnavailable))
    error.Set("retryAfterMs", static_cast<int>(*retry_after_ms));
  fields.Set("error", std::move(error));
  return fields;
}
base::DictValue ControlResult::FromFields(int id, base::DictValue fields) {
  if (fields.FindBool("ok") != false)
    return Success(id, std::move(fields));
  const auto* error = fields.FindDict("error");
  const auto* code = error ? error->FindString("code") : nullptr;
  if (!code || !protocol::ParseErrorCode(*code) || !error->FindString("message"))
    return Failure(id, protocol::ErrorCode::kInternal, "Invalid local control result");
  fields.Set("version", protocol::kControlVersion);
  fields.Set("id", id);
  return fields;
}

bool WriteControlResponse(const base::DictValue& request,
                          const base::DictValue& reply,
                          const base::RepeatingCallback<bool(std::string_view, bool)>& write) {
  auto encoded = base::WriteJson(reply);
  if (!encoded)
    return false;
  bool original_reply = true;
  if (encoded->size() > ControlResponseJsonLimit(request)) {
    original_reply = false;
    const auto error = ControlResult::Failure(
        request.FindInt("id").value_or(0), protocol::ErrorCode::kOutcomeUnknown,
        "Browser reply exceeded the synchronization size limit", {},
        protocol::ErrorReason::kBrowserStateTooLarge);
    encoded = base::WriteJson(error);
  }
  return encoded && write.Run(*encoded, original_reply);
}
bool ShouldAttachRenderEndpoint(const base::DictValue& request,
                                const base::DictValue& reply,
                                bool original_reply) {
  const auto* method = request.FindString("method");
  const auto* token = reply.FindString("render_channel");
  return original_reply && method && *method == "output.describe" && reply.FindBool("ok") == true &&
         !reply.Find("error") && token && !token->empty();
}
}  // namespace remotekit::browser
