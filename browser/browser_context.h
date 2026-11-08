#pragma once
#include <map>
#include <string>
#include "base/files/file_path.h"
#include "base/values.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/client_hints_controller_delegate.h"
#include "services/network/public/mojom/network_context.mojom-forward.h"
namespace content {
class WebContents;
}

namespace remotekit::browser {
class ProfilePermissions;
class ProfileDownloads;
class ProfileNetworkState;
class ProfileKey;
class BrowserContext final : public content::BrowserContext {
 public:
  BrowserContext(base::FilePath path, std::unique_ptr<ProfileKey> key);
  ~BrowserContext() override;
  void PrepareForShutdown();
  base::FilePath GetPath() const override;
  bool IsOffTheRecord() override { return false; }
  std::unique_ptr<content::ZoomLevelDelegate> CreateZoomLevelDelegate(
      const base::FilePath&) override;
  content::ClientHintsControllerDelegate* GetClientHintsControllerDelegate() override;
  content::DownloadManagerDelegate* GetDownloadManagerDelegate() override;
  base::DictValue DownloadsCommand(const base::DictValue&);
  void RemoveDownload(const std::string& guid, base::OnceCallback<void(base::DictValue)>);
  void AcknowledgeDownloadEvents(const base::ListValue&);
  bool SetSitePreferences(const base::DictValue&, std::string* error);
  bool TabletUaFor(const GURL&) const;
  const base::DictValue& site_preferences() const { return site_preferences_; }
  GURL TranslateProtocolUrl(const GURL&) const;
  void ConfigureNetworkContext(bool in_memory,
                               const base::FilePath& relative_partition_path,
                               network::mojom::NetworkContextParams* params);
  content::BrowserPluginGuestManager* GetGuestManager() override { return nullptr; }
  storage::SpecialStoragePolicy* GetSpecialStoragePolicy() override { return nullptr; }
  content::PlatformNotificationService* GetPlatformNotificationService() override {
    return nullptr;
  }
  content::PushMessagingService* GetPushMessagingService() override;
  content::StorageNotificationService* GetStorageNotificationService() override { return nullptr; }
  content::SSLHostStateDelegate* GetSSLHostStateDelegate() override { return nullptr; }
  content::PermissionControllerDelegate* GetPermissionControllerDelegate() override;
  content::ReduceAcceptLanguageControllerDelegate* GetReduceAcceptLanguageControllerDelegate()
      override {
    return nullptr;
  }
  content::BackgroundFetchDelegate* GetBackgroundFetchDelegate() override { return nullptr; }
  content::BackgroundSyncController* GetBackgroundSyncController() override;
  content::BrowsingDataRemoverDelegate* GetBrowsingDataRemoverDelegate() override {
    return nullptr;
  }

  const std::string& media_device_salt() const { return media_device_salt_; }
  const ProfileDownloads& downloads() const { return *downloads_; }

 private:
  base::FilePath path_;
  std::string media_device_salt_;
  std::unique_ptr<content::BackgroundSyncController> background_sync_;
  std::unique_ptr<content::PushMessagingService> push_;
  bool shutdown_prepared_ = false;
  std::unique_ptr<content::ClientHintsControllerDelegate> client_hints_;
  std::unique_ptr<ProfilePermissions> permissions_;
  std::unique_ptr<ProfileDownloads> downloads_;
  std::unique_ptr<ProfileNetworkState> network_state_;
  base::DictValue site_preferences_;
};
}  // namespace remotekit::browser
