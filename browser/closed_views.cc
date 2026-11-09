#include "browser/closed_views.h"
#include "base/strings/string_number_conversions.h"
namespace remotekit::browser {
Status ClosedViews::Acknowledge(SessionId session, const std::vector<WebViewId>& ids) {
  const auto owner = base::NumberToString(session);
  for (const auto view : ids) {
    const auto found = tombstones.find(view);
    if (found != tombstones.end() && *found->second.FindString("session") != owner)
      return {ErrorCode::kConflict, "Closed view belongs to another session"};
  }
  for (const auto view : ids)
    tombstones.erase(view);
  return {};
}
void ClosedViews::Record(SessionId session, WebViewId view, const std::string& reason) {
  base::DictValue value;
  value.Set("view", base::NumberToString(view));
  value.Set("session", base::NumberToString(session));
  value.Set("close_state", "closed");
  value.Set("close_reason", reason);
  tombstones.insert_or_assign(view, std::move(value));
  retired.insert(view);
}
}  // namespace remotekit::browser
