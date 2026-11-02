#include "browser/page_requests.h"

#include <cmath>
#include <limits>
#include <string_view>
#include <utility>

#include "base/files/file.h"
#include "base/functional/bind.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/thread_pool.h"
#include "build/build_config.h"
#include "content/public/browser/context_menu_params.h"
#include "content/public/browser/file_select_listener.h"
#include "content/public/browser/host_zoom_map.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/reload_type.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/weak_document_ptr.h"
#include "content/public/browser/web_contents.h"
#include "content/public/common/referrer.h"
#include "content/public/common/stop_find_action.h"
#include "third_party/blink/public/mojom/frame/find_in_page.mojom.h"
#include "ui/base/page_transition_types.h"
#include "ui/gfx/geometry/rect.h"
#include "url/origin.h"

#if BUILDFLAG(IS_WIN)
#include <windows.h>
#endif

namespace remotekit::browser {
namespace {
constexpr std::size_t kLimit = 64;
constexpr std::size_t kStringLimit = 16 * 1024;
std::string Clip(std::string_view text) {
  return std::string(base::TruncateUTF8ToByteSize(text, kStringLimit));
}
std::string Text(const std::u16string& text) {
  return Clip(base::UTF16ToUTF8(text));
}
base::DictValue Result(const std::string& error = {}) {
  base::DictValue result;
  result.Set("ok", error.empty());
  if (!error.empty())
    result.Set("error", error);
  return result;
}
base::DictValue Kind(const char* kind) {
  base::DictValue result;
  result.Set("kind", kind);
  return result;
}
bool Live(content::RenderFrameHost* frame) {
  return frame && frame->IsActive();
}
using ValidatedFiles = std::pair<std::vector<PageRequests::SelectedFile>, std::string>;
ValidatedFiles ValidateFiles(std::vector<PageRequests::SelectedFile> paths) {
  for (const auto& selected : paths) {
    const auto& path = selected.path;
    if (!path.IsAbsolute())
      return {{}, "file_path_must_be_absolute"};
#if BUILDFLAG(IS_WIN)
    if (path.NormalizePathSeparators().value().starts_with(L"\\\\.\\"))
      return {{}, "device_paths_unsupported"};
#endif
    base::File file(path, base::File::FLAG_OPEN | base::File::FLAG_READ);
    base::File::Info info;
    if (!file.IsValid() || !file.GetInfo(&info) || info.is_directory)
      return {{}, "file_must_be_existing_regular_file"};
#if BUILDFLAG(IS_WIN)
    if (GetFileType(file.GetPlatformFile()) != FILE_TYPE_DISK)
      return {{}, "file_must_be_existing_regular_file"};
#endif
  }
  return {std::move(paths), {}};
}
}  // namespace

struct PageRequests::Pending {
  enum class Type { dialog, file, menu };
  Type type = Type::dialog;
  content::WeakDocumentPtr document;
  base::DictValue data;
  DialogClosedCallback dialog;
  scoped_refptr<content::FileSelectListener> file;
  blink::mojom::FileChooserParams::Mode mode = blink::mojom::FileChooserParams::Mode::kOpen;
  GURL link;
  bool validating = false;
};

PageRequests::PageRequests() = default;
PageRequests::~PageRequests() {
  weak_factory_.InvalidateWeakPtrs();
  Bind(nullptr);
}
void PageRequests::Bind(content::WebContents* contents) {
  if (contents == web_contents())
    return;
  auto weak = weak_factory_.GetWeakPtr();
  const auto target = contents ? contents->GetWeakPtr() : base::WeakPtr<content::WebContents>();
  const auto previous =
      web_contents() ? web_contents()->GetWeakPtr() : base::WeakPtr<content::WebContents>();
  if (web_contents() && web_contents()->GetDelegate() == this)
    web_contents()->SetDelegate(nullptr);
  Observe(nullptr);
  if (previous && find_request_id_ != -1)
    previous->StopFinding(content::STOP_FIND_ACTION_CLEAR_SELECTION);
  CancelAll("contents_rebound");
  if (!weak)
    return;
  fullscreen_ = false;
  find_document_ = {};
  find_request_id_ = -1;
  find_pending_ = false;
  Observe(target.get());
  if (target)
    target->SetDelegate(this);
}
void PageRequests::RequestClose() {
  if (close_state_ == "closing" || close_state_ == "closed")
    return;
  close_state_ = "closing";
  close_reason_ = "requested";
  if (!web_contents()) {
    close_state_ = "closed";
    return;
  }
  if (web_contents()->NeedToFireBeforeUnloadOrUnloadEvents())
    web_contents()->DispatchBeforeUnload(false);
  else
    web_contents()->ClosePage();
}
void PageRequests::BeforeUnloadFired(content::WebContents*, bool proceed,
                                    bool* proceed_to_fire_unload) {
  *proceed_to_fire_unload = proceed;
  if (close_state_ == "closing" && !proceed)
    close_state_ = "cancelled";
}
void PageRequests::CloseContents(content::WebContents*) {
  if (close_state_ != "closing") close_reason_ = "window.close";
  close_state_ = "closed";
}
void PageRequests::Event(base::DictValue event) {
  if (events_.size() == kLimit)
    events_.pop_front();
  events_.push_back(std::move(event));
}
std::uint64_t PageRequests::Add(std::unique_ptr<Pending> request) {
  if (cancelling_ || pending_.size() >= kLimit ||
      next_id_ == std::numeric_limits<std::uint64_t>::max() ||
      !Live(request->document.AsRenderFrameHostIfValid())) {
    auto event = Kind("request_rejected");
    event.Set("reason", cancelling_                 ? "cancelling"
                        : pending_.size() >= kLimit ? "queue_full"
                                                    : "document_invalid_or_id_exhausted");
    Event(std::move(event));
    if (request->type == Pending::Type::menu && web_contents())
      web_contents()->NotifyContextMenuClosed(GURL());
    if (request->file)
      request->file->FileSelectionCanceled();
    if (request->dialog)
      std::move(request->dialog).Run(false, {});
    return 0;
  }
  const auto id = next_id_++;
  request->data.Set("request", base::NumberToString(id));
  request->data.Set("state", "pending");
  pending_.emplace(id, std::move(request));
  return id;
}
void PageRequests::Cancel(std::uint64_t id, const std::string& reason) {
  auto it = pending_.find(id);
  if (it == pending_.end())
    return;
  auto request = std::move(it->second);
  pending_.erase(it);
  auto event = Kind("request_cancelled");
  event.Set("request", base::NumberToString(id));
  event.Set("reason", Clip(reason));
  Event(std::move(event));
  if (request->file) FileResult(id, "cancelled", reason);
  if (request->type == Pending::Type::menu && reason != "context_menu_superseded" && web_contents())
    web_contents()->NotifyContextMenuClosed(GURL());
  if (request->file)
    request->file->FileSelectionCanceled();
  if (request->dialog)
    std::move(request->dialog).Run(false, {});
}
void PageRequests::CancelAll(const std::string& reason) {
  auto weak = weak_factory_.GetWeakPtr();
  const bool was_cancelling = cancelling_;
  cancelling_ = true;
  if (find_pending_) {
    find_pending_ = false;
    auto event = Kind("find_cancelled");
    event.Set("find_request", find_request_id_);
    event.Set("reason", Clip(reason));
    Event(std::move(event));
  }
  find_document_ = {};
  const bool stop_find = find_request_id_ != -1;
  find_request_id_ = -1;
  if (stop_find && web_contents())
    web_contents()->StopFinding(content::STOP_FIND_ACTION_CLEAR_SELECTION);
  if (!weak)
    return;
  while (!pending_.empty()) {
    Cancel(pending_.begin()->first, reason);
    if (!weak)
      return;
  }
  cancelling_ = was_cancelling;
}
void PageRequests::Prune() {
  std::vector<std::uint64_t> invalid;
  for (const auto& [id, request] : pending_)
    if (!Live(request->document.AsRenderFrameHostIfValid()))
      invalid.push_back(id);
  auto weak = weak_factory_.GetWeakPtr();
  for (auto id : invalid) {
    Cancel(id, "document_invalidated");
    if (!weak)
      return;
  }
}
void PageRequests::FileResult(std::uint64_t id, const char* state, const std::string& error) {
  auto result = Result(); result.Set("state", state);
  if (!error.empty()) result.Set("error", Clip(error));
  file_results_.insert_or_assign(id, std::move(result));
  while (file_results_.size() > kLimit) file_results_.erase(file_results_.begin());
}
base::DictValue PageRequests::FileStatus(const std::string& key) {
  const auto weak = weak_factory_.GetWeakPtr();
  Prune();
  if (!weak) return Result("manager_destroyed");
  std::uint64_t id = 0;
  if (!base::StringToUint64(key, &id) || base::NumberToString(id) != key) return Result("invalid_file_request");
  const auto found = pending_.find(id);
  if (found != pending_.end()) {
    if (!found->second->file) return Result("file_request_required");
    auto result = Result(); result.Set("state", found->second->validating ? "validating" : "pending"); return result;
  }
  const auto completed = file_results_.find(id);
  return completed == file_results_.end() ? Result("unknown_file_request") : completed->second.Clone();
}
base::DictValue PageRequests::Snapshot() {
  auto weak = weak_factory_.GetWeakPtr();
  Prune();
  if (!weak)
    return Result("manager_destroyed");
  base::DictValue result;
  base::ListValue pending;
  for (const auto& [id, request] : pending_)
    pending.Append(request->data.Clone());
  base::ListValue events;
  while (!events_.empty()) {
    events.Append(std::move(events_.front()));
    events_.pop_front();
  }
  result.Set("pending", std::move(pending));
  result.Set("events", std::move(events));
  return result;
}
content::JavaScriptDialogManager* PageRequests::GetJavaScriptDialogManager(content::WebContents*) {
  return this;
}
void PageRequests::RunJavaScriptDialog(content::WebContents*,
                                       content::RenderFrameHost* frame,
                                       content::JavaScriptDialogType type,
                                       const std::u16string& message,
                                       const std::u16string& default_prompt,
                                       DialogClosedCallback callback,
                                       bool* did_suppress_message) {
  *did_suppress_message = false;
  auto request = std::make_unique<Pending>();
  if (frame)
    request->document = frame->GetWeakDocumentPtr();
  request->dialog = std::move(callback);
  request->data = Kind(type == content::JAVASCRIPT_DIALOG_TYPE_ALERT     ? "alert"
                       : type == content::JAVASCRIPT_DIALOG_TYPE_CONFIRM ? "confirm"
                                                                         : "prompt");
  request->data.Set("message", Text(message));
  request->data.Set("default_prompt", Text(default_prompt));
  request->data.Set("origin", frame ? Clip(frame->GetLastCommittedOrigin().Serialize()) : "");
  request->data.Set("beforeunload", false);
  Add(std::move(request));
}
void PageRequests::RunBeforeUnloadDialog(content::WebContents*,
                                         content::RenderFrameHost* frame,
                                         bool is_reload,
                                         DialogClosedCallback callback) {
  auto request = std::make_unique<Pending>();
  if (frame)
    request->document = frame->GetWeakDocumentPtr();
  request->dialog = std::move(callback);
  request->data = Kind("beforeunload");
  request->data.Set("message", "Leave this page?");
  request->data.Set("default_prompt", "");
  request->data.Set("origin", frame ? Clip(frame->GetLastCommittedOrigin().Serialize()) : "");
  request->data.Set("beforeunload", true);
  request->data.Set("is_reload", is_reload);
  Add(std::move(request));
}
bool PageRequests::HandleJavaScriptDialog(content::WebContents*,
                                          bool accept,
                                          const std::u16string* prompt_override) {
  for (const auto& [id, request] : pending_) {
    if (request->type != Pending::Type::dialog)
      continue;
    auto reply = base::DictValue();
    reply.Set("request", base::NumberToString(id));
    reply.Set("accept", accept);
    if (prompt_override)
      reply.Set("text", Text(*prompt_override));
    return Reply(reply).FindBool("ok").value_or(false);
  }
  return false;
}
void PageRequests::CancelDialogs(content::WebContents*, bool) {
  std::vector<std::uint64_t> ids;
  for (const auto& [id, request] : pending_)
    if (request->type == Pending::Type::dialog)
      ids.push_back(id);
  auto weak = weak_factory_.GetWeakPtr();
  for (auto id : ids) {
    Cancel(id, "dialogs_cancelled");
    if (!weak)
      return;
  }
}
void PageRequests::RunFileChooser(content::RenderFrameHost* frame,
                                  scoped_refptr<content::FileSelectListener> listener,
                                  const blink::mojom::FileChooserParams& params) {
  using Mode = blink::mojom::FileChooserParams::Mode;
  if (params.mode != Mode::kOpen && params.mode != Mode::kOpenMultiple) {
    auto event = Kind("file_chooser_unsupported");
    event.Set("mode", static_cast<int>(params.mode));
    event.Set("reason", "only_existing_regular_file_open_is_supported");
    Event(std::move(event));
    listener->FileSelectionCanceled();
    return;
  }
  auto request = std::make_unique<Pending>();
  request->type = Pending::Type::file;
  if (frame)
    request->document = frame->GetWeakDocumentPtr();
  request->file = std::move(listener);
  request->mode = params.mode;
  request->data = Kind("file_chooser");
  request->data.Set("mode", params.mode == Mode::kOpenMultiple ? "open_multiple" : "open");
  request->data.Set("multiple", params.mode == Mode::kOpenMultiple);
  request->data.Set("need_local_path", params.need_local_path);
  request->data.Set("origin", frame ? Clip(frame->GetLastCommittedOrigin().Serialize()) : "");
  base::ListValue accepts;
  for (const auto& type : params.accept_types) {
    if (accepts.size() == kLimit)
      break;
    accepts.Append(Text(type));
  }
  request->data.Set("accept_types", std::move(accepts));
  Add(std::move(request));
}
void PageRequests::EnumerateDirectory(content::WebContents*,
                                      scoped_refptr<content::FileSelectListener> listener,
                                      const base::FilePath&) {
  auto event = Kind("file_chooser_unsupported");
  event.Set("reason", "directory_enumeration_and_relative_paths_unsupported");
  Event(std::move(event));
  listener->FileSelectionCanceled();
}
bool PageRequests::HandleContextMenu(content::RenderFrameHost& frame,
                                     const content::ContextMenuParams& params) {
  std::vector<std::uint64_t> old_menus;
  for (const auto& [id, request] : pending_)
    if (request->type == Pending::Type::menu)
      old_menus.push_back(id);
  for (auto id : old_menus)
    Cancel(id, "context_menu_superseded");
  auto request = std::make_unique<Pending>();
  request->type = Pending::Type::menu;
  request->document = frame.GetWeakDocumentPtr();
  request->link = params.link_url;
  request->data = Kind("context_menu");
  request->data.Set("page_url", Clip(params.page_url.spec()));
  request->data.Set("frame_url", Clip(params.frame_url.spec()));
  request->data.Set("link_url", Clip(params.link_url.spec()));
  request->data.Set("source_url", Clip(params.src_url.spec()));
  request->data.Set("selection", Text(params.selection_text));
  // RenderFrameHostImpl has already transformed these into root-view DIPs.
  request->data.Set("x_dip", params.x);
  request->data.Set("y_dip", params.y);
  request->data.Set("editable", params.is_editable);
  Add(std::move(request));
  return true;
}
void PageRequests::ReportTooltip(const std::u16string& text) {
  auto event = Kind("tooltip");
  event.Set("text", Text(text));
  Event(std::move(event));
}
bool PageRequests::CanEnterFullscreenModeForTab(content::RenderFrameHost*) {
  return true;
}
void PageRequests::EnterFullscreenModeForTab(content::RenderFrameHost* frame,
                                             const blink::mojom::FullscreenOptions&) {
  fullscreen_ = true;
  auto event = Kind("fullscreen");
  event.Set("active", true);
  event.Set("native_host_fullscreen", false);
  event.Set("origin", frame ? Clip(frame->GetLastCommittedOrigin().Serialize()) : "");
  Event(std::move(event));
}
void PageRequests::ExitFullscreenModeForTab(content::WebContents*) {
  fullscreen_ = false;
  auto event = Kind("fullscreen");
  event.Set("active", false);
  Event(std::move(event));
}
bool PageRequests::IsFullscreenForTabOrPending(const content::WebContents*) {
  return fullscreen_;
}
content::FullscreenState PageRequests::GetFullscreenState(const content::WebContents*) const {
  content::FullscreenState state;
  state.target_mode =
      fullscreen_ ? content::FullscreenMode::kPseudoContent : content::FullscreenMode::kWindowed;
  return state;
}
void PageRequests::RequestPointerLock(content::WebContents* contents, bool, bool) {
  auto event = Kind("pointer_lock_denied");
  event.Set("reason", "relative_pointer_input_unavailable");
  Event(std::move(event));
  contents->GotPointerLockPermissionResponse(false);
}
void PageRequests::RequestKeyboardLock(content::WebContents* contents, bool) {
  auto event = Kind("keyboard_lock_denied");
  event.Set("reason", "keyboard_capture_unavailable");
  Event(std::move(event));
  contents->GotResponseToKeyboardLockRequest(false);
}
bool PageRequests::IsWebContentsCreationOverridden(content::RenderFrameHost*,
                                                   content::SiteInstance*,
                                                   content::mojom::WindowContainerType,
                                                   const GURL&,
                                                   const std::string&,
                                                   const GURL& target_url) {
  if (popup_handler_) return false;
  auto event = Kind("blocked_popup");
  event.Set("url", Clip(target_url.spec()));
  event.Set("reason", "dynamic_webview_creation_unsupported");
  Event(std::move(event));
  return true;
}
content::WebContents* PageRequests::AddNewContents(content::WebContents*,
    std::unique_ptr<content::WebContents> contents, const GURL& url,
    WindowOpenDisposition disposition, const blink::mojom::WindowFeatures&,
    bool user_gesture, bool* was_blocked) {
  if (!popup_handler_ || !user_gesture) {
    if (was_blocked) *was_blocked = true;
    auto event = Kind("blocked_popup"); event.Set("url", Clip(url.spec()));
    event.Set("reason", "user_gesture_required"); Event(std::move(event));
    return nullptr;
  }
  auto* adopted = popup_handler_(std::move(contents), url, disposition, user_gesture);
  if (!adopted && was_blocked) *was_blocked = true;
  return adopted;
}

base::DictValue PageRequests::Reply(const base::DictValue& reply) {
  const auto* key = reply.FindString("request");
  const auto accept = reply.FindBool("accept");
  std::uint64_t id = 0;
  if (!key || key->size() > 20 || !base::StringToUint64(*key, &id) ||
      base::NumberToString(id) != *key || !accept.has_value())
    return Result("request_and_accept_required");
  auto found = pending_.find(id);
  if (found == pending_.end())
    return Result("unknown_or_finished_request");
  auto* request = found->second.get();
  if (reply.FindBool("close_only").value_or(false) &&
      (close_state_ != "closing" || request->type != Pending::Type::dialog ||
       !request->data.FindBool("beforeunload").value_or(false)))
    return Result("closing_beforeunload_required");
  if (reply.FindBool("dialog_only").value_or(false) && request->type != Pending::Type::dialog)
    return Result("standard_dialog_required");
  if (reply.FindBool("file_only").value_or(false) && request->type != Pending::Type::file)
    return Result("file_request_required");
  auto* frame = request->document.AsRenderFrameHostIfValid();
  if (!Live(frame)) {
    Cancel(id, "document_invalidated");
    return Result("document_invalidated");
  }
  if (!*accept) {
    Cancel(id, "remote_rejected");
    return Result();
  }
  if (request->validating)
    return Result("reply_already_validating");
  if (request->type == Pending::Type::file) {
    const auto* values = reply.FindList("files");
    const bool legacy = !values && !reply.FindBool("file_only").value_or(false);
    if (legacy) values = reply.FindList("paths");
    const bool multiple = request->mode == blink::mojom::FileChooserParams::Mode::kOpenMultiple;
    if (!values || values->empty() || values->size() > kLimit || (!multiple && values->size() != 1))
      return Result("invalid_file_count");
    std::vector<SelectedFile> paths;
    for (const auto& value : *values) {
      const auto* file = value.GetIfDict();
      const auto* path = legacy ? value.GetIfString() : file ? file->FindString("path") : nullptr;
      const auto* display = file ? file->FindString("displayName") : nullptr;
      if (!path || path->empty() || path->size() > kStringLimit ||
          path->find('\0') != std::string::npos || !base::IsStringUTF8(*path))
        return Result("invalid_file_path");
      auto native = base::FilePath::FromUTF8Unsafe(*path);
      if (!native.IsAbsolute())
        return Result("file_path_must_be_absolute");
      if (!legacy && (!display || display->empty() || display->size() > 1024 || !base::IsStringUTF8(*display) ||
                      display->find_first_of("/\\:\0", 0, 4) != std::string::npos || *display == "." || *display == ".."))
        return Result("invalid_file_display_name");
      paths.push_back({std::move(native), display ? base::UTF8ToUTF16(*display) : std::u16string()});
    }
    request->validating = true;
    request->data.Set("state", "validating");
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
        base::BindOnce(&ValidateFiles, std::move(paths)),
        base::BindOnce(
            [](base::WeakPtr<PageRequests> owner, std::uint64_t request_id, ValidatedFiles result) {
              if (owner)
                owner->FilesValidated(request_id, std::move(result.first),
                                      std::move(result.second));
            },
            weak_factory_.GetWeakPtr(), id));
    auto result = Result();
    result.Set("state", "validating");
    return result;
  }
  std::u16string text;
  if (request->type == Pending::Type::dialog) {
    const auto* input = reply.FindString("text");
    if (input && (input->size() > kStringLimit || !base::IsStringUTF8(*input)))
      return Result("invalid_or_oversized_text");
    const auto* fallback = request->data.FindString("default_prompt");
    text = base::UTF8ToUTF16(input ? *input : fallback ? *fallback : std::string());
  }
  std::string choice;
  if (request->type == Pending::Type::menu) {
    const auto* selected = reply.FindString("choice");
    if (!selected || selected->size() > kStringLimit)
      return Result("choice_required");
    choice = *selected;
    if (choice != "copy" && choice != "paste" && choice != "cut" && choice != "select_all" &&
        choice != "navigate_link")
      return Result("unsupported_choice");
    if (choice == "navigate_link") {
      if (!request->link.is_valid() || !request->link.SchemeIsHTTPOrHTTPS())
        return Result("link_scheme_unsupported");
    } else if (!web_contents() || web_contents()->GetFocusedFrame() != frame) {
      Cancel(id, "context_menu_frame_no_longer_focused");
      return Result("context_menu_frame_no_longer_focused");
    }
  }
  auto completed = std::move(found->second);
  pending_.erase(found);
  auto event = Kind("request_replied");
  event.Set("request", base::NumberToString(id));
  event.Set("state", completed->type == Pending::Type::dialog ? "resolved" : "submitted");
  Event(std::move(event));
  if (completed->type == Pending::Type::menu)
    web_contents()->NotifyContextMenuClosed(choice == "navigate_link" ? completed->link : GURL());
  if (completed->type == Pending::Type::dialog) {
    std::move(completed->dialog).Run(true, text);
  } else if (choice == "navigate_link") {
    web_contents()->GetController().LoadURL(completed->link, content::Referrer(),
                                            ui::PAGE_TRANSITION_LINK, {});
  } else if (choice == "copy")
    web_contents()->Copy();
  else if (choice == "paste")
    web_contents()->Paste();
  else if (choice == "cut")
    web_contents()->Cut();
  else if (choice == "select_all")
    web_contents()->SelectAll();
  auto result = Result();
  result.Set("state", completed->type == Pending::Type::dialog ? "resolved" : "submitted");
  return result;
}

void PageRequests::FilesValidated(std::uint64_t id,
                                  std::vector<SelectedFile> paths,
                                  std::string error) {
  auto found = pending_.find(id);
  if (found == pending_.end())
    return;
  if (!error.empty()) {
    Cancel(id, error);
    return;
  }
  if (!Live(found->second->document.AsRenderFrameHostIfValid())) {
    Cancel(id, "document_invalidated");
    return;
  }
  auto request = std::move(found->second);
  pending_.erase(found);
  std::vector<blink::mojom::FileChooserFileInfoPtr> files;
  for (auto& selected : paths) {
    auto native = blink::mojom::NativeFileInfo::New();
    native->file_path = std::move(selected.path);
    native->display_name = std::move(selected.display_name);
    files.push_back(blink::mojom::FileChooserFileInfo::NewNativeFile(std::move(native)));
  }
  auto event = Kind("request_replied");
  event.Set("request", base::NumberToString(id));
  event.Set("state", "selected");
  Event(std::move(event));
  FileResult(id, "selected");
  request->file->FileSelected(std::move(files), base::FilePath(), request->mode);
}

base::DictValue PageRequests::Command(const base::DictValue& command) {
  auto* contents = web_contents();
  if (!contents)
    return Result("contents_not_bound");
  const auto* action = command.FindString("action");
  if (!action || action->size() > kStringLimit)
    return Result("action_required");
  auto result = Result();
  result.Set("state", "submitted");
  auto& controller = contents->GetController();
  if (*action == "back") {
    if (!controller.CanGoBack())
      return Result("no_back_entry");
    controller.GoBack();
  } else if (*action == "forward") {
    if (!controller.CanGoForward())
      return Result("no_forward_entry");
    controller.GoForward();
  } else if (*action == "reload") {
    controller.Reload(content::ReloadType::NORMAL, true);
  } else if (*action == "stop") {
    contents->Stop();
  } else if (*action == "find") {
    if (!Live(contents->GetPrimaryMainFrame()))
      return Result("document_invalidated");
    const auto* text = command.FindString("text");
    if (!text || text->empty() || text->size() > kStringLimit || !base::IsStringUTF8(*text))
      return Result("invalid_find_text");
    auto options = blink::mojom::FindOptions::New();
    options->forward = command.FindBool("forward").value_or(true);
    options->match_case = command.FindBool("match_case").value_or(false);
    options->new_session = command.FindBool("new_session").value_or(true);
    int request_id = -1;
    find_document_ = contents->GetPrimaryMainFrame()->GetWeakDocumentPtr();
    find_pending_ = true;
    contents->Find(base::UTF8ToUTF16(*text), std::move(options), true,
                   [this, &request_id](int value) {
                     request_id = value;
                     find_request_id_ = value;
                   });
    result.Set("find_request", request_id);
  } else if (*action == "stop_find") {
    find_pending_ = false;
    find_request_id_ = -1;
    find_document_ = {};
    contents->StopFinding(content::STOP_FIND_ACTION_CLEAR_SELECTION);
  } else if (*action == "zoom" || *action == "get_zoom") {
    auto* frame = contents->GetPrimaryMainFrame();
    if (!Live(frame))
      return Result("document_invalidated");
    if (*action == "zoom") {
      const auto level = command.FindDouble("level");
      if (!level || !std::isfinite(*level) || *level < -10 || *level > 10)
        return Result("zoom_level_must_be_finite_between_minus10_and10");
      content::HostZoomMap::GetForWebContents(contents)->SetTemporaryZoomLevel(frame->GetGlobalId(),
                                                                               *level);
    }
    result.Set("level", content::HostZoomMap::GetZoomLevel(contents));
    result.Set("state", "applied");
  } else if (*action == "copy" || *action == "paste" || *action == "cut" ||
             *action == "select_all") {
    if (!Live(contents->GetFocusedFrame()))
      return Result("no_focused_document");
    if (*action == "copy")
      contents->Copy();
    else if (*action == "paste")
      contents->Paste();
    else if (*action == "cut")
      contents->Cut();
    else
      contents->SelectAll();
  } else {
    return Result("unsupported_action");
  }
  return result;
}
void PageRequests::DidStartNavigation(content::NavigationHandle* navigation) {
  if (navigation->IsSameDocument())
    return;
  std::vector<std::uint64_t> ids;
  for (const auto& [id, request] : pending_) {
    // beforeunload is the decision that allows this navigation to proceed.
    if (request->data.FindBool("beforeunload").value_or(false))
      continue;
    auto* frame = request->document.AsRenderFrameHostIfValid();
    bool affected = navigation->IsInPrimaryMainFrame();
    for (auto* ancestor = frame; !affected && ancestor; ancestor = ancestor->GetParent())
      affected = ancestor->GetFrameTreeNodeId() == navigation->GetFrameTreeNodeId();
    if (affected || !Live(frame))
      ids.push_back(id);
  }
  auto weak = weak_factory_.GetWeakPtr();
  for (auto id : ids) {
    Cancel(id, "navigation_started");
    if (!weak)
      return;
  }
}
void PageRequests::DidFinishNavigation(content::NavigationHandle* navigation) {
  if (!navigation->HasCommitted() || navigation->IsSameDocument())
    return;
  if (navigation->IsInPrimaryMainFrame())
    fullscreen_ = false;
  if (find_pending_ && !Live(find_document_.AsRenderFrameHostIfValid())) {
    auto event = Kind("find_cancelled");
    event.Set("find_request", find_request_id_);
    event.Set("reason", "document_invalidated");
    Event(std::move(event));
    find_pending_ = false;
    find_request_id_ = -1;
    find_document_ = {};
  }
  Prune();
}
void PageRequests::RenderFrameDeleted(content::RenderFrameHost* frame) {
  std::vector<std::uint64_t> ids;
  for (const auto& [id, request] : pending_)
    if (request->document.AsRenderFrameHostIfValid() == frame ||
        !request->document.AsRenderFrameHostIfValid())
      ids.push_back(id);
  auto weak = weak_factory_.GetWeakPtr();
  for (auto id : ids) {
    Cancel(id, "frame_deleted");
    if (!weak)
      return;
  }
}
void PageRequests::WebContentsDestroyed() {
  fullscreen_ = false;
  Observe(nullptr);
  CancelAll("contents_destroyed");
}
void PageRequests::DidReceiveFindReply(int request_id,
                                       int matches,
                                       const gfx::Rect& rect,
                                       int active,
                                       bool final_update) {
  if (request_id != find_request_id_ || !Live(find_document_.AsRenderFrameHostIfValid()))
    return;
  if (final_update)
    find_pending_ = false;
  auto event = Kind("find_result");
  event.Set("find_request", request_id);
  event.Set("matches", matches);
  event.Set("active_match", active);
  event.Set("final", final_update);
  base::DictValue selection;
  selection.Set("x_dip", rect.x());
  selection.Set("y_dip", rect.y());
  selection.Set("width_dip", rect.width());
  selection.Set("height_dip", rect.height());
  event.Set("selection_rect", std::move(selection));
  Event(std::move(event));
}

}  // namespace remotekit::browser
