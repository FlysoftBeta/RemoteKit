#include "remotekit/browser/browser_context.h"
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
  if (sites.size() > 4096) {
    *error = "site_preference_limit";
    return false;
  }
  std::map<std::string, bool> next;
  for (const auto [key, value] : sites) {
    const GURL url(key);
    if (!url.SchemeIsHTTPOrHTTPS() || url::Origin::Create(url).Serialize() != key ||
        !value.is_dict() || !value.GetDict().FindBool("tabletUa")) {
      *error = "invalid_site_preference";
      return false;
    }
    next[key] = *value.GetDict().FindBool("tabletUa");
  }
  site_preferences_ = std::move(next);
  return true;
}
bool BrowserContext::TabletUaFor(const GURL& url) const {
  const auto found = site_preferences_.find(url::Origin::Create(url).Serialize());
  return url.SchemeIsHTTPOrHTTPS() && found != site_preferences_.end() && found->second;
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
base::DictValue BrowserContext::PermissionsCommand(const base::DictValue& command) {
  return permissions_->Command(command);
}
base::DictValue BrowserContext::DownloadsCommand(const base::DictValue& command) {
  return downloads_->Command(command);
}
}  // namespace remotekit::browser
