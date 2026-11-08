#include "browser/context_menu.h"

#include <array>
#include "base/check.h"
#include "base/memory/raw_ptr.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "browser/view_registry.h"
#include "content/public/browser/context_menu_params.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "third_party/blink/public/common/context_menu_data/edit_flags.h"
#include "third_party/blink/public/mojom/context_menu/context_menu.mojom.h"
#include "ui/base/clipboard/scoped_clipboard_writer.h"
#include "ui/base/mojom/menu_source_type.mojom.h"
#include "url/gurl.h"

namespace remotekit::browser {
namespace {
RemoteContextMenu* instance = nullptr;
constexpr std::array edit_flags = {blink::kCanUndo, blink::kCanRedo,  blink::kCanCut,
                                   blink::kCanCopy, blink::kCanPaste, blink::kCanSelectAll};
constexpr std::array edit_names = {"undo", "redo", "cut", "copy", "paste", "selectAll"};
bool AllowedUrl(const GURL& url) {
  return url.is_valid() && url.SchemeIsHTTPOrHTTPS() && url.spec().size() <= 2048;
}
void CopyAddress(const std::string& address) {
  ui::ScopedClipboardWriter(ui::ClipboardBuffer::kCopyPaste).WriteText(base::UTF8ToUTF16(address));
}
const char* Source(ui::mojom::MenuSourceType source) {
  switch (source) {
    case ui::mojom::MenuSourceType::kKeyboard:
      return "keyboard";
    case ui::mojom::MenuSourceType::kTouch:
    case ui::mojom::MenuSourceType::kTouchEditMenu:
    case ui::mojom::MenuSourceType::kLongPress:
    case ui::mojom::MenuSourceType::kLongTap:
    case ui::mojom::MenuSourceType::kTouchHandle:
      return "touch";
    default:
      return "mouse";
  }
}
class ViewDelegate final : public content::WebContentsViewDelegate {
 public:
  explicit ViewDelegate(content::WebContents* contents) : contents_(contents) {}
  void ShowContextMenu(content::RenderFrameHost& frame,
                       const content::ContextMenuParams& params) override {
    RemoteContextMenu::Get().Open(frame, params);
  }
  void DismissContextMenu() override { RemoteContextMenu::Get().CloseFor(contents_); }

 private:
  raw_ptr<content::WebContents> contents_;
};
}  // namespace
RemoteContextMenu::RemoteContextMenu(ViewRegistry& views) : views_(views) {
  CHECK(!instance);
  instance = this;
}
RemoteContextMenu::~RemoteContextMenu() {
  Close();
  instance = nullptr;
}
RemoteContextMenu& RemoteContextMenu::Get() {
  CHECK(instance);
  return *instance;
}
void RemoteContextMenu::Open(content::RenderFrameHost& frame,
                             const content::ContextMenuParams& params) {
  Close();
  auto* contents = content::WebContents::FromRenderFrameHost(&frame);
  for (const auto& [id, record] : views_.records) {
    if (record.webview->contents() != contents || !record.spec.visible)
      continue;
    CHECK_NE(next_id_, UINT64_MAX);
    OpenState state;
    state.session = record.webview->session_id();
    state.view = record.webview->view_id();
    state.document = frame.GetWeakDocumentPtr();
    state.identity = {++next_id_, static_cast<float>(params.x), static_cast<float>(params.y)};
    state.x = params.x;
    state.y = params.y;
    state.edit_flags = params.edit_flags;
    state.image = params.media_type == blink::mojom::ContextMenuDataMediaType::kImage &&
                  params.has_image_contents;
    auto& details = state.details;
    details.Set("id", base::NumberToString(state.identity.menu_id));
    details.Set("x", params.x);
    details.Set("y", params.y);
    details.Set("source", Source(params.source_type));
    if (AllowedUrl(params.link_url))
      details.Set("link", base::DictValue()
                              .Set("url", params.link_url.spec())
                              .Set("text", base::UTF16ToUTF8(params.link_text)));
    if (params.media_type == blink::mojom::ContextMenuDataMediaType::kImage &&
        AllowedUrl(params.src_url))
      details.Set("image", base::DictValue().Set("src", params.src_url.spec()));
    std::u16string selection;
    base::TrimWhitespace(params.selection_text, base::TRIM_ALL, &selection);
    if (selection.size() > 256) {
      size_t length = 256;
      if (selection[length - 1] >= 0xd800 && selection[length - 1] <= 0xdbff)
        --length;
      selection.resize(length);
    }
    if (!selection.empty())
      details.Set("selection", base::UTF16ToUTF8(selection));
    if (params.is_editable) {
      base::DictValue editable;
      for (size_t i = 0; i < std::size(edit_flags); ++i)
        editable.Set(edit_names[i], (params.edit_flags & edit_flags[i]) != 0);
      details.Set("editable", std::move(editable));
    }
    open_ = std::move(state);
    Observe(contents);
    contents->SetShowingContextMenu(true);
    return;
  }
  contents->NotifyContextMenuClosed(GURL());
}
void RemoteContextMenu::Close() {
  if (!open_)
    return;
  open_.reset();
  auto* contents = web_contents();
  Observe(nullptr);
  if (contents) {
    contents->SetShowingContextMenu(false);
    contents->NotifyContextMenuClosed(GURL());
  }
}
void RemoteContextMenu::CloseFor(content::WebContents* contents) {
  if (contents == web_contents())
    Close();
}
void RemoteContextMenu::Prune() {
  if (!open_)
    return;
  auto* frame = open_->document.AsRenderFrameHostIfValid();
  auto* record = views_.Find(open_->session, open_->view);
  if (!frame || !frame->IsRenderFrameLive() || !frame->IsActive() || !record ||
      !record->spec.visible || record->webview->contents() != web_contents())
    Close();
}
SharedAtlasContextMenu RemoteContextMenu::StateFor(SessionId session, WebViewId view) {
  Prune();
  return open_ && open_->session == session && open_->view == view ? open_->identity
                                                                   : SharedAtlasContextMenu{};
}
Result<base::DictValue> RemoteContextMenu::Details(SessionId session,
                                                   WebViewId view,
                                                   uint64_t menu) {
  if (StateFor(session, view).menu_id != menu || !menu)
    return {{}, {ErrorCode::not_found, "Context menu closed"}};
  return {open_->details.Clone(), {}};
}
Status RemoteContextMenu::Execute(SessionId session, WebViewId view, const ContextCommand& value) {
  if (!value.menu || StateFor(session, view).menu_id != value.menu)
    return {ErrorCode::stale_identity, "Context menu changed"};
  auto* frame = open_->document.AsRenderFrameHostIfValid();
  auto* contents = web_contents();
  using Command = ContextCommand::Command;
  const auto command = value.command;
  const size_t index = static_cast<size_t>(command);
  bool enabled = false;
  if (index < std::size(edit_flags)) {
    enabled = contents->GetFocusedFrame() == frame && (open_->edit_flags & edit_flags[index]);
  } else if (command == Command::copy_link_address) {
    enabled = open_->details.FindDict("link") != nullptr;
  } else if (command == Command::copy_image_address) {
    enabled = open_->details.FindDict("image") != nullptr;
  } else if (command == Command::copy_image) {
    enabled = open_->image && open_->details.FindDict("image");
  } else {
    enabled = command == Command::dismiss;
  }
  if (!enabled) {
    Close();
    return {ErrorCode::stale_identity, "Context menu command unavailable"};
  }
  // Close after execution: Blink's context node is used by CopyImageAt.
  switch (command) {
    case Command::undo:
      contents->Undo();
      break;
    case Command::redo:
      contents->Redo();
      break;
    case Command::cut:
      contents->Cut();
      break;
    case Command::copy:
      contents->Copy();
      break;
    case Command::paste:
      contents->Paste();
      break;
    case Command::select_all:
      contents->SelectAll();
      break;
    case Command::copy_link_address:
      CopyAddress(*open_->details.FindDict("link")->FindString("url"));
      break;
    case Command::copy_image:
      frame->CopyImageAt(open_->x, open_->y);
      break;
    case Command::copy_image_address:
      CopyAddress(*open_->details.FindDict("image")->FindString("src"));
      break;
    case Command::dismiss:
      break;
  }
  Close();
  return {};
}
void RemoteContextMenu::RenderFrameDeleted(content::RenderFrameHost* frame) {
  if (open_ && open_->document.AsRenderFrameHostIfValid() == frame)
    Close();
}
void RemoteContextMenu::RenderFrameHostChanged(content::RenderFrameHost* old_frame,
                                               content::RenderFrameHost*) {
  if (open_ && open_->document.AsRenderFrameHostIfValid() == old_frame)
    Close();
}
void RemoteContextMenu::DidFinishNavigation(content::NavigationHandle*) {
  Prune();
}
void RemoteContextMenu::PrimaryPageChanged(content::Page&) {
  Close();
}
void RemoteContextMenu::OnVisibilityChanged(content::Visibility visibility) {
  if (visibility != content::Visibility::VISIBLE)
    Close();
}
void RemoteContextMenu::WebContentsDestroyed() {
  Close();
}
std::unique_ptr<content::WebContentsViewDelegate> CreateRemoteContextMenuDelegate(
    content::WebContents* contents) {
  return std::make_unique<ViewDelegate>(contents);
}
}  // namespace remotekit::browser
