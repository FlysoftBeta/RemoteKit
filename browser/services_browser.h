#pragma once

#include "content/public/browser/content_browser_client.h"

namespace remotekit::browser {

// Services run without access to devices attached to the server.
class ServicesBrowserClient : public content::ContentBrowserClient {
 public:
  bool AllowHostDeviceAccess() override { return false; }
  void RegisterBrowserInterfaceBindersForFrame(
      content::RenderFrameHost*,
      mojo::BinderMapWithContext<content::RenderFrameHost*>*) override;
  void RegisterBrowserInterfaceBindersForServiceWorker(
      content::BrowserContext*,
      const content::ServiceWorkerVersionBaseInfo&,
      mojo::BinderMapWithContext<const content::ServiceWorkerVersionBaseInfo&>*) override;
  content::UsbDelegate* GetUsbDelegate() override;
  content::HidDelegate* GetHidDelegate() override;
  content::SerialDelegate* GetSerialDelegate() override;
  content::BluetoothDelegate* GetBluetoothDelegate() override;
  content::WebAuthenticationDelegate* GetWebAuthenticationDelegate() override;
  std::unique_ptr<content::AuthenticatorRequestClientDelegate> GetWebAuthenticationRequestDelegate(
      content::RenderFrameHost*) override;
  std::unique_ptr<device::LocationProvider> OverrideSystemLocationProvider() override;
  content::SpeechRecognitionManagerDelegate* CreateSpeechRecognitionManagerDelegate() override;
  std::unique_ptr<net::ClientCertStore> CreateClientCertStore(content::BrowserContext*) override;
  base::OnceClosure SelectClientCertificate(
      content::BrowserContext*,
      int,
      content::WebContents*,
      net::SSLCertRequestInfo*,
      net::ClientCertIdentityList,
      std::unique_ptr<content::ClientCertificateDelegate>) override;
  void GetMediaDeviceIDSalt(content::RenderFrameHost*,
                            const net::SiteForCookies&,
                            const blink::StorageKey&,
                            base::OnceCallback<void(bool, const std::string&)>) override;
  void GetHyphenationDictionary(base::OnceCallback<void(const base::FilePath&)>) override;
  void OpenURL(content::SiteInstance*,
               const content::OpenURLParams&,
               base::OnceCallback<void(content::WebContents*)>) override;
};

void InstallServiceOrientationDelegate();

}  // namespace remotekit::browser
