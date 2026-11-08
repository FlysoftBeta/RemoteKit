#include "remotekit/browser/browser_context.h"
#include "browser/site_preferences.h"
#include "browser/page_requests.h"
#include "base/strings/escape.h"
#include "base/strings/string_util.h"
#include "remotekit/browser/compat.h"
#include "base/files/file_util.h"
#include "base/rand_util.h"
#include "base/strings/string_number_conversions.h"
#include "content/public/browser/background_sync_controller.h"
#include "content/public/browser/background_sync_parameters.h"
#include <cmath>
#include "content/public/browser/push_messaging_service.h"
#include "base/logging.h"
#include "content/public/browser/zoom_level_delegate.h"
#include "content/public/browser/web_contents.h"
#include "url/origin.h"
#include "remotekit/browser/profile_services.h"
#include "remotekit/browser/profile_network_state.h"
#include "remotekit/browser/profile_key.h"

namespace remotekit::browser {
namespace {
class UnavailablePush final : public content::PushMessagingService {
 public:
  void SubscribeFromDocument(const GURL&,
                             int64_t,
                             int,
                             int,
                             blink::mojom::PushSubscriptionOptionsPtr,
                             bool,
                             RegisterCallback callback) override {
    Fail(std::move(callback));
  }
  void SubscribeFromWorker(const GURL&,
                           int64_t,
                           int,
                           blink::mojom::PushSubscriptionOptionsPtr,
                           RegisterCallback callback) override {
    Fail(std::move(callback));
  }
  void GetSubscriptionInfo(const GURL&,
                           int64_t,
                           const std::string&,
                           const std::string&,
                           SubscriptionInfoCallback callback) override {
    std::move(callback).Run(false, true, GURL(), std::nullopt, {}, {});
  }
  void Unsubscribe(blink::mojom::PushUnregistrationReason,
                   const GURL&,
                   int64_t,
                   const std::string&,
                   UnregisterCallback callback) override {
    std::move(callback).Run(blink::mojom::PushUnregistrationStatus::SUCCESS_WAS_NOT_REGISTERED);
  }
  bool SupportNonVisibleMessages() override { return false; }
  void DidDeleteServiceWorkerRegistration(const GURL&, int64_t) override {}
  void DidDeleteServiceWorkerDatabase() override {}

 private:
  void Fail(RegisterCallback callback) {
    std::move(callback).Run("", GURL(), std::nullopt, {}, {},
                            blink::mojom::PushRegistrationStatus::SERVICE_ERROR);
  }
};
class ProfileBackgroundSync final : public content::BackgroundSyncController {
 public:
  base::TimeDelta GetNextEventDelay(const content::BackgroundSyncRegistration& registration,
                                    content::BackgroundSyncParameters* parameters,
                                    base::TimeDelta) override {
    if (registration.sync_type() == blink::mojom::BackgroundSyncType::PERIODIC)
      return base::TimeDelta::Max();
    if (!registration.num_attempts())
      return base::TimeDelta();
    return parameters->initial_retry_delay *
           std::pow(parameters->retry_delay_factor, registration.num_attempts() - 1);
  }
  std::unique_ptr<BackgroundSyncEventKeepAlive> CreateBackgroundSyncEventKeepAlive() override {
    return nullptr;
  }
  void NoteSuspendedPeriodicSyncOrigins(std::set<url::Origin>) override {}
  void NoteRegisteredPeriodicSyncOrigins(std::set<url::Origin>) override {}
  void AddToTrackedOrigins(const url::Origin&) override {}
  void RemoveFromTrackedOrigins(const url::Origin&) override {}
};
}  // namespace
content::BackgroundSyncController* BrowserContext::GetBackgroundSyncController() {
  return background_sync_.get();
}

content::PushMessagingService* BrowserContext::GetPushMessagingService() {
  return push_.get();
}
bool BrowserContext::SetSitePreferences(const base::DictValue& sites, std::string* error) {
  if (!ValidSitePreferences(sites)) {
    *error = "invalid_site_preference";
    return false;
  }
  site_preferences_ = sites.Clone();
  permissions_->SitePreferencesChanged();
  PageRequests::SitePreferencesChanged(this);
  return true;
}
bool BrowserContext::TabletUaFor(const GURL& url) const {
  const auto* site = site_preferences_.FindDict(url::Origin::Create(url).Serialize());
  return site && site->FindBool("tabletUa").value_or(false);
}
GURL BrowserContext::TranslateProtocolUrl(const GURL& url) const {
  for (const auto [origin, site] : site_preferences_) {
    const auto* handlers = site.GetDict().FindList("protocolHandlers");
    if (!handlers)
      continue;
    for (const auto& value : *handlers) {
      const auto& handler = value.GetDict();
      if (*handler.FindString("protocol") != url.scheme() || !*handler.FindBool("allowed"))
        continue;
      GURL::Replacements replacements;
      replacements.ClearUsername();
      replacements.ClearPassword();
      auto target = *handler.FindString("url");
      base::ReplaceFirstSubstringAfterOffset(
          &target, 0, "%s",
          base::EscapeQueryParamValue(url.ReplaceComponents(replacements).spec(), false));
      return GURL(target);
    }
  }
  return url;
}
BrowserContext::BrowserContext(base::FilePath path, std::unique_ptr<ProfileKey> key)
    : path_(std::move(path)) {
  CHECK(base::CreateDirectory(path_));
  const auto salt_file = path_.AppendASCII("MediaDeviceSalt");
  if (!base::ReadFileToString(salt_file, &media_device_salt_)) {
    const auto random = base::RandBytesAsString(32);
    media_device_salt_ = base::HexEncode(random);
    CHECK(base::WriteFile(salt_file, media_device_salt_));
  }
  CHECK_EQ(media_device_salt_.size(), 64u);
  client_hints_ = CreateClientHintsDelegate(path_);
  background_sync_ = std::make_unique<ProfileBackgroundSync>();
  push_ = std::make_unique<UnavailablePush>();
  network_state_ = std::make_unique<ProfileNetworkState>(path_, std::move(key));
  permissions_ = std::make_unique<ProfilePermissions>(this);
  downloads_ = std::make_unique<ProfileDownloads>(this, path_);
  CHECK(downloads_->Bind(GetDownloadManager()));
}
BrowserContext::~BrowserContext() {
  PrepareForShutdown();
  ShutdownStoragePartitions();
}
void BrowserContext::PrepareForShutdown() {
  if (shutdown_prepared_)
    return;
  shutdown_prepared_ = true;
  NotifyWillBeDestroyed();
  downloads_->Shutdown();
}
void BrowserContext::ConfigureNetworkContext(bool in_memory,
                                             const base::FilePath& relative_partition_path,
                                             network::mojom::NetworkContextParams* params) {
  network_state_->Configure(in_memory, relative_partition_path, params);
}
base::FilePath BrowserContext::GetPath() const {
  return path_;
}
std::unique_ptr<content::ZoomLevelDelegate> BrowserContext::CreateZoomLevelDelegate(
    const base::FilePath&) {
  return nullptr;
}
content::ClientHintsControllerDelegate* BrowserContext::GetClientHintsControllerDelegate() {
  return client_hints_.get();
}
content::DownloadManagerDelegate* BrowserContext::GetDownloadManagerDelegate() {
  return downloads_.get();
}
content::PermissionControllerDelegate* BrowserContext::GetPermissionControllerDelegate() {
  return permissions_.get();
}
base::DictValue BrowserContext::DownloadsCommand(const base::DictValue& command) {
  return downloads_->Command(command);
}
void BrowserContext::RemoveDownload(const std::string& guid,
                                    base::OnceCallback<void(base::DictValue)> callback) {
  downloads_->Remove(guid, std::move(callback));
}
void BrowserContext::AcknowledgeDownloadEvents(const base::ListValue& ids) {
  downloads_->Acknowledge(ids);
}
}  // namespace remotekit::browser
