#include "remotekit/browser/control_response.h"

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
                                       std::string_view detail,
                                       base::DictValue fields) {
  fields.Set("version", protocol::kControlVersion);
  fields.Set("id", id);
  fields.Set("ok", false);
  fields.Set("code", static_cast<int>(code));
  fields.Set("error", protocol::ErrorName(code));
  std::string text(detail.empty() ? "Control request failed" : detail);
  const bool machine_name =
      text.find('_') != std::string::npos && std::ranges::all_of(text, [](char c) {
        return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_';
      });
  if (machine_name) {
    std::replace(text.begin(), text.end(), '_', ' ');
    if (text.front() >= 'a' && text.front() <= 'z')
      text.front() -= 'a' - 'A';
  }
  fields.Set("detail", std::move(text));
  return fields;
}
base::DictValue ControlResult::Failure(int id, std::string_view detail, base::DictValue fields) {
  auto code = protocol::ErrorCode::invalid_request;
  if (detail == "view_closing" || detail.starts_with("close_output_before") ||
      detail == "output_pending" || detail == "touch_terminal_pending" ||
      detail.ends_with("_already_pending"))
    code = protocol::ErrorCode::busy;
  else if (detail.starts_with("stale_") || detail == "touch_owner_invalidated" ||
           detail.ends_with("identity_mismatch"))
    code = protocol::ErrorCode::stale_identity;
  else if (detail == "atlas_no_space" || detail.ends_with("_limit") || detail == "queue_full" ||
           detail.ends_with("_limit_reached") || detail == "atlas_resource_budget_exceeded")
    code = protocol::ErrorCode::resource_limit;
  else if (detail.ends_with("_not_found") || detail == "view_not_in_session" ||
           detail == "transfer_not_found")
    code = protocol::ErrorCode::not_found;
  else if (detail.ends_with("_missing") || detail.ends_with("manager_destroyed"))
    code = protocol::ErrorCode::internal;
  else if (detail == "unsupported_method" || detail.starts_with("unsupported_"))
    code = protocol::ErrorCode::unsupported;
  else if (detail == "output_not_open" || detail == "output_gpu_fault_sealed" ||
           detail == "popup_not_pending" || detail == "touch_terminal_unconfirmed")
    code = protocol::ErrorCode::unavailable;
  return Failure(id, code, detail, std::move(fields));
}
base::DictValue ControlResult::FromFields(int id, base::DictValue fields) {
  if (fields.FindBool("ok").value_or(!fields.contains("error")))
    return Success(id, std::move(fields));
  std::string detail;
  if (const auto* value = fields.FindString("detail"))
    detail = *value;
  else if (const auto* error = fields.FindString("error"))
    detail = *error;
  if (const auto code = fields.FindInt("code"))
    return Failure(id, static_cast<protocol::ErrorCode>(*code), detail, std::move(fields));
  return Failure(id, detail, std::move(fields));
}

bool WriteControlResponse(const base::DictValue& request,
                          const base::DictValue& reply,
                          const base::RepeatingCallback<bool(std::string_view, bool)>& write) {
  auto encoded = base::WriteJson(reply);
  if (!encoded)
    return false;
  bool original_reply = true;
  if (encoded->size() > 1024 * 1024) {
    original_reply = false;
    const auto error = ControlResult::Failure(
        request.FindInt("id").value_or(0), protocol::ErrorCode::resource_limit,
        "Browser state is too large to synchronize. Close or change the affected page and retry.");
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
