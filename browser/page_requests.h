#ifndef REMOTEKIT_BROWSER_PAGE_REQUESTS_H_
#define REMOTEKIT_BROWSER_PAGE_REQUESTS_H_

#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "base/files/file_path.h"
#include "base/memory/weak_ptr.h"
#include "base/values.h"
#include "content/public/browser/javascript_dialog_manager.h"
#include "content/public/browser/weak_document_ptr.h"
#include "content/public/browser/web_contents_delegate.h"
#include "content/public/browser/web_contents_observer.h"
#include "third_party/blink/public/mojom/choosers/file_chooser.mojom.h"

namespace remotekit::browser {

// UI-sequence-only, one instance per logical WebView. The owner calls Bind(nullptr)
// before replacing a WebContents. Snapshot drains events but keeps pending work.
class PageRequests final : public content::WebContentsDelegate,
                           public content::JavaScriptDialogManager,
                           public content::WebContentsObserver {
 public:
  PageRequests();
  ~PageRequests() override;
  void Bind(content::WebContents* contents);
  struct AnchorLayout {
    int width;
    int height;
    float device_scale_factor;
    std::uint64_t instance;
    std::uint64_t document;
    std::uint64_t generation;
  };
  base::DictValue Snapshot(const AnchorLayout* anchor_layout);
  struct SelectionBinding {
    std::uint64_t instance = 0;
    std::uint64_t document = 0;
    bool operator==(const SelectionBinding&) const = default;
  };
  base::DictValue Reply(const base::DictValue& reply, SelectionBinding binding);
  base::DictValue FileStatus(const std::string& request,
                             const std::string* selection_id,
                             SelectionBinding binding,
                             bool terminal_only);
  struct SelectedFile {
    base::FilePath path;
    std::u16string display_name;
  };
  base::DictValue Command(const base::DictValue& command);
  void CancelAll(const std::string& reason);
  size_t pending_count() const { return pending_.size(); }
  bool fullscreen() const { return fullscreen_; }
  // Public delegate/observer APIs do not expose widget tooltip updates. A native
  // view/widget hook must forward them here; this method creates no native UI.
  void RequestClose();
  const std::string& close_state() const { return close_state_; }
  const std::string& close_reason() const { return close_reason_; }
  void CloseContents(content::WebContents*) override;
  using content::WebContentsObserver::BeforeUnloadFired;
  void BeforeUnloadFired(content::WebContents*, bool, bool*) override;
  using PopupHandler = std::function<content::WebContents*(std::unique_ptr<content::WebContents>,
                                                           const GURL&,
                                                           WindowOpenDisposition,
                                                           bool)>;
  void SetPopupHandler(PopupHandler handler) { popup_handler_ = std::move(handler); }
  content::WebContents* AddNewContents(content::WebContents*,
                                       std::unique_ptr<content::WebContents>,
                                       const GURL&,
                                       WindowOpenDisposition,
                                       const blink::mojom::WindowFeatures&,
                                       bool user_gesture,
                                       bool* was_blocked) override;

  content::WebContents* OpenURLFromTab(
      content::WebContents*,
      const content::OpenURLParams&,
      base::OnceCallback<void(content::NavigationHandle&)>) override;
  static content::WebContents* OpenURLFromBrowser(content::BrowserContext*,
                                                  const content::OpenURLParams&);
  void ShowRepostFormWarningDialog(content::WebContents*) override;
  blink::mojom::DisplayMode GetDisplayMode(const content::WebContents*) override;
  bool IsBackForwardCacheSupported(content::WebContents&) override { return true; }
  void RequestMediaAccessPermission(content::WebContents*,
                                    const content::MediaStreamRequest&,
                                    content::MediaResponseCallback) override;
  bool CheckMediaAccessPermission(content::RenderFrameHost*,
                                  const url::Origin&,
                                  blink::mojom::MediaStreamType) override;
  void ProcessSelectAudioOutput(const content::SelectAudioOutputRequest&,
                                content::SelectAudioOutputCallback) override;

  content::JavaScriptDialogManager* GetJavaScriptDialogManager(content::WebContents*) override;
  void RunJavaScriptDialog(content::WebContents*,
                           content::RenderFrameHost*,
                           content::JavaScriptDialogType,
                           const std::u16string& message,
                           const std::u16string& default_prompt,
                           DialogClosedCallback,
                           bool* did_suppress_message) override;
  void RunBeforeUnloadDialog(content::WebContents*,
                             content::RenderFrameHost*,
                             bool is_reload,
                             DialogClosedCallback) override;
  bool HandleJavaScriptDialog(content::WebContents*,
                              bool accept,
                              const std::u16string* prompt_override) override;
  void CancelDialogs(content::WebContents*, bool reset_state) override;
  void RunFileChooser(content::RenderFrameHost*,
                      scoped_refptr<content::FileSelectListener>,
                      const blink::mojom::FileChooserParams&) override;
  void EnumerateDirectory(content::WebContents*,
                          scoped_refptr<content::FileSelectListener>,
                          const base::FilePath&) override;
  bool CanEnterFullscreenModeForTab(content::RenderFrameHost*) override;
  void EnterFullscreenModeForTab(content::RenderFrameHost*,
                                 const blink::mojom::FullscreenOptions&) override;
  void ExitFullscreenModeForTab(content::WebContents*) override;
  bool IsFullscreenForTabOrPending(const content::WebContents*) override;
  content::FullscreenState GetFullscreenState(const content::WebContents*) const override;
  void RequestPointerLock(content::WebContents*, bool, bool) override;
  void RequestKeyboardLock(content::WebContents*, bool) override;
  bool IsWebContentsCreationOverridden(content::RenderFrameHost*,
                                       content::SiteInstance*,
                                       content::mojom::WindowContainerType,
                                       const GURL&,
                                       const std::string&,
                                       const GURL&) override;

 private:
  struct Pending;
  struct FileReceipt {
    base::DictValue result;
    SelectionBinding binding;
  };
  std::uint64_t Add(std::unique_ptr<Pending>);
  void Event(base::DictValue);
  void Cancel(std::uint64_t id, const std::string& reason);
  void Prune();
  void FilesValidated(std::uint64_t, std::vector<SelectedFile>, std::string);
  void FileResult(std::uint64_t,
                  const char*,
                  const Pending& request,
                  const std::string& error = {});
  void DidStartNavigation(content::NavigationHandle*) override;
  void DidFinishNavigation(content::NavigationHandle*) override;
  void RenderFrameDeleted(content::RenderFrameHost*) override;
  void WebContentsDestroyed() override;
  void DidReceiveFindReply(int request_id,
                           int number_of_matches,
                           const gfx::Rect&,
                           int active_match_ordinal,
                           bool final_update) override;

  std::string close_state_ = "open";
  std::string close_reason_ = "removed";
  std::uint64_t next_id_ = 1;
  std::map<std::uint64_t, std::unique_ptr<Pending>> pending_;
  std::deque<base::DictValue> events_;
  std::map<std::uint64_t, FileReceipt> file_results_;
  bool fullscreen_ = false;
  bool cancelling_ = false;
  content::WeakDocumentPtr find_document_;
  int find_request_id_ = -1;
  bool find_pending_ = false;
  PopupHandler popup_handler_;
  base::WeakPtrFactory<PageRequests> weak_factory_{this};
};

}  // namespace remotekit::browser
#endif
