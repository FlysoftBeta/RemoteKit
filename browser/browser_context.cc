#include "remotekit/browser/browser_context.h"
#include "remotekit/browser/compat.h"
#include "base/files/file_util.h"
#include "base/barrier_closure.h"
#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/run_loop.h"
#include "base/timer/timer.h"
#include "content/public/browser/storage_partition.h"
#include "mojo/public/cpp/bindings/callback_helpers.h"
#include "services/network/public/mojom/cookie_manager.mojom.h"
#include "content/public/browser/zoom_level_delegate.h"
#include "content/public/browser/web_contents.h"
#include "url/origin.h"
#include "remotekit/browser/profile_services.h"
#include "remotekit/browser/profile_network_state.h"

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
BrowserContext::BrowserContext(base::FilePath path)
    : path_(std::move(path)), client_hints_(CreateClientHintsDelegate()) {
  CHECK(base::CreateDirectory(path_));
  network_state_ = std::make_unique<ProfileNetworkState>(path_);
  permissions_ = std::make_unique<ProfilePermissions>(this);
  downloads_ = std::make_unique<ProfileDownloads>(this, path_);
  CHECK(downloads_->Bind(GetDownloadManager()));
}
BrowserContext::~BrowserContext() {
  NotifyWillBeDestroyed();
  downloads_->Shutdown();
  // Stop pages/downloads before this point. A cookie write may otherwise still
  // be in CookieMonster's delayed commit queue when the service is torn down.
  const auto count = GetLoadedStoragePartitionCount();
  if (count) {
    base::RunLoop flushed;
    auto done = base::BarrierClosure(count, flushed.QuitClosure());
    ForEachLoadedStoragePartition([&done](content::StoragePartition* partition) {
      partition->GetCookieManagerForBrowserProcess()->FlushCookieStore(
          mojo::WrapCallbackWithDropHandler(
              base::BindOnce([](base::RepeatingClosure finish) { finish.Run(); }, done),
              base::BindOnce(
                  [](base::RepeatingClosure finish) {
                    LOG(ERROR) << "Cookie flush disconnected during Profile shutdown";
                    finish.Run();
                  },
                  done)));
    });
    base::OneShotTimer timeout;
    timeout.Start(FROM_HERE, base::Seconds(5),
                  base::BindOnce(
                      [](base::OnceClosure quit) {
                        LOG(ERROR) << "Cookie flush timed out during Profile shutdown";
                        std::move(quit).Run();
                      },
                      flushed.QuitClosure()));
    flushed.Run();
  }
  ShutdownStoragePartitions();
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
