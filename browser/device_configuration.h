#pragma once
#include "browser/webview.h"

namespace remotekit::browser {
class DeviceConfiguration {
 public:
  using Completion = WebView::Completion;
  explicit DeviceConfiguration(WebView& owner);
  ~DeviceConfiguration();
  static void InstallSiteIdentity(content::WebContents*);
  void ConfigureDevice(int width, int height, float scale);
  void RefreshBackingScale();
  void Reapply();
  void ApplyBackingScale(content::RenderWidgetHostViewBase* native_view);
  void ApplyDevice(content::RenderFrameHost* frame = nullptr);

 private:
  friend class WebView;
  friend class WebViewExecution;
  friend class NavigationCoordinator;
  friend class InputController;
  friend class TouchController;
  friend class LifecycleCoordinator;
  WebView& owner_;
  int viewport_width_ = 0, viewport_height_ = 0;
  float device_scale_ = 1;
  float backing_host_scale_ = 0;
  base::WeakPtr<content::RenderWidgetHostViewBase> backing_view_;
};
}  // namespace remotekit::browser
