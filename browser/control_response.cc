#include "remotekit/browser/control_response.h"

#include "base/json/json_writer.h"

namespace remotekit::browser {
bool WriteControlResponse(
    const base::DictValue& request,
    const base::DictValue& reply,
    const base::RepeatingCallback<bool(std::string_view)>& write) {
  auto encoded = base::WriteJson(reply);
  if (!encoded)
    return false;
  if (encoded->size() > 1024 * 1024) {
    base::DictValue error;
    error.Set("version", 1);
    // HandleControl accepts integer request IDs and uses 0 for invalid IDs.
    error.Set("id", request.FindInt("id").value_or(0));
    error.Set("ok", false);
    error.Set("error", "response_too_large");
    error.Set("message", "Browser state is too large to synchronize. Close or change the affected page and retry.");
    encoded = base::WriteJson(error);
  }
  return encoded && write.Run(*encoded);
}
}  // namespace remotekit::browser
