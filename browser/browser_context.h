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
class BrowserContext final : public content::BrowserContext {
 public:
  explicit BrowserContext(base::FilePath path);
  ~BrowserContext() override;
  base::FilePath GetPath() const override;
  bool IsOffTheRecord() override { return false; }
  std::unique_ptr<content::ZoomLevelDelegate> CreateZoomLevelDelegate(
      const base::FilePath&) override;
  content::ClientHintsControllerDelegate* GetClientHintsControllerDelegate() override;
  content::DownloadManagerDelegate* GetDownloadManagerDelegate() override;
  base::DictValue PermissionsCommand(const base::DictValue&);
  base::DictValue DownloadsCommand(const base::DictValue&);
  bool SetSitePreferences(const base::DictValue&, std::string* error);
  bool TabletUaFor(const GURL&) const;
  void ConfigureNetworkContext(bool in_memory,
                               const base::FilePath& relative_partition_path,
                               network::mojom::NetworkContextParams* params);
  content::BrowserPluginGuestManager* GetGuestManager() override { return nullptr; }
  storage::SpecialStoragePolicy* GetSpecialStoragePolicy() override { return nullptr; }
  content::PlatformNotificationService* GetPlatformNotificationService() override {
    return nullptr;
  }
  content::PushMessagingService* GetPushMessagingService() override { return nullptr; }
  content::StorageNotificationService* GetStorageNotificationService() override { return nullptr; }
  content::SSLHostStateDelegate* GetSSLHostStateDelegate() override { return nullptr; }
  content::PermissionControllerDelegate* GetPermissionControllerDelegate() override;
  content::ReduceAcceptLanguageControllerDelegate* GetReduceAcceptLanguageControllerDelegate()
      override {
    return nullptr;
  }
  content::BackgroundFetchDelegate* GetBackgroundFetchDelegate() override { return nullptr; }
  content::BackgroundSyncController* GetBackgroundSyncController() override { return nullptr; }
  content::BrowsingDataRemoverDelegate* GetBrowsingDataRemoverDelegate() override {
    return nullptr;
  }

 private:
  base::FilePath path_;
  std::unique_ptr<content::ClientHintsControllerDelegate> client_hints_;
  std::unique_ptr<ProfilePermissions> permissions_;
  std::unique_ptr<ProfileDownloads> downloads_;
  std::unique_ptr<ProfileNetworkState> network_state_;
  std::map<std::string, bool> site_preferences_;
};
}  // namespace remotekit::browser
