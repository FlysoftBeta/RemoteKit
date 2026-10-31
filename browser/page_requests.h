#ifndef REMOTEKIT_BROWSER_PAGE_REQUESTS_H_
#define REMOTEKIT_BROWSER_PAGE_REQUESTS_H_

#include <cstdint>
#include <deque>
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
  base::DictValue Snapshot();
  base::DictValue Reply(const base::DictValue& reply);
  base::DictValue Command(const base::DictValue& command);
  void CancelAll(const std::string& reason);
  size_t pending_count() const { return pending_.size(); }
  // Public delegate/observer APIs do not expose widget tooltip updates. A native
  // view/widget hook must forward them here; this method creates no native UI.
  void RequestClose();
  const std::string& close_state() const { return close_state_; }
  void CloseContents(content::WebContents*) override;
  using content::WebContentsObserver::BeforeUnloadFired;
  void BeforeUnloadFired(content::WebContents*, bool, bool*) override;
  void ReportTooltip(const std::u16string& text);

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
  bool HandleContextMenu(content::RenderFrameHost&, const content::ContextMenuParams&) override;
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
  std::uint64_t Add(std::unique_ptr<Pending>);
  void Event(base::DictValue);
  void Cancel(std::uint64_t id, const std::string& reason);
  void Prune();
  void FilesValidated(std::uint64_t, std::vector<base::FilePath>, std::string);
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
  std::uint64_t next_id_ = 1;
  std::map<std::uint64_t, std::unique_ptr<Pending>> pending_;
  std::deque<base::DictValue> events_;
  bool fullscreen_ = false;
  bool cancelling_ = false;
  content::WeakDocumentPtr find_document_;
  int find_request_id_ = -1;
  bool find_pending_ = false;
  base::WeakPtrFactory<PageRequests> weak_factory_{this};
};

}  // namespace remotekit::browser
#endif
