#pragma once
#include "browser/webview.h"

namespace remotekit::browser {
class WebViewExecution {
 public:
  using Completion = WebView::Completion;
  explicit WebViewExecution(WebView& owner);
  ~WebViewExecution();
  void CreateContents(std::unique_ptr<content::WebContents> adopted = {});
  void InstallContents();
  Status RestoreContents(NavigationState&);
  bool IsInPrimaryPage(content::NavigationHandle*) const;
  void AttachOffscreenHost();
  void DropContents();
  void SetRenderDemand(bool enabled);
  Status SetVisible(bool visible);
  base::DictValue CompositorDiagnostics() const;

 private:
  friend class WebView;
  friend class DeviceConfiguration;
  friend class NavigationCoordinator;
  friend class InputController;
  friend class TouchController;
  friend class LifecycleCoordinator;
  WebView& owner_;
  std::unique_ptr<content::WebContents> contents_;
  std::unique_ptr<OffscreenHost> offscreen_host_;
  bool render_demand_ = false;
  bool visible_{false};
};
}  // namespace remotekit::browser
