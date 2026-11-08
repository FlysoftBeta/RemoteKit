#include "browser/device_configuration.h"
#include "browser/chrome_parity.h"
#include "third_party/blink/public/common/renderer_preferences/renderer_preferences.h"
#include "browser/webview_internal.h"
#include "browser/webview_execution.h"
#include "browser/webview_navigation.h"
#include "browser/webview_input.h"
#include "browser/webview_touch.h"
#include "browser/webview_lifecycle.h"

namespace remotekit::browser {
namespace {
const char kSiteIdentityKey = 0;
class SiteIdentity final : public base::SupportsUserData::Data,
                           public content::WebContentsObserver {
 public:
  explicit SiteIdentity(content::WebContents* contents) : WebContentsObserver(contents) {
    Apply(contents->GetLastCommittedURL());
  }
  void Apply(const GURL& url) {
    auto* context = static_cast<BrowserContext*>(web_contents()->GetBrowserContext());
    const bool tablet = context->TabletUaFor(url);
    auto ua = ChromeUserAgentOverride(tablet);
    // Redirects already have an active request. SetUserAgentOverride would
    // restart it; update the public renderer preferences before Chromium
    // recomputes the redirected request's UA and CH instead.
    auto& prefs = *web_contents()->GetMutableRendererPrefs();
    ApplyChromeRendererPreferences(prefs);
    prefs.user_agent_override = std::move(ua);
    prefs.navigator_platform_override = tablet ? kTabletNavigatorPlatform : "";
    OffscreenHost::UpdateIdentity(web_contents(), tablet);
    web_contents()->SyncRendererPrefs();
  }
  void DidStartNavigation(content::NavigationHandle* navigation) override {
    if (!navigation->IsInPrimaryMainFrame() || navigation->IsSameDocument())
      return;
    Apply(navigation->GetURL());
    // Always override, including desktop, so every redirect can choose a new
    // identity without changing the NavigationRequest's immutable UA flag.
    navigation->SetIsOverridingUserAgent(true);
  }
  void DidRedirectNavigation(content::NavigationHandle* navigation) override {
    if (navigation->IsInPrimaryMainFrame())
      Apply(navigation->GetURL());
  }
};
}  // namespace
void DeviceConfiguration::InstallSiteIdentity(content::WebContents* contents) {
  if (!contents->GetUserData(&kSiteIdentityKey))
    contents->SetUserData(&kSiteIdentityKey, std::make_unique<SiteIdentity>(contents));
}
DeviceConfiguration::DeviceConfiguration(WebView& owner) : owner_(owner) {}
DeviceConfiguration::~DeviceConfiguration() = default;
void DeviceConfiguration::ConfigureDevice(int width, int height, float scale) {
  const bool changed =
      viewport_width_ != width || viewport_height_ != height || device_scale_ != scale;
  viewport_width_ = width;
  viewport_height_ = height;
  device_scale_ = scale;
  if (owner_.offscreen_host())
    owner_.offscreen_host()->SetScreenConfiguration(gfx::Size(width, height), scale);
  if (!owner_.contents() || !changed)
    return;
  ApplyDevice();
}
void DeviceConfiguration::Reapply() {
  const auto width = viewport_width_;
  const auto height = viewport_height_;
  viewport_width_ = 0;
  ConfigureDevice(width, height, device_scale_);
}
void DeviceConfiguration::RefreshBackingScale() {
  ApplyBackingScale(RootView(owner_.contents()));
}
void DeviceConfiguration::ApplyBackingScale(content::RenderWidgetHostViewBase* native_view) {
  if (!native_view)
    return;
  auto* window = native_view->GetNativeView();
  const auto* host = window ? window->GetHost() : nullptr;
  const float host_scale = host ? host->device_scale_factor() : 0;
  if (backing_view_.get() == native_view && backing_host_scale_ == host_scale &&
      std::abs(native_view->GetDeviceScaleFactor() - device_scale_) < 0.0001f)
    return;
  auto* screen = display::Screen::Get();
  if (!screen)
    return;
  // Match GetNewScreenInfosForUpdate's original display selection. Never use
  // GetDeviceScaleFactor as the denominator: it already includes our override.
  const auto display = window ? screen->GetDisplayNearestView(window) : screen->GetPrimaryDisplay();
  const float native_scale = display.device_scale_factor();
  if (!std::isfinite(native_scale) || native_scale <= 0)
    return;
  const float multiplier = device_scale_ / native_scale;
  backing_view_ = native_view->GetWeakPtr();
  backing_host_scale_ = host_scale;
  if (std::abs(native_view->GetScaleOverrideForCapture() - multiplier) > 0.0001f ||
      std::abs(native_view->GetDeviceScaleFactor() - device_scale_) > 0.0001f)
    native_view->SetScaleOverrideForCapture(multiplier);
}
void DeviceConfiguration::ApplyDevice(content::RenderFrameHost* frame) {
  if (!owner_.contents() || !viewport_width_ || !viewport_height_)
    return;
  if (!frame)
    frame = owner_.contents()->GetPrimaryMainFrame();
  if (!frame || frame->GetParentOrOuterDocument())
    return;
  if (owner_.offscreen_host())
    owner_.offscreen_host()->SetScreenConfiguration(gfx::Size(viewport_width_, viewport_height_),
                                                    device_scale_);
  auto* host = static_cast<content::RenderFrameHostImpl*>(frame)->GetRenderWidgetHost();
  if (auto* view = host->GetView()) {
    ApplyBackingScale(view);
    view->UpdateScreenInfo();
  }
}
}  // namespace remotekit::browser
