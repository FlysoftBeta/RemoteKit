#pragma once
#include <map>
#include <memory>
#include <string>
#include "browser/webview.h"
#include "browser/page_requests.h"
#include "protocol/page_viewport.hpp"

namespace remotekit::browser {
struct ViewSpec {
  int width = 480, height = 360;
  std::string url;
  std::string sign_in;
  bool visible = true;
  float page_dsf = 0;
  bool operator==(const ViewSpec&) const = default;
};
struct ViewRecord {
  std::unique_ptr<WebView> webview;
  std::unique_ptr<PageRequests> requests;
  ViewSpec spec;
  protocol::PageViewport viewport;
  protocol::Placement placement;
};
class ViewRegistry {
 public:
  using Specifications = std::map<WebViewId, ViewSpec>;
  std::map<WebViewId, ViewRecord> records;
  ViewRecord* Find(SessionId, WebViewId);
  Specifications Specs() const;
  void SetSpecs(Specifications);
  ViewRecord& Create(content::BrowserContext*,
                     ViewModel&,
                     SessionId,
                     WebViewId,
                     ViewSpec,
                     std::unique_ptr<content::WebContents> adopted = {});
  void Recreate(ViewRecord&, content::BrowserContext*, ViewModel&);
  void Remove(WebViewId);
  void Clear();
};
}  // namespace remotekit::browser
