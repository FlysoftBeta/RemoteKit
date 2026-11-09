#include "browser/popup_registry.h"
#include "base/unguessable_token.h"
namespace remotekit::browser {
void PopupRegistry::Prune() {
  for (auto& [key, popup] : pending) {
    if (popup.status != "pending")
      continue;
    const bool closed = popup.requests->close_state() == "closed";
    if (!closed && base::TimeTicks::Now() < popup.deadline)
      continue;
    popup.status = closed ? "closed" : "timed_out";
    popup.requests.reset();
    popup.contents.reset();
    popup.deadline = base::TimeTicks::Now() + base::Seconds(30);
  }
  std::erase_if(pending, [](const auto& entry) {
    return entry.second.status != "pending" && base::TimeTicks::Now() >= entry.second.deadline;
  });
}
void PopupRegistry::Wire(PageRequests* requests, SessionId session, WebViewId opener) {
  requests->SetPopupHandler([this, session, opener](std::unique_ptr<content::WebContents> page,
                                                    const GURL& url,
                                                    WindowOpenDisposition disposition,
                                                    bool gesture) -> content::WebContents* {
    if (shutting_down_)
      return nullptr;
    Prune();
    if (pending.size() >= 16 || !gesture)
      return nullptr;
    const auto key = base::UnguessableToken::Create().ToString();
    PendingPopup popup{session,     opener,  url,
                       disposition, gesture, base::TimeTicks::Now() + base::Seconds(30)};
    popup.contents = std::move(page);
    popup.contents->WasHidden();
    popup.requests = std::make_unique<PageRequests>();
    popup.requests->Bind(popup.contents.get());
    auto* result = popup.contents.get();
    pending.emplace(key, std::move(popup));
    return result;
  });
}
Status PopupRegistry::CanAdopt(const std::string& key, SessionId session) const {
  const auto found = pending.find(key);
  if (found == pending.end() || found->second.session != session ||
      found->second.status != "pending")
    return {ErrorCode::kNotFound, "Popup is not pending in this session"};
  return {};
}
std::unique_ptr<content::WebContents> PopupRegistry::TakeContents(const std::string& key) {
  auto& popup = pending.at(key);
  popup.requests->Bind(nullptr);
  popup.requests.reset();
  return std::move(popup.contents);
}
void PopupRegistry::CompleteAdoption(const std::string& key, WebViewId view) {
  adopted[key] = view;
  pending.erase(key);
}
void PopupRegistry::Clear() {
  for (auto& [key, popup] : pending) {
    if (popup.requests) {
      popup.requests->SetPopupHandler({});
      popup.requests->Bind(nullptr);
      popup.requests.reset();
    }
  }
  pending.clear();
  adopted.clear();
}
}  // namespace remotekit::browser
