#pragma once

#include <string_view>
#include "remotekit/protocol/control.h"

#include "base/functional/callback.h"
#include "base/values.h"

namespace remotekit::browser {
class ControlResult {
 public:
  static base::DictValue Success(int id, base::DictValue fields = {});
  static base::DictValue Failure(int id,
                                 protocol::ErrorCode,
                                 std::string_view detail,
                                 base::DictValue fields = {});
  static base::DictValue Failure(int id, std::string_view detail, base::DictValue fields = {});
  static base::DictValue FromFields(int id, base::DictValue fields);
};
// Returns false only when JSON encoding or the actual transport write fails.
// Oversized application replies produce a bounded error on the same channel.
bool WriteControlResponse(
    const base::DictValue& request,
    const base::DictValue& reply,
    const base::RepeatingCallback<bool(std::string_view, bool original_reply)>& write);
// The serialized fallback never carries endpoints from the application reply.
bool ShouldAttachRenderEndpoint(const base::DictValue& request,
                                const base::DictValue& reply,
                                bool original_reply);
}  // namespace remotekit::browser
