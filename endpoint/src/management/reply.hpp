#pragma once
#include "util/wire_error.hpp"

namespace remotekit {
inline constexpr size_t kReplyEnvelopeReserve = 1024;

inline Json ManagementReply(const Json& request,
                            Result<Json> result,
                            std::string_view event = {},
                            Json fields = Json::object()) {
  Json reply = {{"id", request.is_object() ? request.value("id", Json()) : Json()},
                {"ok", bool(result)}};
  if (request.is_object() && request.contains("opId"))
    reply["opId"] = request["opId"];
  if (result)
    reply["result"] = std::move(result).value();
  else
    reply["error"] = WireError(result.error(), event, std::move(fields));
  return reply;
}
}  // namespace remotekit
