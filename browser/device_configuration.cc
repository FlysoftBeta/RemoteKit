#include "browser/device_configuration.h"
#include "components/embedder_support/user_agent_utils.h"
#include "components/version_info/version_info.h"
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
  explicit SiteIdentity(content::WebContents* contents) : WebContentsObserver(contents) {}
  void Apply(const GURL& url) {
    auto* context = static_cast<BrowserContext*>(web_contents()->GetBrowserContext());
    blink::UserAgentOverride ua;
    ua.ua_string_override = ChromeUserAgent();
    auto metadata = ChromeUserAgentMetadata();
    if (context->TabletUaFor(url)) {
      ua.ua_string_override = embedder_support::BuildUserAgentFromOSAndProduct(
          "Linux; Android 10; K", "Chrome/" + version_info::GetMajorVersionNumber() + ".0.0.0");
      metadata.platform = "Android";
      metadata.platform_version = "13.0.0";
      metadata.architecture = "arm";
      metadata.bitness = "64";
      metadata.model.clear();
      metadata.mobile = false;
      metadata.wow64 = false;
      metadata.form_factors = {"Tablet"};
    }
    ua.ua_metadata_override = std::move(metadata);
    // Redirects already have an active request. SetUserAgentOverride would
    // restart it; update the public renderer preferences before Chromium
    // recomputes the redirected request's UA and CH instead.
    web_contents()->GetMutableRendererPrefs()->user_agent_override = std::move(ua);
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
    owner_.offscreen_host()->SetViewport(gfx::Size(width, height));
  if (!owner_.contents() || !changed)
    return;
  owner_.contents()->OnWebPreferencesChanged();
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
  auto* host = static_cast<content::RenderFrameHostImpl*>(frame)->GetRenderWidgetHost();
  ApplyBackingScale(host->GetView());
  auto& widget = host->GetAssociatedFrameWidget();
  if (!widget)
    return;
  blink::DeviceEmulationParams params;
  params.screen_type = blink::mojom::EmulatedScreenType::kDesktop;
  params.screen_size = gfx::Size(viewport_width_, viewport_height_);
  params.view_size = params.screen_size;
  params.device_scale_factor = device_scale_;
  params.screen_orientation_type = viewport_width_ > viewport_height_
                                       ? display::mojom::ScreenOrientation::kLandscapePrimary
                                       : display::mojom::ScreenOrientation::kPortraitPrimary;
  params.screen_orientation_angle = viewport_width_ > viewport_height_ ? 90 : 0;
  widget->EnableDeviceEmulation(params, blink::mojom::DeviceEmulationCacheBehavior::kKeepCache);
}
}  // namespace remotekit::browser
