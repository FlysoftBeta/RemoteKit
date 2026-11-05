#include "browser/view_registry.h"
namespace remotekit::browser {
ViewRecord* ViewRegistry::Find(SessionId session, WebViewId id) {
  auto found = records.find(id);
  return found != records.end() && found->second.webview->session_id() == session ? &found->second
                                                                                  : nullptr;
}
ViewRegistry::Specifications ViewRegistry::Specs() const {
  Specifications specs;
  for (const auto& [id, record] : records)
    specs.emplace(id, record.spec);
  return specs;
}
void ViewRegistry::SetSpecs(Specifications specs) {
  for (auto& [id, record] : records)
    record.spec = std::move(specs.at(id));
}
ViewRecord& ViewRegistry::Create(content::BrowserContext* context,
                                 ViewModel& model,
                                 SessionId session,
                                 WebViewId id,
                                 ViewSpec spec,
                                 std::unique_ptr<content::WebContents> adopted) {
  ViewRecord record;
  record.webview = std::make_unique<WebView>(context, &model, session, id, std::move(adopted));
  record.requests = std::make_unique<PageRequests>();
  record.requests->Bind(record.webview->contents());
  record.spec = std::move(spec);
  return records.emplace(id, std::move(record)).first->second;
}
void ViewRegistry::Recreate(ViewRecord& record,
                            content::BrowserContext* context,
                            ViewModel& model) {
  const auto session = record.webview->session_id();
  const auto id = record.webview->view_id();
  auto operations = record.webview->ReleaseNavigationOperations();
  record.requests->Bind(nullptr);
  record.webview.reset();
  model.ResetWebView(session, id);
  record.webview = std::make_unique<WebView>(context, &model, session, id);
  record.webview->RestoreNavigationOperations(std::move(operations));
  record.requests = std::make_unique<PageRequests>();
  record.requests->Bind(record.webview->contents());
}
void ViewRegistry::Remove(WebViewId id) {
  auto found = records.find(id);
  if (found == records.end())
    return;
  found->second.requests->Bind(nullptr);
  records.erase(found);
}
void ViewRegistry::Clear() {
  for (auto& [id, record] : records) {
    record.requests->SetPopupHandler({});
    record.requests->Bind(nullptr);
  }
  records.clear();
}
}  // namespace remotekit::browser
