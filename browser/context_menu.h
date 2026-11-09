#pragma once
#include <memory>
#include <optional>

#include "base/values.h"
#include "browser/view_model.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_contents_view_delegate.h"
#include "content/public/browser/weak_document_ptr.h"
#include "protocol/shared_render_slots.h"

namespace remotekit::browser {
class ViewRegistry;
class RemoteContextMenu final : public content::WebContentsObserver {
 public:
  explicit RemoteContextMenu(ViewRegistry&);
  ~RemoteContextMenu() override;
  static RemoteContextMenu& Get();
  void Open(content::RenderFrameHost&, const content::ContextMenuParams&);
  void Close();
  void CloseFor(content::WebContents*);
  void CloseFor(SessionId, WebViewId = 0);
  void Prune();
  SharedAtlasContextMenu StateFor(SessionId, WebViewId);
  Result<base::DictValue> Details(SessionId, WebViewId, uint64_t menu);
  Status Execute(SessionId, WebViewId, const ContextCommand&);

 private:
  struct OpenState {
    SessionId session{};
    WebViewId view{};
    // Invalidates on both RenderFrameHost destruction and document replacement.
    content::WeakDocumentPtr document;
    SharedAtlasContextMenu identity{};
    base::DictValue details;
    int edit_flags{};
    int x{}, y{};
    bool image{};
  };
  void RenderFrameDeleted(content::RenderFrameHost*) override;
  void RenderFrameHostChanged(content::RenderFrameHost*, content::RenderFrameHost*) override;
  void DidFinishNavigation(content::NavigationHandle*) override;
  void PrimaryPageChanged(content::Page&) override;
  void OnVisibilityChanged(content::Visibility) override;
  void WebContentsDestroyed() override;
  ViewRegistry& views_;
  std::optional<OpenState> open_;
  uint64_t next_id_{};
};
std::unique_ptr<content::WebContentsViewDelegate> CreateRemoteContextMenuDelegate(
    content::WebContents*);
}  // namespace remotekit::browser
