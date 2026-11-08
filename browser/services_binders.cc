#include "browser/services_browser.h"

#include <set>
#include "third_party/blink/public/mojom/payments/secure_payment_confirmation_service.mojom.h"
#include "third_party/blink/public/mojom/webauthn/authenticator.mojom.h"
#include "third_party/blink/public/mojom/installedapp/installed_app_provider.mojom.h"
#include "third_party/blink/public/mojom/installedapp/related_application.mojom.h"
#include "third_party/blink/public/mojom/prerender/prerender.mojom.h"
#include "third_party/blink/public/mojom/persistent_renderer_prefs.mojom.h"
#include "base/types/expected.h"
#include "media/mojo/mojom/speech_recognizer.mojom.h"
#include "third_party/blink/public/mojom/subapps/sub_apps_service.mojom.h"
#include "third_party/blink/public/mojom/web_install/web_install.mojom.h"

#include "base/functional/bind.h"
#include "components/payments/core/error_message_util.h"
#include "content/public/browser/service_worker_version_base_info.h"
#include "mojo/public/cpp/bindings/binder_map.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "mojo/public/cpp/bindings/self_owned_receiver.h"
#include "third_party/blink/public/mojom/badging/badging.mojom.h"
#include "third_party/blink/public/mojom/credentialmanagement/credential_manager.mojom.h"
#include "third_party/blink/public/mojom/payments/payment_request.mojom.h"
#include "third_party/blink/public/mojom/webshare/webshare.mojom.h"

namespace remotekit::browser {
namespace {
class InstalledAppProvider final : public blink::mojom::InstalledAppProvider {
 public:
  void FilterInstalledApps(std::vector<blink::mojom::RelatedApplicationPtr>,
                           const GURL&,
                           bool,
                           FilterInstalledAppsCallback callback) override {
    std::move(callback).Run({});
  }
};
class PrefetchService final : public blink::mojom::NoStatePrefetchProcessor {
 public:
  void Start(blink::mojom::PrerenderAttributesPtr) override {}
  void Cancel() override {}
};
class RendererPrefsService final : public blink::mojom::PersistentRendererPrefsService {
 public:
  void SetViewSourceLineWrapping(bool) override {}
};
class BadgeService final : public blink::mojom::BadgeService {
 public:
  void SetBadge(blink::mojom::BadgeValuePtr) override {}
  void ClearBadge() override {}
};

class CredentialManager final : public blink::mojom::CredentialManager {
 public:
  void Store(const password_manager::CredentialInfo&, StoreCallback callback) override {
    std::move(callback).Run();
  }
  void PreventSilentAccess(PreventSilentAccessCallback callback) override {
    std::move(callback).Run();
  }
  void Get(password_manager::CredentialMediationRequirement,
           bool,
           const std::vector<GURL>&,
           GetCallback callback) override {
    std::move(callback).Run(password_manager::CredentialManagerError::SUCCESS,
                            password_manager::CredentialInfo());
  }
};

class SecurePaymentService final : public payments::mojom::SecurePaymentConfirmationService {
 public:
  void SecurePaymentConfirmationAvailability(
      SecurePaymentConfirmationAvailabilityCallback callback) override {
    std::move(callback).Run(payments::mojom::SecurePaymentConfirmationAvailabilityEnum::
                                kUnavailableNoUserVerifyingPlatformAuthenticator);
  }
  void GetSecurePaymentConfirmationCapabilities(
      GetSecurePaymentConfirmationCapabilitiesCallback callback) override {
    std::vector<payments::mojom::SecurePaymentConfirmationCapabilityPtr> capabilities;
    capabilities.push_back(payments::mojom::SecurePaymentConfirmationCapability::New(
        "browserBoundKeyHardware", false));
    std::move(callback).Run(std::move(capabilities));
  }
  void StorePaymentCredential(const std::vector<uint8_t>&,
                              const std::string&,
                              const std::vector<uint8_t>&,
                              StorePaymentCredentialCallback callback) override {
    std::move(callback).Run(
        payments::mojom::PaymentCredentialStorageStatus::FAILED_TO_STORE_CREDENTIAL);
  }
  void MakePaymentCredential(blink::mojom::PublicKeyCredentialCreationOptionsPtr,
                             MakePaymentCredentialCallback callback) override {
    std::move(callback).Run(blink::mojom::AuthenticatorStatus::NOT_ALLOWED_ERROR, nullptr, nullptr);
  }
};

class PaymentRequest final : public payments::mojom::PaymentRequest {
 public:
  void Init(mojo::PendingRemote<payments::mojom::PaymentRequestClient> client,
            std::vector<payments::mojom::PaymentMethodDataPtr> methods,
            payments::mojom::PaymentDetailsPtr,
            payments::mojom::PaymentOptionsPtr) override {
    if (client_.is_bound())
      return;
    client_.Bind(std::move(client));
    for (const auto& method : methods)
      methods_.insert(method->supported_method);
  }
  void Show(bool, bool) override {
    if (client_)
      client_->OnError(payments::mojom::PaymentErrorReason::NOT_SUPPORTED,
                       payments::GetNotSupportedErrorMessage(methods_));
  }
  void UpdateWith(payments::mojom::PaymentDetailsPtr) override {}
  void OnPaymentDetailsNotUpdated() override {}
  void Abort() override {
    if (client_)
      client_->OnAbort(false);
  }
  void Complete(payments::mojom::PaymentComplete) override {
    if (client_)
      client_->OnComplete();
  }
  void Retry(payments::mojom::PaymentValidationErrorsPtr) override {}
  void CanMakePayment() override {
    if (client_)
      client_->OnCanMakePayment(payments::mojom::CanMakePaymentQueryResult::CANNOT_MAKE_PAYMENT);
  }
  void HasEnrolledInstrument() override {
    if (client_)
      client_->OnHasEnrolledInstrument(
          payments::mojom::HasEnrolledInstrumentQueryResult::HAS_NO_ENROLLED_INSTRUMENT);
  }

 private:
  mojo::Remote<payments::mojom::PaymentRequestClient> client_;
  std::set<std::string> methods_;
};

class ShareService final : public blink::mojom::ShareService {
 public:
  void Share(const std::string&,
             const std::string&,
             const GURL&,
             std::vector<blink::mojom::SharedFilePtr>,
             ShareCallback callback) override {
    std::move(callback).Run(blink::mojom::ShareError::CANCELED);
  }
};

class SubAppsService final : public blink::mojom::SubAppsService {
 public:
  void Add(const std::vector<std::string>&, AddCallback callback) override {
    std::move(callback).Run(
        base::unexpected(blink::mojom::SubAppsServiceResultCode::kWrongContext));
  }
  void List(ListCallback callback) override {
    std::move(callback).Run(
        base::unexpected(blink::mojom::SubAppsServiceResultCode::kWrongContext));
  }
  void Remove(const std::vector<std::string>&, RemoveCallback callback) override {
    std::move(callback).Run(
        base::unexpected(blink::mojom::SubAppsServiceResultCode::kWrongContext));
  }
};
class OnDeviceSpeech final : public media::mojom::OnDeviceSpeechRecognition {
 public:
  void Available(const std::vector<std::string>&,
                 media::mojom::SpeechRecognitionQuality,
                 AvailableCallback callback) override {
    std::move(callback).Run(media::mojom::AvailabilityStatus::kUnavailable);
  }
  void Install(const std::vector<std::string>&,
               media::mojom::SpeechRecognitionQuality,
               InstallCallback callback) override {
    std::move(callback).Run(false);
  }
};
class WebInstallService final : public blink::mojom::WebInstallService {
 public:
  void IsInstalled(blink::mojom::ManifestInstallOptionsPtr, IsInstalledCallback callback) override {
    std::move(callback).Run(false);
  }
  void InstallFromManifest(blink::mojom::ManifestInstallOptionsPtr,
                           InstallFromManifestCallback callback) override {
    std::move(callback).Run(blink::mojom::WebInstallServiceResult::kAbortError);
  }
  void ElementInstallFromManifest(blink::mojom::ManifestInstallOptionsPtr,
                                  ElementInstallFromManifestCallback callback) override {
    std::move(callback).Run(blink::mojom::WebInstallServiceResult::kAbortError);
  }
};

template <typename Interface, typename Implementation, typename Context>
void BindEmptyService(Context, mojo::PendingReceiver<Interface> receiver) {
  mojo::MakeSelfOwnedReceiver(std::make_unique<Implementation>(), std::move(receiver));
}
}  // namespace

void ServicesBrowserClient::RegisterBrowserInterfaceBindersForFrame(
    content::RenderFrameHost*,
    mojo::BinderMapWithContext<content::RenderFrameHost*>* map) {
  map->Add<blink::mojom::InstalledAppProvider>(
      &BindEmptyService<blink::mojom::InstalledAppProvider, InstalledAppProvider,
                        content::RenderFrameHost*>);
  map->Add<blink::mojom::NoStatePrefetchProcessor>(
      &BindEmptyService<blink::mojom::NoStatePrefetchProcessor, PrefetchService,
                        content::RenderFrameHost*>);
  map->Add<blink::mojom::PersistentRendererPrefsService>(
      &BindEmptyService<blink::mojom::PersistentRendererPrefsService, RendererPrefsService,
                        content::RenderFrameHost*>);
  map->Add<blink::mojom::SubAppsService>(
      &BindEmptyService<blink::mojom::SubAppsService, SubAppsService, content::RenderFrameHost*>);
  map->Add<blink::mojom::WebInstallService>(
      &BindEmptyService<blink::mojom::WebInstallService, WebInstallService,
                        content::RenderFrameHost*>);
  map->Add<media::mojom::OnDeviceSpeechRecognition>(
      &BindEmptyService<media::mojom::OnDeviceSpeechRecognition, OnDeviceSpeech,
                        content::RenderFrameHost*>);
  map->Add<blink::mojom::BadgeService>(
      &BindEmptyService<blink::mojom::BadgeService, BadgeService, content::RenderFrameHost*>);
  map->Add<blink::mojom::CredentialManager>(
      &BindEmptyService<blink::mojom::CredentialManager, CredentialManager,
                        content::RenderFrameHost*>);
  map->Add<payments::mojom::SecurePaymentConfirmationService>(
      &BindEmptyService<payments::mojom::SecurePaymentConfirmationService, SecurePaymentService,
                        content::RenderFrameHost*>);
  map->Add<payments::mojom::PaymentRequest>(
      &BindEmptyService<payments::mojom::PaymentRequest, PaymentRequest,
                        content::RenderFrameHost*>);
  map->Add<blink::mojom::ShareService>(
      &BindEmptyService<blink::mojom::ShareService, ShareService, content::RenderFrameHost*>);
}

void ServicesBrowserClient::RegisterBrowserInterfaceBindersForServiceWorker(
    content::BrowserContext*,
    const content::ServiceWorkerVersionBaseInfo&,
    mojo::BinderMapWithContext<const content::ServiceWorkerVersionBaseInfo&>* map) {
  map->Add<blink::mojom::BadgeService>(
      &BindEmptyService<blink::mojom::BadgeService, BadgeService,
                        const content::ServiceWorkerVersionBaseInfo&>);
}
}  // namespace remotekit::browser
