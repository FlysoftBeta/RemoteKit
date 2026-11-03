#include "remotekit/browser/control_response.h"

#include "base/json/json_writer.h"

namespace remotekit::browser {
bool WriteControlResponse(
    const base::DictValue& request,
    const base::DictValue& reply,
    const base::RepeatingCallback<bool(std::string_view, bool)>& write) {
  auto encoded = base::WriteJson(reply);
  if (!encoded)
    return false;
  bool original_reply = true;
  if (encoded->size() > 1024 * 1024) {
    original_reply = false;
    base::DictValue error;
    error.Set("version", 1);
    // HandleControl accepts integer request IDs and uses 0 for invalid IDs.
    error.Set("id", request.FindInt("id").value_or(0));
    error.Set("ok", false);
    error.Set("error", "response_too_large");
    error.Set("message", "Browser state is too large to synchronize. Close or change the affected page and retry.");
    encoded = base::WriteJson(error);
  }
  return encoded && write.Run(*encoded, original_reply);
}
bool ShouldAttachRenderEndpoint(const base::DictValue& request,
                                const base::DictValue& reply, bool original_reply) {
  const auto* method = request.FindString("method");
  const auto* token = reply.FindString("render_channel");
  return original_reply && method && *method == "output.describe" &&
      reply.FindBool("ok") == true && !reply.Find("error") && token && !token->empty();
}
}  // namespace remotekit::browser
