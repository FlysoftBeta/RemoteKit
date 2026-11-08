#include "browser/page_requests.h"
#include "browser/browser_context.h"
#include "browser/site_preferences.h"
#include "browser/profile_services.h"
#include "browser/file_chooser_accept.h"

#include <cmath>
#include <set>
#include "third_party/blink/public/mojom/window_features/window_features.mojom.h"
#include "base/no_destructor.h"
#include "content/public/browser/media_stream_request.h"
#include "content/public/browser/select_audio_output_request.h"
#include "content/public/browser/render_view_host.h"
#include "content/public/browser/render_widget_host.h"
#include "third_party/blink/public/mojom/manifest/display_mode.mojom.h"
#include "third_party/blink/public/mojom/mediastream/media_stream.mojom.h"
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
#include "content/public/browser/file_select_listener.h"
#include "content/public/browser/host_zoom_map.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_handle.h"
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
std::set<PageRequests*>& BoundPages() {
  static base::NoDestructor<std::set<PageRequests*>> pages;
  return *pages;
}
void SyncDisplayMode(content::WebContents* contents) {
  contents->ForEachRenderFrameHost([](content::RenderFrameHost* frame) {
    frame->GetRenderViewHost()->GetWidget()->SynchronizeVisualProperties();
  });
}
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
bool ValidSelectionId(const std::string* selection_id) {
  return selection_id && !selection_id->empty() && selection_id->size() <= 128 &&
         selection_id->find_first_not_of(
             "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-") ==
             std::string::npos;
}
base::DictValue InputAnchor(const blink::mojom::FileChooserInputAnchor& anchor,
                            const PageRequests::AnchorLayout& layout) {
  // Bounds and viewport are page DIPs; the renderer scale is the original virtual screen scale,
  // not the emulated page scale.
  if (!std::isfinite(layout.device_scale_factor) || layout.device_scale_factor <= 0) {
    return {};
  }
  const auto& bounds = anchor.bounds;
  const auto& viewport = anchor.viewport;
  if (!std::isfinite(bounds.x()) || !std::isfinite(bounds.y()) || !std::isfinite(bounds.width()) ||
      !std::isfinite(bounds.height()) || !std::isfinite(viewport.width()) ||
      !std::isfinite(viewport.height()) || bounds.IsEmpty() || viewport.IsEmpty() ||
      bounds.x() < 0 || bounds.y() < 0 || bounds.right() > viewport.width() + 0.01f ||
      bounds.bottom() > viewport.height() + 0.01f ||
      std::abs(viewport.width() - layout.width) > 1.f ||
      std::abs(viewport.height() - layout.height) > 1.f) {
    return {};
  }
  base::DictValue result;
  result.Set("x", bounds.x());
  result.Set("y", bounds.y());
  result.Set("width", bounds.width());
  result.Set("height", bounds.height());
  result.Set("viewportWidth", viewport.width());
  result.Set("viewportHeight", viewport.height());
  result.Set("deviceScaleFactor", layout.device_scale_factor);
  result.Set("instance", base::NumberToString(layout.instance));
  result.Set("document", base::NumberToString(layout.document));
  result.Set("layoutGeneration", base::NumberToString(layout.generation));
  return result;
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
  enum class Type { dialog, file, permission, http_auth, repost, protocol_handler };
  Type type = Type::dialog;
  content::WeakDocumentPtr document;
  base::DictValue data;
  DialogClosedCallback dialog;
  AuthCallback auth;
  std::vector<base::OnceCallback<void(const std::string&)>> permissions;
  scoped_refptr<content::FileSelectListener> file;
  blink::mojom::FileChooserParams::Mode mode = blink::mojom::FileChooserParams::Mode::kOpen;
  bool validating = false;
  std::string selection_id;
  SelectionBinding selection_binding;
};

PageRequests* PageRequests::ForContents(content::WebContents* contents) {
  for (auto* page : BoundPages())
    if (page->web_contents() == contents)
      return page;
  return nullptr;
}
void PageRequests::SitePreferencesChanged(content::BrowserContext* context) {
  std::vector<base::WeakPtr<PageRequests>> pages;
  for (auto* page : BoundPages())
    if (page->web_contents()->GetBrowserContext() == context)
      pages.push_back(page->GetWeakPtr());
  for (auto& page : pages)
    if (page)
      page->ResolveStoredDecisions();
}
void PageRequests::ResolveStoredDecisions() {
  auto* context = static_cast<BrowserContext*>(web_contents()->GetBrowserContext());
  std::vector<std::pair<std::uint64_t, base::DictValue>> replies;
  for (const auto& [id, pending] : pending_) {
    const auto* origin = pending->data.FindString("origin");
    const auto* site = origin ? context->site_preferences().FindDict(*origin) : nullptr;
    if (!site)
      continue;
    base::DictValue reply;
    reply.Set("request", base::NumberToString(id));
    if (pending->type == Pending::Type::permission) {
      const auto* permissions = site->FindDict("permissions");
      const auto& names = *pending->data.FindList("permissions");
      const auto* setting =
          permissions ? permissions->FindString(names.front().GetString()) : nullptr;
      if (!setting)
        continue;
      reply.Set("decision", *setting);
    } else if (pending->type == Pending::Type::protocol_handler) {
      const auto* handlers = site->FindList("protocolHandlers");
      bool stored = false;
      if (handlers)
        for (const auto& value : *handlers) {
          const auto& handler = value.GetDict();
          if (*handler.FindString("protocol") == *pending->data.FindString("protocol") &&
              *handler.FindString("url") == *pending->data.FindString("url")) {
            reply.Set("accept", *handler.FindBool("allowed"));
            stored = true;
            break;
          }
        }
      if (!stored)
        continue;
    } else {
      continue;
    }
    replies.emplace_back(id, std::move(reply));
  }
  auto weak = GetWeakPtr();
  for (auto& [id, reply] : replies) {
    Reply(reply, {});
    if (!weak)
      return;
  }
}
void PageRequests::RequestPermission(content::RenderFrameHost* frame,
                                     const std::vector<std::string>& permissions,
                                     base::OnceCallback<void(const std::string&)> callback) {
  for (auto& [id, request] : pending_) {
    if (request->type == Pending::Type::permission &&
        request->document.AsRenderFrameHostIfValid() == frame &&
        request->data.FindList("permissions")->front().GetString() == permissions.front()) {
      request->permissions.push_back(std::move(callback));
      return;
    }
  }
  auto pending = std::make_unique<Pending>();
  pending->type = Pending::Type::permission;
  pending->document = frame->GetWeakDocumentPtr();
  pending->data = Kind("permission");
  pending->data.Set("origin", frame->GetLastCommittedOrigin().Serialize());
  pending->data.Set("embedding_origin",
                    frame->GetOutermostMainFrame()->GetLastCommittedOrigin().Serialize());
  base::ListValue names;
  for (const auto& name : permissions)
    names.Append(name);
  pending->data.Set("permissions", std::move(names));
  pending->permissions.push_back(std::move(callback));
  Add(std::move(pending));
}
std::uint64_t PageRequests::RequestAuth(base::DictValue data, AuthCallback callback) {
  auto pending = std::make_unique<Pending>();
  pending->type = Pending::Type::http_auth;
  pending->document = web_contents()->GetPrimaryMainFrame()->GetWeakDocumentPtr();
  pending->data = std::move(data);
  pending->auth = std::move(callback);
  return Add(std::move(pending));
}
void PageRequests::CancelRequest(std::uint64_t id) {
  Cancel(id, "request_cancelled");
}
void PageRequests::RegisterProtocolHandler(content::RenderFrameHost* frame,
                                           const std::string& protocol,
                                           const GURL& url,
                                           bool user_gesture) {
  if (!Live(frame) || !user_gesture ||
      !ValidProtocolHandler(frame->GetLastCommittedOrigin().Serialize(), protocol, url.spec()))
    return;
  const auto* site = static_cast<BrowserContext*>(web_contents()->GetBrowserContext())
                         ->site_preferences()
                         .FindDict(frame->GetLastCommittedOrigin().Serialize());
  const auto* handlers = site ? site->FindList("protocolHandlers") : nullptr;
  if (handlers)
    for (const auto& value : *handlers) {
      const auto& handler = value.GetDict();
      if (*handler.FindString("protocol") == protocol && *handler.FindString("url") == url.spec())
        return;
    }
  auto pending = std::make_unique<Pending>();
  pending->type = Pending::Type::protocol_handler;
  pending->document = frame->GetWeakDocumentPtr();
  pending->data = Kind("protocol_handler");
  pending->data.Set("origin", frame->GetLastCommittedOrigin().Serialize());
  pending->data.Set("protocol", protocol);
  pending->data.Set("url", url.spec());
  Add(std::move(pending));
}
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
  BoundPages().erase(this);
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
  if (target) {
    target->SetDelegate(this);
    BoundPages().insert(this);
  }
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
void PageRequests::BeforeUnloadFired(content::WebContents*,
                                     bool proceed,
                                     bool* proceed_to_fire_unload) {
  *proceed_to_fire_unload = proceed;
  if (close_state_ == "closing" && !proceed)
    close_state_ = "cancelled";
}
void PageRequests::CloseContents(content::WebContents*) {
  if (close_state_ != "closing")
    close_reason_ = "window.close";
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
    if (request->file)
      request->file->FileSelectionCanceled();
    for (auto& permission : request->permissions)
      std::move(permission).Run("dismiss");
    if (request->auth)
      std::move(request->auth).Run(false, {}, {});
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
  if (request->file)
    FileResult(id, "cancelled", *request, reason);
  if (request->file)
    request->file->FileSelectionCanceled();
  for (auto& permission : request->permissions)
    std::move(permission).Run("dismiss");
  if (request->auth)
    std::move(request->auth).Run(false, {}, {});
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
void PageRequests::FileResult(std::uint64_t id,
                              const char* state,
                              const Pending& request,
                              const std::string& error) {
  auto result = Result();
  result.Set("state", state);
  if (!request.selection_id.empty())
    result.Set("selection_id", request.selection_id);
  if (!error.empty())
    result.Set("error", Clip(error));
  file_results_.insert_or_assign(id, FileReceipt{std::move(result), request.selection_binding});
  while (file_results_.size() > kLimit)
    file_results_.erase(file_results_.begin());
}
base::DictValue PageRequests::FileStatus(const std::string& key,
                                         const std::string* selection_id,
                                         SelectionBinding binding,
                                         bool terminal_only) {
  if (selection_id && !ValidSelectionId(selection_id))
    return Result("invalid_selection_id");
  const auto weak = weak_factory_.GetWeakPtr();
  if (!terminal_only)
    Prune();
  if (!weak)
    return Result("manager_destroyed");
  std::uint64_t id = 0;
  if (!base::StringToUint64(key, &id) || base::NumberToString(id) != key)
    return Result("invalid_file_request");
  const auto found = pending_.find(id);
  if (!terminal_only && found != pending_.end()) {
    if (!found->second->file)
      return Result("file_request_required");
    if (selection_id && found->second->validating &&
        (found->second->selection_id != *selection_id ||
         found->second->selection_binding != binding))
      return Result("unknown_file_request");
    auto result = Result();
    result.Set("state", found->second->validating ? "validating" : "pending");
    if (!found->second->selection_id.empty())
      result.Set("selection_id", found->second->selection_id);
    return result;
  }
  const auto completed = file_results_.find(id);
  if (completed == file_results_.end())
    return Result(terminal_only ? "stale_page_request_target" : "unknown_file_request");
  const auto* completed_selection = completed->second.result.FindString("selection_id");
  if (selection_id && (!completed_selection || *completed_selection != *selection_id ||
                       completed->second.binding != binding))
    return Result(terminal_only ? "stale_page_request_target" : "unknown_file_request");
  return completed->second.result.Clone();
}
base::DictValue PageRequests::Snapshot(const AnchorLayout* anchor_layout) {
  auto weak = weak_factory_.GetWeakPtr();
  Prune();
  if (!weak)
    return Result("manager_destroyed");
  base::DictValue result;
  base::ListValue pending;
  for (const auto& [id, request] : pending_) {
    auto data = request->data.Clone();
    if (anchor_layout && request->file && web_contents() &&
        request->document.AsRenderFrameHostIfValid() == web_contents()->GetPrimaryMainFrame()) {
      if (const auto* anchor = request->file->GetInputAnchor()) {
        auto value = InputAnchor(*anchor, *anchor_layout);
        if (!value.empty())
          data.Set("input_anchor", std::move(value));
      }
    }
    pending.Append(std::move(data));
  }
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
    return Reply(reply, {}).FindBool("ok").value_or(false);
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
  auto accepts = ExportFileChooserAcceptHints(params.accept_types);
  request->data.Set("accept_types", std::move(accepts.types));
  request->data.Set("accept_types_omitted", accepts.omitted);
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
bool PageRequests::CanEnterFullscreenModeForTab(content::RenderFrameHost*) {
  return true;
}
void PageRequests::EnterFullscreenModeForTab(content::RenderFrameHost* frame,
                                             const blink::mojom::FullscreenOptions&) {
  fullscreen_ = true;
  SyncDisplayMode(web_contents());
  auto event = Kind("fullscreen");
  event.Set("active", true);
  event.Set("native_host_fullscreen", false);
  event.Set("origin", frame ? Clip(frame->GetLastCommittedOrigin().Serialize()) : "");
  Event(std::move(event));
}
void PageRequests::ExitFullscreenModeForTab(content::WebContents*) {
  fullscreen_ = false;
  SyncDisplayMode(web_contents());
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
  if (popup_handler_)
    return false;
  auto event = Kind("blocked_popup");
  event.Set("url", Clip(target_url.spec()));
  event.Set("reason", "dynamic_webview_creation_unsupported");
  Event(std::move(event));
  return true;
}
content::WebContents* PageRequests::AddNewContents(content::WebContents*,
                                                   std::unique_ptr<content::WebContents> contents,
                                                   const GURL& url,
                                                   WindowOpenDisposition disposition,
                                                   const blink::mojom::WindowFeatures&,
                                                   bool user_gesture,
                                                   bool* was_blocked) {
  if (!popup_handler_ || !user_gesture) {
    if (was_blocked)
      *was_blocked = true;
    auto event = Kind("blocked_popup");
    event.Set("url", Clip(url.spec()));
    event.Set("reason", "user_gesture_required");
    Event(std::move(event));
    return nullptr;
  }
  auto* adopted = popup_handler_(std::move(contents), url, disposition, user_gesture);
  if (!adopted && was_blocked)
    *was_blocked = true;
  return adopted;
}

content::WebContents* PageRequests::OpenURLFromTab(
    content::WebContents* source,
    const content::OpenURLParams& params,
    base::OnceCallback<void(content::NavigationHandle&)> callback) {
  content::WebContents* target = source;
  if (params.disposition != WindowOpenDisposition::CURRENT_TAB) {
    switch (params.disposition) {
      case WindowOpenDisposition::NEW_FOREGROUND_TAB:
      case WindowOpenDisposition::NEW_BACKGROUND_TAB:
      case WindowOpenDisposition::NEW_WINDOW:
      case WindowOpenDisposition::NEW_POPUP:
        break;
      default:
        return nullptr;
    }
    if (!popup_handler_)
      return nullptr;
    content::WebContents::CreateParams create(source->GetBrowserContext());
    create.initially_hidden = true;
    auto contents = content::WebContents::Create(create);
    target = AddNewContents(source, std::move(contents), params.url, params.disposition,
                            blink::mojom::WindowFeatures(), params.user_gesture, nullptr);
    if (!target)
      return nullptr;
  }
  content::NavigationController::LoadURLParams load(params);
  if (target != source)
    load.frame_tree_node_id = content::FrameTreeNodeId();
  auto navigation = target->GetController().LoadURLWithParams(load);
  if (navigation && callback)
    std::move(callback).Run(*navigation);
  return target;
}
content::WebContents* PageRequests::OpenURLFromBrowser(content::BrowserContext* context,
                                                       const content::OpenURLParams& params) {
  for (auto* page : BoundPages()) {
    if (page->web_contents()->GetBrowserContext() == context && page->popup_handler_)
      return page->OpenURLFromTab(page->web_contents(), params, {});
  }
  return nullptr;
}
void PageRequests::ShowRepostFormWarningDialog(content::WebContents* contents) {
  auto pending = std::make_unique<Pending>();
  pending->type = Pending::Type::repost;
  pending->document = contents->GetPrimaryMainFrame()->GetWeakDocumentPtr();
  pending->data = Kind("repost");
  pending->data.Set("origin",
                    contents->GetPrimaryMainFrame()->GetLastCommittedOrigin().Serialize());
  pending->dialog = base::BindOnce(
      [](base::WeakPtr<content::WebContents> contents, base::OnceCallback<void(bool)> handler,
         bool accept, const std::u16string&) {
        if (handler) {
          std::move(handler).Run(accept);
          return;
        }
        if (!contents)
          return;
        if (accept)
          contents->GetController().ContinuePendingReload();
        else
          contents->GetController().CancelPendingReload();
      },
      contents->GetWeakPtr(), std::move(repost_handler_));
  Add(std::move(pending));
}
void PageRequests::SetRepostHandler(base::OnceCallback<void(bool)> handler) {
  repost_handler_ = std::move(handler);
}
bool PageRequests::HasPendingRepost() const {
  for (const auto& [id, request] : pending_)
    if (request->type == Pending::Type::repost)
      return true;
  return false;
}
blink::mojom::DisplayMode PageRequests::GetDisplayMode(const content::WebContents*) {
  return fullscreen_ ? blink::mojom::DisplayMode::kFullscreen : blink::mojom::DisplayMode::kBrowser;
}
void PageRequests::RequestMediaAccessPermission(content::WebContents*,
                                                const content::MediaStreamRequest& request,
                                                content::MediaResponseCallback callback) {
  const bool capture = request.audio_type == blink::mojom::MediaStreamType::DEVICE_AUDIO_CAPTURE ||
                       request.video_type == blink::mojom::MediaStreamType::DEVICE_VIDEO_CAPTURE;
  std::move(callback).Run(blink::mojom::StreamDevicesSet(),
                          capture
                              ? blink::mojom::MediaStreamRequestResult::NO_HARDWARE
                              : blink::mojom::MediaStreamRequestResult::PERMISSION_DENIED_BY_USER,
                          nullptr);
}
bool PageRequests::CheckMediaAccessPermission(content::RenderFrameHost*,
                                              const url::Origin&,
                                              blink::mojom::MediaStreamType) {
  return false;
}
void PageRequests::ProcessSelectAudioOutput(const content::SelectAudioOutputRequest&,
                                            content::SelectAudioOutputCallback callback) {
  std::move(callback).Run(base::unexpected(content::SelectAudioOutputError::kUserCancelled));
}

base::DictValue PageRequests::Reply(const base::DictValue& reply, SelectionBinding binding) {
  const auto* key = reply.FindString("request");
  const auto accept = reply.FindBool("accept");
  std::uint64_t id = 0;
  if (!key || key->size() > 20 || !base::StringToUint64(*key, &id) ||
      base::NumberToString(id) != *key)
    return Result("request_required");
  auto found = pending_.find(id);
  if (found == pending_.end()) {
    const auto receipt = reply_results_.find(id);
    if (receipt != reply_results_.end() &&
        Live(receipt->second.document.AsRenderFrameHostIfValid()) &&
        ((!receipt->second.decision.empty() && reply.FindString("decision") &&
          *reply.FindString("decision") == receipt->second.decision) ||
         (receipt->second.accept.has_value() && accept == receipt->second.accept)))
      return Result();
    return Result("unknown_or_finished_request");
  }
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
  if (request->type == Pending::Type::permission) {
    const auto* decision = reply.FindString("decision");
    if (!decision || reply.contains("accept") ||
        (*decision != "allow" && *decision != "allow_once" && *decision != "block" &&
         *decision != "dismiss"))
      return Result("invalid_permission_decision");
    auto completed = std::move(found->second);
    pending_.erase(found);
    reply_results_.insert_or_assign(id, ReplyReceipt{completed->document, *decision, {}});
    while (reply_results_.size() > kLimit)
      reply_results_.erase(reply_results_.begin());
    for (auto& permission : completed->permissions)
      std::move(permission).Run(*decision);
    return Result();
  }
  if (!accept.has_value())
    return Result("accept_required");
  if (request->type == Pending::Type::protocol_handler) {
    reply_results_.insert_or_assign(id, ReplyReceipt{request->document, {}, accept});
    while (reply_results_.size() > kLimit)
      reply_results_.erase(reply_results_.begin());
  }
  if (request->type == Pending::Type::http_auth && *accept) {
    const auto* username = reply.FindString("username");
    const auto* password = reply.FindString("password");
    if (!username || !password || username->size() > 1024 || password->size() > 1024 ||
        !base::IsStringUTF8(*username) || !base::IsStringUTF8(*password))
      return Result("invalid_credentials");
    auto completed = std::move(found->second);
    pending_.erase(found);
    std::move(completed->auth).Run(true, *username, *password);
    return Result();
  }
  if (!*accept) {
    Cancel(id, "remote_rejected");
    return Result();
  }
  if (request->validating)
    return Result("reply_already_validating");
  if (request->type == Pending::Type::file) {
    const auto* selection = reply.Find("selection_id");
    const auto* selection_id = selection ? selection->GetIfString() : nullptr;
    if (selection && !ValidSelectionId(selection_id))
      return Result("invalid_selection_id");
    const auto* values = reply.FindList("files");
    const bool multiple = request->mode == blink::mojom::FileChooserParams::Mode::kOpenMultiple;
    if (!values || values->empty() || values->size() > kLimit || (!multiple && values->size() != 1))
      return Result("invalid_file_count");
    std::vector<SelectedFile> paths;
    for (const auto& value : *values) {
      const auto* file = value.GetIfDict();
      const auto* path = file ? file->FindString("path") : nullptr;
      const auto* display = file ? file->FindString("displayName") : nullptr;
      if (!path || path->empty() || path->size() > kStringLimit ||
          path->find('\0') != std::string::npos || !base::IsStringUTF8(*path))
        return Result("invalid_file_path");
      auto native = base::FilePath::FromUTF8Unsafe(*path);
      if (!native.IsAbsolute())
        return Result("file_path_must_be_absolute");
      if (!display || display->empty() || display->size() > 1024 || !base::IsStringUTF8(*display) ||
          display->find_first_of("/\\:\0", 0, 4) != std::string::npos || *display == "." ||
          *display == "..")
        return Result("invalid_file_display_name");
      paths.push_back({std::move(native), base::UTF8ToUTF16(*display)});
    }
    if (selection_id) {
      request->selection_id = *selection_id;
      request->selection_binding = binding;
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
    if (selection_id)
      result.Set("selection_id", *selection_id);
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
  auto completed = std::move(found->second);
  pending_.erase(found);
  auto event = Kind("request_replied");
  event.Set("request", base::NumberToString(id));
  event.Set("state", completed->type == Pending::Type::dialog ? "resolved" : "submitted");
  Event(std::move(event));
  if (completed->dialog)
    std::move(completed->dialog).Run(true, text);
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
  FileResult(id, "selected", *request);
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
  if (*action == "find") {
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
  static_cast<ProfilePermissions*>(
      web_contents()->GetBrowserContext()->GetPermissionControllerDelegate())
      ->NavigationCommitted(navigation);
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
  static_cast<ProfilePermissions*>(
      web_contents()->GetBrowserContext()->GetPermissionControllerDelegate())
      ->DocumentDestroyed(frame);
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
  BoundPages().erase(this);
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
