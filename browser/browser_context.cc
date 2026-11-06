#include "remotekit/browser/browser_context.h"
#include "remotekit/browser/compat.h"
#include "base/files/file_util.h"
#include "base/logging.h"
#include "content/public/browser/zoom_level_delegate.h"
#include "content/public/browser/web_contents.h"
#include "url/origin.h"
#include "remotekit/browser/profile_services.h"
#include "remotekit/browser/profile_network_state.h"
#include "remotekit/browser/profile_key.h"

namespace remotekit::browser {
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
    : path_(std::move(path)), client_hints_(CreateClientHintsDelegate()) {
  CHECK(base::CreateDirectory(path_));
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
