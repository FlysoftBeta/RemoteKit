#include "browser/services_browser.h"

#include "base/base_paths.h"
#include "base/functional/callback.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "browser/browser_context.h"
#include "browser/page_requests.h"
#include "content/public/browser/authenticator_request_client_delegate.h"
#include "content/public/browser/client_certificate_delegate.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_view_host.h"
#include "content/public/browser/render_widget_host.h"
#include "content/public/browser/screen_orientation_delegate.h"
#include "content/public/browser/site_instance.h"
#include "content/public/browser/speech_recognition_manager_delegate.h"
#include "content/public/browser/web_authentication_delegate.h"
#include "content/public/browser/web_contents.h"
#include "net/ssl/client_cert_store.h"
#include "net/ssl/ssl_cert_request_info.h"
#include "net/ssl/ssl_private_key.h"
#include "services/device/public/cpp/geolocation/location_provider.h"
#include "ui/display/screen_info.h"

namespace remotekit::browser {
namespace {
class EmptyCertificateStore final : public net::ClientCertStore {
 public:
  void GetClientCerts(scoped_refptr<const net::SSLCertRequestInfo>,
                      ClientCertListCallback callback) override {
    std::move(callback).Run({});
  }
};

class EmptyLocationProvider final : public device::LocationProvider {
 public:
  EmptyLocationProvider()
      : result_(device::mojom::GeopositionResult::NewError(device::mojom::GeopositionError::New(
            device::mojom::GeopositionErrorCode::kPositionUnavailable,
            "Position unavailable",
            ""))) {}
  void FillDiagnostics(device::mojom::GeolocationDiagnostics&) override {}
  void SetUpdateCallback(const LocationProviderUpdateCallback& callback) override {
    callback_ = callback;
  }
  void StartProvider(bool) override {
    running_ = true;
    Report();
  }
  void StopProvider() override { running_ = false; }
  const device::mojom::GeopositionResult* GetPosition() override { return result_.get(); }
  void OnPermissionGranted() override {
    permitted_ = true;
    Report();
  }

 private:
  void Report() {
    if (running_ && permitted_ && callback_)
      callback_.Run(this, result_.Clone());
  }
  LocationProviderUpdateCallback callback_;
  device::mojom::GeopositionResultPtr result_;
  bool running_ = false;
  bool permitted_ = false;
};

class EmptyAuthenticationDelegate final : public content::WebAuthenticationDelegate {
 public:
  bool SupportsResidentKeys(content::RenderFrameHost*) override { return true; }
  void IsUserVerifyingPlatformAuthenticatorAvailableOverride(
      content::RenderFrameHost*,
      base::OnceCallback<void(std::optional<bool>)> callback) override {
    std::move(callback).Run(false);
  }
};

class EmptySpeechDelegate final : public content::SpeechRecognitionManagerDelegate {
 public:
  void CheckRecognitionIsAllowed(int, base::OnceCallback<void(bool, bool)> callback) override {
    std::move(callback).Run(false, false);
  }
  content::SpeechRecognitionEventListener* GetEventListener() override { return nullptr; }
  void BindSpeechRecognitionContext(mojo::PendingReceiver<media::mojom::SpeechRecognitionContext>,
                                    const std::string&,
                                    const content::GlobalRenderFrameHostId&) override {}
};

class ServiceOrientationDelegate final : public content::ScreenOrientationDelegate {
 public:
  bool FullScreenRequired(content::WebContents*) override { return true; }
  bool ScreenOrientationProviderSupported(content::WebContents* contents) override {
    const auto& metadata = contents->GetUserAgentOverride().ua_metadata_override;
    return metadata && metadata->platform == "Android";
  }
  bool IsOrientationLockAllowed(content::WebContents* contents,
                                device::mojom::ScreenOrientationLockType lock) override {
    using Lock = device::mojom::ScreenOrientationLockType;
    using Orientation = display::mojom::ScreenOrientation;
    const auto orientation = contents->GetPrimaryMainFrame()
                                 ->GetRenderViewHost()
                                 ->GetWidget()
                                 ->GetScreenInfo()
                                 .orientation_type;
    switch (lock) {
      case Lock::ANY:
        return true;
      case Lock::PORTRAIT:
        return orientation == Orientation::kPortraitPrimary ||
               orientation == Orientation::kPortraitSecondary;
      case Lock::LANDSCAPE:
        return orientation == Orientation::kLandscapePrimary ||
               orientation == Orientation::kLandscapeSecondary;
      case Lock::PORTRAIT_PRIMARY:
        return orientation == Orientation::kPortraitPrimary;
      case Lock::PORTRAIT_SECONDARY:
        return orientation == Orientation::kPortraitSecondary;
      case Lock::LANDSCAPE_PRIMARY:
        return orientation == Orientation::kLandscapePrimary;
      case Lock::LANDSCAPE_SECONDARY:
        return orientation == Orientation::kLandscapeSecondary;
      default:
        return false;
    }
  }
  void Lock(content::WebContents*, device::mojom::ScreenOrientationLockType) override {}
  void Unlock(content::WebContents*) override {}
};
}  // namespace

content::WebAuthenticationDelegate* ServicesBrowserClient::GetWebAuthenticationDelegate() {
  static base::NoDestructor<EmptyAuthenticationDelegate> delegate;
  return delegate.get();
}
std::unique_ptr<content::AuthenticatorRequestClientDelegate>
ServicesBrowserClient::GetWebAuthenticationRequestDelegate(content::RenderFrameHost*) {
  return std::make_unique<content::AuthenticatorRequestClientDelegate>();
}
std::unique_ptr<device::LocationProvider> ServicesBrowserClient::OverrideSystemLocationProvider() {
  return std::make_unique<EmptyLocationProvider>();
}
content::SpeechRecognitionManagerDelegate*
ServicesBrowserClient::CreateSpeechRecognitionManagerDelegate() {
  return new EmptySpeechDelegate();
}
std::unique_ptr<net::ClientCertStore> ServicesBrowserClient::CreateClientCertStore(
    content::BrowserContext*) {
  return std::make_unique<EmptyCertificateStore>();
}
base::OnceClosure ServicesBrowserClient::SelectClientCertificate(
    content::BrowserContext*,
    int,
    content::WebContents*,
    net::SSLCertRequestInfo*,
    net::ClientCertIdentityList,
    std::unique_ptr<content::ClientCertificateDelegate> delegate) {
  delegate->ContinueWithCertificate(nullptr, nullptr);
  return {};
}
void ServicesBrowserClient::GetMediaDeviceIDSalt(
    content::RenderFrameHost* frame,
    const net::SiteForCookies&,
    const blink::StorageKey&,
    base::OnceCallback<void(bool, const std::string&)> callback) {
  auto* context = static_cast<BrowserContext*>(frame->GetBrowserContext());
  std::move(callback).Run(true, context->media_device_salt());
}
void ServicesBrowserClient::GetHyphenationDictionary(
    base::OnceCallback<void(const base::FilePath&)> callback) {
  base::FilePath assets;
  CHECK(base::PathService::Get(base::DIR_ASSETS, &assets));
  std::move(callback).Run(assets.AppendASCII("hyphen-data"));
}
void ServicesBrowserClient::OpenURL(content::SiteInstance* instance,
                                    const content::OpenURLParams& params,
                                    base::OnceCallback<void(content::WebContents*)> callback) {
  auto open = params;
  // Content has already consumed the service worker's window-interaction token.
  if (open.is_service_worker_open_window)
    open.user_gesture = true;
  std::move(callback).Run(PageRequests::OpenURLFromBrowser(instance->GetBrowserContext(), open));
}
void InstallServiceOrientationDelegate() {
  static base::NoDestructor<ServiceOrientationDelegate> delegate;
  content::WebContents::SetScreenOrientationDelegate(delegate.get());
}
}  // namespace remotekit::browser
