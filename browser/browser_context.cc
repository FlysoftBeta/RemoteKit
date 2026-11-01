#include "remotekit/browser/browser_context.h"
#include "base/files/file_util.h"
#include "content/public/browser/zoom_level_delegate.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "components/embedder_support/user_agent_utils.h"
#include "components/version_info/version_info.h"
#include "third_party/blink/public/common/renderer_preferences/renderer_preferences.h"
#include "url/origin.h"
#include "remotekit/browser/compat.h"
#include "remotekit/browser/profile_services.h"

namespace remotekit::browser {
namespace {
const char kSiteIdentityKey = 0;
class SiteIdentity final : public base::SupportsUserData::Data,
                           public content::WebContentsObserver {
 public:
  explicit SiteIdentity(content::WebContents* contents) : WebContentsObserver(contents) {}
  void Apply(const GURL& url) {
    auto* context = static_cast<BrowserContext*>(web_contents()->GetBrowserContext());
    blink::UserAgentOverride ua;
    ua.ua_string_override = ChromeUserAgent();
    auto metadata = ChromeUserAgentMetadata();
    if (context->TabletUaFor(url)) {
      ua.ua_string_override = embedder_support::BuildUserAgentFromOSAndProduct(
          "Linux; Android 10; K", "Chrome/" + version_info::GetMajorVersionNumber() + ".0.0.0");
      metadata.platform = "Android";
      metadata.platform_version = "13.0.0";
      metadata.architecture = "arm";
      metadata.bitness = "64";
      metadata.model.clear(); metadata.mobile = false; metadata.wow64 = false;
      metadata.form_factors = {"Tablet"};
    }
    ua.ua_metadata_override = std::move(metadata);
    // Redirects already have an active request. SetUserAgentOverride would
    // restart it; update the public renderer preferences before Chromium
    // recomputes the redirected request's UA and CH instead.
    web_contents()->GetMutableRendererPrefs()->user_agent_override = std::move(ua);
    web_contents()->SyncRendererPrefs();
  }
  void DidStartNavigation(content::NavigationHandle* navigation) override {
    if (!navigation->IsInPrimaryMainFrame() || navigation->IsSameDocument()) return;
    Apply(navigation->GetURL());
    // Always override, including desktop, so every redirect can choose a new
    // identity without changing the NavigationRequest's immutable UA flag.
    navigation->SetIsOverridingUserAgent(true);
  }
  void DidRedirectNavigation(content::NavigationHandle* navigation) override {
    if (navigation->IsInPrimaryMainFrame()) Apply(navigation->GetURL());
  }
};
}  // namespace
void BrowserContext::InstallSiteIdentity(content::WebContents* contents) {
  if (!contents->GetUserData(&kSiteIdentityKey))
    contents->SetUserData(&kSiteIdentityKey, std::make_unique<SiteIdentity>(contents));
}
bool BrowserContext::SetSitePreferences(const base::DictValue& sites, std::string* error) {
  if (sites.size() > 4096) { *error = "site_preference_limit"; return false; }
  std::map<std::string, bool> next;
  for (const auto [key, value] : sites) {
    const GURL url(key);
    if (!url.SchemeIsHTTPOrHTTPS() || url::Origin::Create(url).Serialize() != key ||
        !value.is_dict() || !value.GetDict().FindBool("tabletUa")) {
      *error = "invalid_site_preference"; return false;
    }
    next[key] = *value.GetDict().FindBool("tabletUa");
  }
  site_preferences_ = std::move(next); return true;
}
bool BrowserContext::TabletUaFor(const GURL& url) const {
  const auto found = site_preferences_.find(url::Origin::Create(url).Serialize());
  return url.SchemeIsHTTPOrHTTPS() && found != site_preferences_.end() && found->second;
}
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
