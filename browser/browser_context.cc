#include "remotekit/browser/browser_context.h"
#include "base/files/file_util.h"
#include "content/public/browser/zoom_level_delegate.h"
#include "remotekit/browser/compat.h"
#include "remotekit/browser/profile_services.h"

namespace remotekit::browser {
BrowserContext::BrowserContext(base::FilePath path)
    : path_(std::move(path)), client_hints_(CreateClientHintsDelegate()) {
  CHECK(base::CreateDirectory(path_));
  permissions_ = std::make_unique<ProfilePermissions>(this);
  downloads_ = std::make_unique<ProfileDownloads>(this, path_);
  CHECK(downloads_->Bind(GetDownloadManager()));
}
BrowserContext::~BrowserContext() {
  NotifyWillBeDestroyed();
  downloads_->Shutdown();
  ShutdownStoragePartitions();
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
