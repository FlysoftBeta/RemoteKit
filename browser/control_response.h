#pragma once

#include <string_view>

#include "base/functional/callback.h"
#include "base/values.h"

namespace remotekit::browser {
// Returns false only when JSON encoding or the actual transport write fails.
// Oversized application replies produce a bounded error on the same channel.
bool WriteControlResponse(
    const base::DictValue& request,
    const base::DictValue& reply,
    const base::RepeatingCallback<bool(std::string_view, bool original_reply)>& write);
// The serialized fallback never carries endpoints from the application reply.
bool ShouldAttachRenderEndpoint(const base::DictValue& request,
                                const base::DictValue& reply, bool original_reply);
}  // namespace remotekit::browser
