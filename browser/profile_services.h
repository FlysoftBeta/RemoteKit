#ifndef REMOTEKIT_BROWSER_PROFILE_SERVICES_H_
#define REMOTEKIT_BROWSER_PROFILE_SERVICES_H_

#include <cstdint>
#include <map>
#include <string>
#include <tuple>

#include "base/files/file_path.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/values.h"
#include "content/public/browser/download_manager.h"
#include "content/public/browser/download_manager_delegate.h"
#include "content/public/browser/permission_controller_delegate.h"
#include "content/public/browser/weak_document_ptr.h"
#include "third_party/blink/public/common/permissions/permission_utils.h"

namespace remotekit::browser {

// Both services are UI-sequence-only and owned by one Session Profile. The
// BrowserContext outlives them. No process-global permission/download policy.
class ProfilePermissions final : public content::PermissionControllerDelegate {
 public:
  explicit ProfilePermissions(content::BrowserContext* context);
  ~ProfilePermissions() override;
  // action=snapshot|set|reset|reset_all; set/reset use origin,
  // embedding_origin (defaults to origin), permission; set uses allow(bool).
  base::DictValue Command(const base::DictValue&);
  void RequestPermissionsFromCurrentDocument(
      content::RenderFrameHost*,
      const content::PermissionRequestDescription&,
      base::OnceCallback<void(const std::vector<content::PermissionResult>&)>) override;
  content::PermissionStatus GetPermissionStatus(const blink::mojom::PermissionDescriptorPtr&,
                                                const GURL&,
                                                const GURL&) override;
  content::PermissionResult GetPermissionResultForOriginWithoutContext(
      const blink::mojom::PermissionDescriptorPtr&,
      const url::Origin&,
      const url::Origin&) override;
  content::PermissionResult GetPermissionResultForCurrentDocument(
      const blink::mojom::PermissionDescriptorPtr&,
      content::RenderFrameHost*,
      bool) override;
  content::PermissionResult GetPermissionResultForWorker(
      const blink::mojom::PermissionDescriptorPtr&,
      content::RenderProcessHost*,
      const GURL&) override;
  content::PermissionResult GetPermissionResultForEmbeddedRequester(
      const blink::mojom::PermissionDescriptorPtr&,
      content::RenderFrameHost*,
      const url::Origin&) override;
  void ResetPermission(blink::PermissionType, const GURL&, const GURL&) override;
  void OnPermissionStatusChangeSubscriptionAdded(
      content::PermissionController::SubscriptionId) override;
  void UnsubscribeFromPermissionResultChange(
      content::PermissionController::SubscriptionId) override;
  bool IsPermissionOverridable(blink::PermissionType,
                               base::optional_ref<const url::Origin>,
                               base::optional_ref<const url::Origin>) override;

 private:
  using Key = std::tuple<std::string, std::string, blink::PermissionType>;
  content::PermissionResult Lookup(blink::PermissionType,
                                   const url::Origin&,
                                   const url::Origin&) const;
  content::PermissionResult SubscriptionResult(content::PermissionController::SubscriptionId);
  void NotifyChanged();
  raw_ptr<content::BrowserContext> context_;
  std::map<Key, bool> policy_;
  std::map<content::PermissionController::SubscriptionId, content::WeakDocumentPtr> documents_;
  base::WeakPtrFactory<ProfilePermissions> weak_factory_{this};
};

class ProfileDownloads final : public content::DownloadManagerDelegate,
                               public content::DownloadManager::Observer,
                               public download::DownloadItem::Observer {
 public:
  ProfileDownloads(content::BrowserContext* context, const base::FilePath& profile_path);
  ~ProfileDownloads() override;
  bool Bind(content::DownloadManager* manager);
  // action=snapshot|cancel|pause|resume; mutations use id(decimal string).
  // file_reference is relative to profile_path and present only after COMPLETE.
  base::DictValue Command(const base::DictValue&);
  void Shutdown() override;
  void GetNextId(content::DownloadIdCallback) override;
  bool DetermineDownloadTarget(download::DownloadItem*, download::DownloadTargetCallback*) override;
  bool ShouldCompleteDownload(download::DownloadItem*, base::OnceClosure) override;
  bool ShouldAutomaticallyOpenFile(const GURL&, const base::FilePath&) override;
  bool ShouldAutomaticallyOpenFileByPolicy(const GURL&, const base::FilePath&) override;
  void GetSaveDir(content::BrowserContext*, base::FilePath*, base::FilePath*) override;
  void ChooseSavePath(content::WebContents*,
                      const base::FilePath&,
                      const base::FilePath::StringType&,
                      bool,
                      content::SavePackagePathPickedCallback) override;
  download::QuarantineConnectionCallback GetQuarantineConnectionCallback() override;
  std::string ApplicationClientIdForFileScanning() override;
  void CheckDownloadAllowed(const content::WebContents::Getter&,
                            const GURL&,
                            const std::string&,
                            std::optional<url::Origin>,
                            bool,
                            bool,
                            const std::string&,
                            std::optional<ui::PageTransition>,
                            content::CheckDownloadAllowedCallback) override;
  download::DownloadItem* GetDownloadByGuid(const std::string&) override;

 private:
  struct Record {
    raw_ptr<download::DownloadItem> item = nullptr;
    base::FilePath target;
    base::DictValue snapshot;
    std::string error;
  };
  void OnDownloadCreated(content::DownloadManager*, download::DownloadItem*) override;
  void OnDownloadUpdated(download::DownloadItem*) override;
  void OnDownloadDestroyed(download::DownloadItem*) override;
  void ManagerGoingDown(content::DownloadManager*) override;
  void TargetAllocated(std::string guid, base::FilePath target, std::string error);
  void Update(download::DownloadItem*);
  std::string BlockReason(download::DownloadItem*) const;
  raw_ptr<content::BrowserContext> context_;
  raw_ptr<content::DownloadManager> manager_ = nullptr;
  base::FilePath profile_path_;
  base::FilePath downloads_path_;
  std::map<std::string, Record> records_;
  std::map<std::string, download::DownloadTargetCallback> targets_;
  std::uint32_t next_id_ = 1;
  bool shutdown_ = false;
  base::WeakPtrFactory<ProfileDownloads> weak_factory_{this};
};

}  // namespace remotekit::browser
#endif
