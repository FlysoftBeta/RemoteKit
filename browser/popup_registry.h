#pragma once
#include "browser/view_registry.h"
namespace remotekit::browser {
class PopupRegistry {
 public:
  explicit PopupRegistry(const bool& shutting_down) : shutting_down_(shutting_down) {}
  struct PendingPopup {
    SessionId session;
    WebViewId opener;
    GURL url;
    WindowOpenDisposition disposition;
    bool user_gesture;
    base::TimeTicks deadline;
    std::string status = "pending";
    std::unique_ptr<content::WebContents> contents;
    std::unique_ptr<PageRequests> requests;
  };
  std::map<std::string, PendingPopup> pending;
  std::map<std::string, WebViewId> adopted;
  void Prune();
  void Wire(PageRequests*, SessionId, WebViewId);
  void Clear();
  Status CanAdopt(const std::string& key, SessionId) const;
  std::unique_ptr<content::WebContents> TakeContents(const std::string& key);
  void CompleteAdoption(const std::string& key, WebViewId);

 private:
  const bool& shutting_down_;
};
}  // namespace remotekit::browser
