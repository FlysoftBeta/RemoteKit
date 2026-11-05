#pragma once
#include <map>
#include <set>
#include "browser/view_model.h"
#include "base/values.h"
namespace remotekit::browser {
class ClosedViews {
 public:
  Status Acknowledge(SessionId, const std::vector<WebViewId>&);
  void Record(SessionId, WebViewId, const std::string& reason);
  std::map<WebViewId, base::DictValue> tombstones;
  std::set<WebViewId> retired;
};
}  // namespace remotekit::browser
