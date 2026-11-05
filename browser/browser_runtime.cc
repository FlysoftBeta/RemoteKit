#include "remotekit/browser/browser_runtime.h"
#include "remotekit/browser/audio_target.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <map>
#include <set>
#include <string_view>
#include "base/base64.h"
#include "base/command_line.h"
#include "base/functional/bind.h"
#include "base/run_loop.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "base/task/current_thread.h"
#include "base/timer/timer.h"
#include "base/unguessable_token.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/browser_task_traits.h"
#include "content/public/browser/browser_thread.h"
#include "components/headless/clipboard/headless_clipboard.h"
#include "ui/base/clipboard/clipboard.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_process_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_delegate.h"
#include "remotekit/browser/browser_context.h"
#include "remotekit/browser/control_server.h"
#include "remotekit/browser/osr_renderer.h"
#include "remotekit/browser/page_requests.h"
#include "remotekit/browser/offscreen_host.h"
#include "remotekit/browser/webview.h"
#include "remotekit/browser/view_model.h"
#include "remotekit/endpoint/include/remotekit/atlas_dimensions.hpp"
#include "remotekit/protocol/control.h"
#include "ui/display/screen.h"
#include "url/gurl.h"

namespace remotekit::browser {
static_assert(static_cast<int>(Error::busy) == protocol::kBusyError);
namespace {
// Keep the IO clipboard installed until the IO loop itself is destroyed, so
// late Chromium teardown cannot lazily recreate the Windows clipboard.
class ServiceIoClipboard final : public base::CurrentThread::DestructionObserver {
 public:
  ServiceIoClipboard() {
    headless::SetHeadlessClipboardForCurrentThread();
    base::CurrentThread::Get()->AddDestructionObserver(this);
  }
  void WillDestroyCurrentMessageLoop() override {
    ui::Clipboard::DestroyClipboardForCurrentThread();
    base::CurrentThread::Get()->RemoveDestructionObserver(this);
    delete this;
  }
};
}  // namespace

struct RemoteKitMainParts::State {
  ~State() {
    // PostMainMessageLoopRun also runs after a partial PreMain startup failure.
    // Contexts must never be left to implicit member destruction order.
    CHECK(pending_popups.empty());
    CHECK(contents.empty());
    CHECK(contexts.empty());
  }
  bool shutting_down = false;
  std::unique_ptr<display::Screen> screen;
  ViewModel view_model;
  struct ViewSpec {
    int width = 480, height = 360;
    std::string url;
    bool visible = true;
    float page_dsf = 0;
    bool operator==(const ViewSpec&) const = default;
  };
  std::vector<ViewSpec> specs;
  float PageScale(const ViewSpec& spec) const {
    return spec.page_dsf > 0 ? spec.page_dsf : output_scale;
  }
  std::map<WebViewId, base::DictValue> closed_views;
  // ACK removes the replay payload, while the compact identity set prevents
  // a delayed create request from resurrecting a closed view in this process.
  std::set<WebViewId> retired_views;
  Result<Atlas> Layout(const std::vector<ViewSpec>& next,
                       WebViewId extra = 0,
                       int width = 0,
                       int height = 0) {
    std::vector<PackItem> items;
    for (size_t i = 0; i < next.size(); ++i) {
      if (!next[i].visible)
        continue;
      items.push_back({i < contents.size() ? contents[i]->view_id() : extra, next[i].width,
                       next[i].height, 1.0});
    }
    return PackAtlas(width ? width : logical_width, height ? height : logical_height, 4,
                     OrderAtlasItems(std::move(items)));
  }
  void ApplyLayout(const Atlas& atlas) {
    placements.clear();
    for (size_t i = 0; i < contents.size(); ++i) {
      const auto found =
          std::ranges::find(atlas.placements, contents[i]->view_id(), &Placement::view);
      const bool visible = found != atlas.placements.end();
      contents[i]->InvalidateLayoutInput(visible);
      const auto rect = visible ? found->content : PixelRect{0, 0, specs[i].width, specs[i].height};
      CHECK(contents[i]->SetVisible(visible));
      placements.emplace_back(rect.x, rect.y, rect.width, rect.height);
      contents[i]->ConfigureDevice(specs[i].width, specs[i].height, PageScale(specs[i]));
    }
    UpdateOutput();
  }
  void RemoveView(size_t index) {
    const auto session = contents[index]->session_id();
    const auto view = contents[index]->view_id();
    base::DictValue tombstone;
    tombstone.Set("view", base::NumberToString(view));
    tombstone.Set("session", base::NumberToString(session));
    tombstone.Set("close_state", "closed");
    tombstone.Set("close_reason", page_requests[index]->close_reason());
    closed_views.insert_or_assign(view, std::move(tombstone));
    retired_views.insert(view);
    std::erase_if(adopted_popups, [view](const auto& item) { return item.second == view; });
    if (output)
      output->StopView(view);
    paused_output.insert(view);
    UpdateOutput();
    page_requests[index]->Bind(nullptr);
    page_requests.erase(page_requests.begin() + index);
    contents.erase(contents.begin() + index);
    specs.erase(specs.begin() + index);
    placements.erase(placements.begin() + index);
    transfers.erase(view);
    paused_output.erase(view);
    view_model.RemoveWebView(session, view);
    auto layout = Layout(specs);
    if (layout)
      ApplyLayout(layout.value);
  }
  void DrainClosed() {
    PrunePopups();
    for (size_t i = contents.size(); i > 0; --i)
      if (page_requests[i - 1]->close_state() == "closed")
        RemoveView(i - 1);
  }
  SessionId session_id = 0;
  struct PendingPopup {
    SessionId session;
    WebViewId opener;
    GURL url;
    WindowOpenDisposition disposition;
    bool user_gesture;
    base::TimeTicks deadline;
    std::string status = "pending";
    std::unique_ptr<content::WebContents> contents;
    std::unique_ptr<PageRequests> requests;
  };
  std::map<std::string, PendingPopup> pending_popups;
  std::map<std::string, WebViewId> adopted_popups;
  void PrunePopups() {
    for (auto& [key, popup] : pending_popups) {
      if (popup.status != "pending")
        continue;
      const bool closed = popup.requests->close_state() == "closed";
      if (!closed && base::TimeTicks::Now() < popup.deadline)
        continue;
      popup.status = closed ? "closed" : "timed_out";
      popup.requests.reset();
      popup.contents.reset();
      popup.deadline = base::TimeTicks::Now() + base::Seconds(30);
    }
    std::erase_if(pending_popups, [](const auto& entry) {
      return entry.second.status != "pending" && base::TimeTicks::Now() >= entry.second.deadline;
    });
  }
  void WirePopups(PageRequests* requests, SessionId session, WebViewId opener) {
    requests->SetPopupHandler([this, session, opener](std::unique_ptr<content::WebContents> page,
                                                      const GURL& url,
                                                      WindowOpenDisposition disposition,
                                                      bool gesture) -> content::WebContents* {
      if (shutting_down)
        return nullptr;
      PrunePopups();
      if (pending_popups.size() >= 16 || !gesture)
        return nullptr;
      const auto key = base::UnguessableToken::Create().ToString();
      PendingPopup popup{session,     opener,  url,
                         disposition, gesture, base::TimeTicks::Now() + base::Seconds(30)};
      popup.contents = std::move(page);
      popup.contents->WasHidden();
      popup.requests = std::make_unique<PageRequests>();
      popup.requests->Bind(popup.contents.get());
      auto* result = popup.contents.get();
      pending_popups.emplace(key, std::move(popup));
      return result;
    });
  }
  std::vector<ProfileId> profiles;
  std::vector<std::unique_ptr<BrowserContext>> contexts;
  std::vector<std::unique_ptr<PageRequests>> page_requests;
  std::vector<std::unique_ptr<WebView>> contents;
  std::unique_ptr<ControlServer> control;
  std::unique_ptr<OsrRenderer> output;
  base::RepeatingTimer output_timer;
  std::vector<gfx::Rect> placements;
  std::set<WebViewId> paused_output;
  float output_scale = 1;
  uint32_t allocation_alignment = 1;
  bool output_enabled = true;
  int logical_width = 0, logical_height = 0;
  uint32_t output_width = 0, output_height = 0;
  uint64_t output_generation = 0;
  struct Transfer {
    uint64_t id = 0, instance = 0, document = 0;
    size_t total = 0;
    bool importing = false;
    std::string data;
  };
  std::map<WebViewId, Transfer> transfers;
  uint64_t next_transfer = 1;
  base::RepeatingClosure quit;

  base::DictValue HandleControl(const base::DictValue& request);
  Status CanDiscard(size_t index) const {
    if (page_requests[index]->close_state() == "closing" ||
        page_requests[index]->close_state() == "closed")
      return {Error::unavailable, "WebView is closing"};
    if (page_requests[index]->pending_count())
      return {Error::busy, "Page request pending"};
    return contents[index]->CanDiscard();
  }
  void UpdateOutput() {
    for (size_t i = 0; i < contents.size(); ++i) {
      const auto& adapter = contents[i];
      if (adapter->offscreen_host())
        adapter->offscreen_host()->SetOutputScale(output_scale);
      adapter->RefreshBackingScale();
      const auto* model = view_model.FindWebView(adapter->session_id(), adapter->view_id());
      adapter->SetRenderDemand(output && output_enabled && specs[i].visible && model &&
                               model->actual == Residency::live && !model->pending &&
                               !paused_output.contains(adapter->view_id()));
    }
    if (!output)
      return;
    std::vector<OsrRenderer::View> views;
    for (size_t i = 0; i < contents.size(); ++i) {
      if (!specs[i].visible)
        continue;
      auto& adapter = *contents[i];
      const auto token = view_model.Token(adapter.session_id(), adapter.view_id());
      const auto* model = view_model.FindWebView(adapter.session_id(), adapter.view_id());
      if (!token || !model)
        continue;
      const auto& p = placements[i];
      OsrRenderer::View view;
      view.metadata.session_id = token.value.session;
      view.metadata.webview_id = token.value.view;
      view.metadata.instance_generation = token.value.instance;
      view.metadata.document_generation = token.value.document;
      view.metadata.focus_generation = token.value.focus;
      view.metadata.x_pixels = std::lround(p.x() * output_scale);
      view.metadata.y_pixels = std::lround(p.y() * output_scale);
      view.metadata.width_pixels = std::lround(p.right() * output_scale) - view.metadata.x_pixels;
      view.metadata.height_pixels = std::lround(p.bottom() * output_scale) - view.metadata.y_pixels;
      view.metadata.atlas_pixels_per_dip = output_scale;
      view.metadata.page_device_scale_factor = PageScale(specs[i]);
      view.metadata.text_input = adapter.TextInputState();
      view.offscreen_host = adapter.offscreen_host();
      view.render_enabled = adapter.contents() && model->actual == Residency::live &&
                            !model->pending && output_enabled &&
                            !paused_output.contains(adapter.view_id());
      views.push_back(std::move(view));
    }
    output->SetViews(std::move(views));
  }
  mojo::ScopedMessagePipeHandle TakeControlAttachment(const base::DictValue& request,
                                                      const base::DictValue& reply) {
    uint64_t pid = 0;
    const auto* token = reply.FindString("render_channel");
    const auto* pid_text = request.FindString("consumer_pid");
    if (!output || !token || !pid_text || !base::StringToUint64(*pid_text, &pid) || !pid ||
        pid > UINT32_MAX)
      return {};
    return output->TakeRenderEndpoint(*token, static_cast<uint32_t>(pid));
  }
  void OnControlClosed() {
    if (shutting_down)
      return;
    output_enabled = false;
    for (const auto& adapter : contents)
      adapter->SetRenderDemand(false);
    if (output)
      output->Stop();
    for (size_t i = 0; i < contents.size(); ++i) {
      page_requests[i]->CancelAll("control_disconnected");
      contents[i]->Focus(false);
    }
    transfers.clear();
  }
};

namespace {
bool ReadId(const base::DictValue& object, std::string_view key, uint64_t* value) {
  const auto* text = object.FindString(key);
  return text && base::StringToUint64(*text, value) && *value != 0;
}
base::DictValue TokenValue(const InputToken& token) {
  base::DictValue value;
  value.Set("session", base::NumberToString(token.session));
  value.Set("view", base::NumberToString(token.view));
  value.Set("instance", base::NumberToString(token.instance));
  value.Set("document", base::NumberToString(token.document));
  value.Set("focus", base::NumberToString(token.focus));
  return value;
}
std::optional<double> Number(const base::DictValue& object, std::string_view key) {
  const auto* value = object.Find(key);
  if (value && value->is_int())
    return value->GetInt();
  if (value && value->is_double())
    return value->GetDouble();
  return std::nullopt;
}
}  // namespace

base::DictValue RemoteKitMainParts::State::HandleControl(const base::DictValue& request) {
  const int id = request.FindInt("id").value_or(0);
  base::DictValue reply;
  reply.Set("version", 1);
  reply.Set("id", id);
  reply.Set("ok", false);
  auto error = [&](std::string message) {
    reply.Set("error", std::move(message));
    return std::move(reply);
  };
  const auto* method = request.FindString("method");
  if (id <= 0 || request.FindInt("version") != 1 || !method)
    return error("invalid_envelope");
  if (*method == "shutdown") {
    reply.Set("ok", true);
    reply.Set("accepted", true);
    if (quit)
      base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(FROM_HERE, quit);
    return reply;
  }
  if (*method == "output.configure") {
    auto scale = Number(request, "device_scale");
    int next_width = logical_width, next_height = logical_height;
    for (const auto& [name, target] :
         {std::pair{"width", &next_width}, std::pair{"height", &next_height}}) {
      if (!request.Find(name))
        continue;
      const auto value = request.FindInt(name);
      if (!value || *value < 16 || *value > 16384)
        return error("invalid_atlas_dimensions");
      *target = *value;
    }
    if (output && (next_width != logical_width || next_height != logical_height))
      return error("close_output_before_size_change");
    // Source geometry and output extent are one transaction. In particular,
    // neither the old nor new layout must fit a max(old,new) intermediate atlas.
    auto next_specs = specs;
    if (request.Find("viewConfigs")) {
      if (output)
        return error("close_output_before_view_transaction");
      const auto* configs = request.FindList("viewConfigs");
      if (!configs || configs->size() > kSharedAtlasMaxViews)
        return error("invalid_view_configs");
      std::set<uint64_t> configured;
      for (const auto& value : *configs) {
        const auto* config = value.GetIfDict();
        uint64_t session = 0, view = 0;
        if (!config || !ReadId(*config, "session", &session) || !ReadId(*config, "view", &view) ||
            !configured.insert(view).second)
          return error("invalid_or_duplicate_view_identity");
        size_t index = 0;
        while (index < contents.size() && contents[index]->view_id() != view)
          ++index;
        if (index == contents.size() || contents[index]->session_id() != session)
          return error("view_transaction_identity_mismatch");
        auto& spec = next_specs[index];
        const auto width = config->FindInt("width"), height = config->FindInt("height");
        const auto* device = config->FindString("device");
        const auto page_scale = Number(*config, "device_scale_factor");
        const auto visible = config->FindBool("visible");
        if (!width || !height || *width < 1 || *height < 1 || *width > 8192 || *height > 8192 ||
            !device || (*device != "desktop" && *device != "tablet") || !page_scale ||
            !std::isfinite(*page_scale) || *page_scale < .5 || *page_scale > 4 ||
            !visible.has_value())
          return error("invalid_view_transaction_configuration");
        spec.width = *width;
        spec.height = *height;
        spec.page_dsf = static_cast<float>(*page_scale);
        spec.visible = *visible;
        if (page_requests[index]->close_state() == "closing" && spec != specs[index])
          return error("view_closing");
      }
    }
    auto next_layout = Layout(next_specs, 0, next_width, next_height);
    if (!next_layout)
      return error("atlas_no_space");
    auto next_scale = output_scale;
    auto next_alignment = allocation_alignment;
    auto next_enabled = output_enabled;
    if (request.Find("device_scale")) {
      if (!scale || !std::isfinite(*scale) || *scale < 0.5 || *scale > 4)
        return error("invalid_device_scale");
      if (output)
        return error("close_output_before_scale_change");
      next_scale = static_cast<float>(*scale);
    }
    if (const auto* value = request.Find("allocation_alignment")) {
      if (!value->is_int() || (value->GetInt() != 1 && value->GetInt() != 16))
        return error("invalid_allocation_alignment");
      next_alignment = value->GetInt();
      if (output && next_alignment != allocation_alignment)
        return error("close_output_before_alignment_change");
    }
    if (const auto* value = request.Find("enabled")) {
      if (!value->is_bool())
        return error("enabled_boolean_required");
      next_enabled = value->GetBool();
    }
    const auto dimensions =
        AtlasAllocationDimensions(next_width, next_height, next_scale, next_alignment);
    if (!dimensions)
      return error("atlas_resource_budget_exceeded");
    // Validate the whole batch before changing geometry, focus/input tokens or
    // product visibility. A persistent view is not necessarily resident/live.
    for (size_t i = 0; i < contents.size(); ++i) {
      const auto& adapter = contents[i];
      const auto* model = view_model.FindWebView(adapter->session_id(), adapter->view_id());
      if (!model)
        return error("view_missing");
      if (next_specs[i].visible && (!adapter->contents() || adapter->lifecycle_uncertain() ||
                                    model->actual != Residency::live || model->pending))
        return error("restore_required_before_show");
    }
    const bool layout_changed = logical_width != next_width || logical_height != next_height ||
                                output_scale != next_scale || specs != next_specs;
    // Every rejection above leaves both specs and output configuration intact.
    specs = std::move(next_specs);
    logical_width = next_width;
    logical_height = next_height;
    output_scale = next_scale;
    allocation_alignment = next_alignment;
    for (size_t i = 0; i < contents.size(); ++i)
      contents[i]->ConfigureDevice(specs[i].width, specs[i].height, PageScale(specs[i]));
    output_enabled = next_enabled;
    output_width = dimensions->width;
    output_height = dimensions->height;
    if (layout_changed) {
      ApplyLayout(next_layout.value);
    }
    UpdateOutput();
    reply.Set("ok", true);
    reply.Set("allocation_alignment", static_cast<int>(allocation_alignment));
    reply.Set("width_pixels", static_cast<int>(output_width));
    reply.Set("height_pixels", static_cast<int>(output_height));
    return reply;
  }
  if (*method == "output.open" || *method == "output.describe") {
    uint64_t pid = 0;
    if (!ReadId(request, "consumer_pid", &pid) || pid > UINT32_MAX)
      return error("consumer_pid_required");
    if (*method == "output.open") {
      if (OsrRenderer::IsGpuFaultSealed())
        return error("output_gpu_fault_sealed");
      if (!output)
        output = std::make_unique<OsrRenderer>(output_width, output_height, ++output_generation);
      UpdateOutput();
      reply.Set("ok", true);
      reply.Set("accepted", true);
      return reply;
    }
    if (!output)
      return error("output_not_open");
    auto result = output->DescribeForConsumer(static_cast<uint32_t>(pid));
    if (result.FindBool("pending") == true) {
      if (const auto* detail = result.FindString("error"))
        result.Set("detail", *detail);
      result.Set("error", "output_pending");
    }
    result.Set("version", 1);
    result.Set("id", id);
    return result;
  }
  if (*method == "output.status") {
    if (!output)
      return error("output_not_open");
    reply.Set("ok", true);
    auto status = output->Status();
    status.Set("allocation_alignment", static_cast<int>(allocation_alignment));
    reply.Set("output", std::move(status));
    return reply;
  }
  if (*method == "output.close") {
    if (output) {
      output->Stop();
    }
    output.reset();
    UpdateOutput();
    reply.Set("ok", true);
    return reply;
  }
  if (*method == "audio.open") {
    uint64_t generation = 0, session = 0;
    const auto* name = request.FindString("mapping");
    if (!name || !ReadId(request, "generation", &generation) ||
        !ReadId(request, "session", &session) || session_id != session ||
        !OpenAudioTarget(*name, generation, session))
      return error("invalid_audio_target");
    reply.Set("ok", true);
    return reply;
  }
  if (*method == "audio.close") {
    CloseAudioTarget();
    reply.Set("ok", true);
    return reply;
  }
  if (*method == "view.closed.ack") {
    uint64_t session = 0;
    const auto* incarnation = request.FindString("browserIncarnation");
    const auto* ids = request.FindList("views");
    const auto current =
        base::CommandLine::ForCurrentProcess()->GetSwitchValueASCII("browser-incarnation");
    if (!ReadId(request, "session", &session) || !view_model.FindSession(session) || !incarnation ||
        current.empty() || *incarnation != current || !ids || ids->size() > 256)
      return error("invalid_closed_ack_target");
    std::vector<uint64_t> parsed;
    for (const auto& value : *ids) {
      uint64_t view = 0;
      if (!value.is_string() || !base::StringToUint64(value.GetString(), &view) || !view)
        return error("invalid_closed_ack_view");
      const auto found = closed_views.find(view);
      if (found != closed_views.end() &&
          *found->second.FindString("session") != base::NumberToString(session))
        return error("wrong_closed_ack_session");
      parsed.push_back(view);
    }
    for (auto view : parsed)
      closed_views.erase(view);
    reply.Set("ok", true);
    reply.Set("accepted", true);
    return reply;
  }
  if (*method == "snapshot") {
    base::ListValue list;
    const auto* session = view_model.FindSession(session_id);
    base::ListValue views;
    for (const auto& [view_id, model] : session->views) {
      auto value = TokenValue(view_model.Token(session_id, view_id).value);
      value.Set("profile", base::NumberToString(model.profile));
      value.Set("actual", static_cast<int>(model.actual));
      value.Set("desired", static_cast<int>(model.desired));
      value.Set("pending", model.pending.has_value());
      value.Set("focused", model.focused);
      value.Set("lifecycle_generation", base::NumberToString(model.lifecycle_generation));
      if (model.last_lifecycle) {
        base::DictValue result;
        result.Set("generation", base::NumberToString(model.last_lifecycle->generation));
        result.Set("action", static_cast<int>(model.last_lifecycle->action));
        result.Set("succeeded", model.last_lifecycle->succeeded);
        result.Set("detail", model.last_lifecycle->detail);
        value.Set("last_lifecycle", std::move(result));
      }
      for (size_t i = 0; i < contents.size(); ++i) {
        const auto& adapter = contents[i];
        if (adapter->view_id() != view_id)
          continue;
        value.Set("close_state", page_requests[i]->close_state());
        value.Set("close_reason", page_requests[i]->close_reason());
        value.Set("width", specs[i].width);
        value.Set("height", specs[i].height);
        value.Set("device", "desktop");
        value.Set("deviceScaleFactor", PageScale(specs[i]));
        auto compositor = adapter->CompositorDiagnostics();
        if (output)
          compositor.Set("osr", output->RenderStatus(view_id));
        value.Set("compositor", std::move(compositor));
        value.Set("navigationRevision", base::NumberToString(adapter->navigation_revision()));
        value.Set("navigationOperations", adapter->NavigationOperationSnapshot());
        value.Set("visible", specs[i].visible);
        value.Set("lifecycle_uncertain", adapter->lifecycle_uncertain());
        auto discard = CanDiscard(i);
        value.Set("canDiscard", static_cast<bool>(discard));
        value.Set("discardBlockReason", discard.message);
        auto touch = adapter->TouchInjectionStatus();
        value.Set("touch_code", static_cast<int>(touch.error));
        value.Set("touch_detail", touch.message);
        value.Set("pending_page_requests", static_cast<int>(page_requests[i]->pending_count()));
        if (auto* page = adapter->contents()) {
          value.Set("url", page->GetLastCommittedURL().spec());
          value.Set("title", base::UTF16ToUTF8(page->GetTitle()));
          value.Set("loading", page->IsLoading());
          value.Set("canGoBack", page->GetController().CanGoBack());
          value.Set("canGoForward", page->GetController().CanGoForward());
          value.Set("audible", page->IsCurrentlyAudible());
          value.Set("captured", page->IsBeingCaptured());
          value.Set("crashed", page->IsCrashed());
          value.Set("fullscreen", page_requests[i]->fullscreen() && !page->IsCrashed());
          std::set<base::ProcessId> pids;
          page->GetPrimaryMainFrame()->ForEachRenderFrameHost([&](content::RenderFrameHost* frame) {
            const auto& process = frame->GetProcess()->GetProcess();
            if (process.IsValid())
              pids.insert(process.Pid());
          });
          base::ListValue processes;
          for (auto pid : pids)
            processes.Append(base::NumberToString(pid));
          value.Set("renderer_pids", std::move(processes));
        }
      }
      views.Append(std::move(value));
    }
    for (const auto& [closed_view_id, tombstone] : closed_views)
      if (*tombstone.FindString("session") == base::NumberToString(session_id))
        views.Append(tombstone.Clone());
    base::DictValue session_value;
    session_value.Set("session", base::NumberToString(session_id));
    session_value.Set("tenant", session->tenant);
    session_value.Set("views", std::move(views));
    base::ListValue popups;
    for (const auto& [key, popup] : pending_popups) {
      if (popup.session != session_id)
        continue;
      base::DictValue item;
      item.Set("provisionalId", key);
      item.Set("openerViewId", base::NumberToString(popup.opener));
      item.Set("url", popup.contents && !popup.contents->GetLastCommittedURL().is_empty()
                          ? popup.contents->GetLastCommittedURL().spec()
                          : popup.url.spec());
      item.Set("disposition", static_cast<int>(popup.disposition));
      item.Set("userGesture", popup.user_gesture);
      item.Set("status", popup.status);
      popups.Append(std::move(item));
    }
    session_value.Set("pendingPopups", std::move(popups));
    list.Append(std::move(session_value));
    reply.Set("ok", true);
    reply.Set("sessions", std::move(list));
    reply.Set("clientGestures", 1);
    return reply;
  }
  if (*method == "session.sitePreferences") {
    uint64_t session = 0;
    const auto* sites = request.FindDict("sites");
    if (!ReadId(request, "session", &session) || !sites)
      return error("session_and_sites_required");
    if (session != session_id)
      return error("session_not_found");
    std::string detail;
    if (!contexts.front()->SetSitePreferences(*sites, &detail))
      return error(detail);
    reply.Set("ok", true);
    reply.Set("accepted", true);
    reply.Set("applied", true);
    return reply;
  }
  if (*method == "view.create" || *method == "view.adopt") {
    uint64_t session = 0, view = 0;
    if (!ReadId(request, "session", &session) || !ReadId(request, "view", &view) ||
        !view_model.FindSession(session) || session != session_id)
      return error("invalid_session_or_view");
    if (retired_views.contains(view))
      return error("view_id_closed");
    const bool adopting = *method == "view.adopt";
    const auto* provisional = request.FindString("provisionalId");
    if (adopting && !provisional)
      return error("provisional_id_required");
    if (adopting && adopted_popups.contains(*provisional)) {
      if (adopted_popups.at(*provisional) != view)
        return error("popup_already_adopted_elsewhere");
      reply.Set("ok", true);
      reply.Set("accepted", true);
      reply.Set("completed", true);
      reply.Set("token", TokenValue(view_model.Token(session, view).value));
      return reply;
    }
    PrunePopups();
    if (adopting && (!pending_popups.contains(*provisional) ||
                     pending_popups.at(*provisional).session != session ||
                     pending_popups.at(*provisional).status != "pending"))
      return error("popup_not_pending");
    ViewSpec spec;
    spec.width = request.FindInt("width").value_or(0);
    spec.height = request.FindInt("height").value_or(0);
    const auto* url = request.FindString("url");
    const auto* device = request.FindString("device");
    if (!url || !GURL(*url).is_valid() || spec.width < 1 || spec.height < 1 || spec.width > 8192 ||
        spec.height > 8192 || (device && *device != "desktop" && *device != "tablet") ||
        (request.Find("device") && !device))
      return error("invalid_view_configuration");
    spec.visible = request.FindBool("visible").value_or(true);
    if (request.Find("visible") && !request.Find("visible")->is_bool())
      return error("visible_boolean_required");
    if (request.Find("device_scale_factor")) {
      const auto scale = Number(request, "device_scale_factor");
      if (!scale || !std::isfinite(*scale) || *scale < 0.5 || *scale > 4)
        return error("invalid_page_device_scale_factor");
      spec.page_dsf = static_cast<float>(*scale);
    }
    spec.url = *url;
    for (size_t i = 0; i < contents.size(); ++i) {
      if (contents[i]->view_id() != view)
        continue;
      if (adopting)
        return error("view_id_already_exists");
      if (contents[i]->session_id() != session || specs[i] != spec)
        return error("view_id_configuration_conflict");
      if (request.Find("operationId")) {
        const auto status = contents[i]->Navigate(GURL(spec.url), &request);
        if (!status)
          return error(status.message);
      }
      reply.Set("ok", true);
      reply.Set("accepted", true);
      reply.Set("completed", true);
      reply.Set("token", TokenValue(view_model.Token(session, view).value));
      if (request.Find("operationId"))
        reply.Set("completed", false);
      return reply;
    }
    if (contents.size() >= kSharedAtlasMaxViews)
      return error("view_limit_reached");
    auto next = specs;
    next.push_back(spec);
    auto layout = Layout(next, view);
    if (!layout)
      return error("atlas_no_space");
    auto created = view_model.CreateWebView(session, profiles.front(), view);
    if (!created)
      return error(created.status.message);
    std::unique_ptr<content::WebContents> adopted;
    if (adopting) {
      auto& popup = pending_popups.at(*provisional);
      popup.requests->Bind(nullptr);
      popup.requests.reset();
      adopted = std::move(popup.contents);
    }
    auto adapter = std::make_unique<WebView>(contexts.front().get(), &view_model, session, view,
                                             std::move(adopted));
    adapter->ConfigureDevice(spec.width, spec.height, PageScale(spec));
    auto requests = std::make_unique<PageRequests>();
    requests->Bind(adapter->contents());
    WirePopups(requests.get(), session, view);
    contents.push_back(std::move(adapter));
    page_requests.push_back(std::move(requests));
    specs = std::move(next);
    ApplyLayout(layout.value);
    contents.back()->SetVisible(spec.visible);
    auto navigated = adopting ? Status{} : contents.back()->Navigate(GURL(spec.url), &request);
    if (!navigated) {
      RemoveView(contents.size() - 1);
      return error(navigated.message);
    }
    if (adopting) {
      adopted_popups[*provisional] = view;
      pending_popups.erase(*provisional);
    }
    reply.Set("ok", true);
    reply.Set("accepted", true);
    reply.Set("completed", true);
    reply.Set("token", TokenValue(view_model.Token(session, view).value));
    if (request.Find("operationId"))
      reply.Set("completed", false);
    return reply;
  }
  if (*method == "view.close") {
    uint64_t session = 0, view = 0;
    if (!ReadId(request, "session", &session) || !ReadId(request, "view", &view) ||
        !view_model.FindSession(session))
      return error("invalid_session_or_view");
    if (retired_views.contains(view)) {
      reply.Set("ok", true);
      reply.Set("accepted", true);
      reply.Set("completed", true);
      return reply;
    }
    size_t index = 0;
    while (index < contents.size() &&
           (contents[index]->session_id() != session || contents[index]->view_id() != view))
      ++index;
    if (index == contents.size())
      return error("view_not_in_session");
    if (request.Find("force") && !request.Find("force")->is_bool())
      return error("force_boolean_required");
    bool force = request.FindBool("force").value_or(false);
    if (force)
      RemoveView(index);
    else
      page_requests[index]->RequestClose();
    reply.Set("ok", true);
    reply.Set("accepted", true);
    reply.Set("completed", force);
    return reply;
  }
  uint64_t session = 0, view = 0;
  if (!ReadId(request, "session", &session) || !ReadId(request, "view", &view) ||
      !view_model.FindWebView(session, view))
    return error("view_not_in_session");
  size_t index = 0;
  for (; index < contents.size(); ++index)
    if (contents[index]->session_id() == session && contents[index]->view_id() == view)
      break;
  if (index == contents.size())
    return error("execution_adapter_missing");
  auto& adapter = *contents[index];
  if (*method == "view.recreate") {
    if (page_requests[index]->close_state() == "closing" ||
        page_requests[index]->close_state() == "closed")
      return error("view_closing");
    const auto* url = request.FindString("url");
    if (!url || !GURL(*url).is_valid())
      return error("invalid_url");
    if (const auto existing = adapter.ExistingNavigationOperation(GURL(*url), request)) {
      if (!*existing)
        return error(existing->message);
      reply.Set("ok", true);
      reply.Set("accepted", true);
      reply.Set("token", TokenValue(view_model.Token(session, view).value));
      return reply;
    }
    transfers.erase(view);
    if (output)
      output->StopView(view);
    paused_output.insert(view);
    UpdateOutput();
    page_requests[index]->Bind(nullptr);
    const auto profile = view_model.FindWebView(session, view)->profile;
    const auto owner = std::ranges::find(profiles, profile);
    if (owner == profiles.end())
      return error("profile_missing");
    auto navigation_operations = contents[index]->ReleaseNavigationOperations();
    contents[index].reset();
    view_model.ResetWebView(session, view);
    contents[index] = std::make_unique<WebView>(contexts[owner - profiles.begin()].get(),
                                                &view_model, session, view);
    contents[index]->RestoreNavigationOperations(std::move(navigation_operations));
    contents[index]->ConfigureDevice(specs[index].width, specs[index].height,
                                     PageScale(specs[index]));
    page_requests[index] = std::make_unique<PageRequests>();
    page_requests[index]->Bind(contents[index]->contents());
    WirePopups(page_requests[index].get(), session, view);
    contents[index]->SetVisible(specs[index].visible);
    const auto status = contents[index]->Navigate(GURL(*url), &request);
    paused_output.erase(view);
    UpdateOutput();
    reply.Set("ok", static_cast<bool>(status));
    reply.Set("accepted", static_cast<bool>(status));
    reply.Set("token", TokenValue(view_model.Token(session, view).value));
    return reply;
  }
  if (*method == "view.configure") {
    auto spec = specs[index];
    if (page_requests[index]->close_state() == "closing")
      return error("view_closing");
    if (request.Find("visible")) {
      if (!request.Find("visible")->is_bool())
        return error("visible_boolean_required");
      spec.visible = *request.FindBool("visible");
    }
    if (request.Find("width"))
      spec.width = request.FindInt("width").value_or(0);
    if (request.Find("height"))
      spec.height = request.FindInt("height").value_or(0);
    if (const auto* device = request.FindString("device")) {
      if (*device != "desktop" && *device != "tablet")
        return error("invalid_device");
    } else if (request.Find("device"))
      return error("invalid_device");
    if (request.Find("device_scale_factor")) {
      const auto scale = Number(request, "device_scale_factor");
      if (!scale || !std::isfinite(*scale) || *scale < 0.5 || *scale > 4)
        return error("invalid_page_device_scale_factor");
      spec.page_dsf = static_cast<float>(*scale);
    }
    if (spec.width < 1 || spec.height < 1 || spec.width > 8192 || spec.height > 8192)
      return error("invalid_viewport");
    if (spec == specs[index]) {
      reply.Set("ok", true);
      reply.Set("accepted", true);
      reply.Set("completed", true);
      reply.Set("token", TokenValue(view_model.Token(session, view).value));
      return reply;
    }
    auto next = specs;
    next[index] = spec;
    auto layout = Layout(next);
    if (!layout)
      return error("atlas_no_space");
    const auto visibility = adapter.SetVisible(spec.visible);
    if (!visibility)
      return error(visibility.message);
    specs = std::move(next);
    ApplyLayout(layout.value);
    reply.Set("ok", true);
    reply.Set("accepted", true);
    reply.Set("completed", true);
    reply.Set("token", TokenValue(view_model.Token(session, view).value));
    return reply;
  }
  if (*method == "profile.permissions" || *method == "profile.downloads") {
    const auto* command = request.FindDict("command");
    if (!command)
      return error("profile_command_required");
    auto profile = view_model.FindWebView(session, view)->profile;
    auto found = std::find(profiles.begin(), profiles.end(), profile);
    if (found == profiles.end())
      return error("profile_missing");
    auto* context = contexts[static_cast<size_t>(found - profiles.begin())].get();
    auto result = *method == "profile.permissions" ? context->PermissionsCommand(*command)
                                                   : context->DownloadsCommand(*command);
    result.Set("version", 1);
    result.Set("id", id);
    return result;
  }
  if (*method == "page.requests" || *method == "page.reply" || *method == "page.command" ||
      *method == "page.fileStatus") {
    const auto token = view_model.Token(session, view).value;
    PageRequests::SelectionBinding binding{token.instance, token.document};
    bool terminal_only = false;
    if (*method == "page.reply" || *method == "page.fileStatus") {
      for (const auto& [key, expected] :
           {std::pair{"instance", token.instance}, std::pair{"document", token.document}}) {
        if (!request.Find(key))
          continue;
        uint64_t supplied = 0;
        if (!ReadId(request, key, &supplied))
          return error("stale_page_request_target");
        if (supplied == expected)
          continue;
        // A page may navigate immediately after the native callback. Allow
        // only an exact terminal receipt from the same WebView instance.
        if (*method != "page.fileStatus" || std::string_view(key) != "document" ||
            !request.Find("instance") || !request.FindString("selection_id"))
          return error("stale_page_request_target");
        binding.document = supplied;
        terminal_only = true;
      }
    }
    if (*method == "page.fileStatus") {
      const auto* key = request.FindString("request");
      if (!key)
        return error("file_request_required");
      auto result = page_requests[index]->FileStatus(*key, request.Find("selection_id"), binding,
                                                     terminal_only);
      result.Set("version", 1);
      result.Set("id", id);
      return result;
    }
    if (*method == "page.command") {
      const auto* action = request.FindString("action");
      if (action &&
          (*action == "back" || *action == "forward" || *action == "reload" || *action == "stop")) {
        auto status = adapter.NavigationCommand(request);
        auto result = reply.Clone();
        result.Set("ok", static_cast<bool>(status));
        result.Set("accepted", static_cast<bool>(status));
        result.Set("state", "submitted");
        if (!status)
          result.Set("error", status.message);
        return result;
      }
    }
    base::DictValue result;
    if (*method == "page.requests") {
      const auto& spec = specs[index];
      const PageRequests::AnchorLayout layout{spec.width,     spec.height,    PageScale(spec),
                                              token.instance, token.document, output_generation};
      result = page_requests[index]->Snapshot(
          output && spec.visible && token.instance && token.document ? &layout : nullptr);
    } else {
      result = *method == "page.reply" ? page_requests[index]->Reply(request, binding)
                                       : page_requests[index]->Command(request);
    }
    result.Set("version", 1);
    result.Set("id", id);
    if (*method == "page.requests")
      result.Set("ok", true);
    return result;
  }
  if (page_requests[index]->close_state() == "closing")
    return error("view_closing");
  if (*method == "page.exitFullscreen") {
    const auto token = view_model.Token(session, view).value;
    uint64_t instance = 0, document = 0;
    if (!ReadId(request, "instance", &instance) || !ReadId(request, "document", &document) ||
        instance != token.instance || document != token.document || !adapter.contents())
      return error("stale_page_request_target");
    if (page_requests[index]->fullscreen())
      adapter.contents()->ExitFullscreen(/*will_cause_resize=*/false);
    reply.Set("ok", true);
    return reply;
  }
  if (method->starts_with("navigation.")) {
    if (*method == "navigation.ack") {
      const auto status = adapter.AcknowledgeNavigation(request);
      if (!status)
        return error(status.message);
      reply.Set("ok", true);
      return reply;
    }
    auto token = view_model.Token(session, view).value;
    if (*method == "navigation.export.begin") {
      auto saved = adapter.ExportNavigation();
      if (!saved)
        return error(saved.status.message);
      size_t existing = 0;
      for (const auto& [key, item] : transfers)
        if (key != view)
          existing += item.total;
      if (saved.value.size() + existing > 64 * 1024 * 1024)
        return error("transfer_memory_limit");
      Transfer transfer;
      transfer.id = next_transfer++;
      transfer.instance = token.instance;
      transfer.document = token.document;
      transfer.total = saved.value.size();
      transfer.data = std::move(saved.value);
      reply.Set("navigationRevision", base::NumberToString(adapter.navigation_revision()));
      transfers[view] = std::move(transfer);
    } else if (*method == "navigation.import.begin") {
      uint64_t size = 0;
      if (!ReadId(request, "size", &size) || size > 64 * 1024 * 1024 || adapter.contents())
        return error("import_requires_unloaded_view_and_bounded_size");
      size_t existing = 0;
      for (const auto& [key, item] : transfers)
        if (key != view)
          existing += item.total;
      if (existing + size > 64 * 1024 * 1024)
        return error("transfer_memory_limit");
      Transfer transfer;
      transfer.id = next_transfer++;
      transfer.instance = token.instance;
      transfer.document = token.document;
      transfer.total = static_cast<size_t>(size);
      transfer.importing = true;
      transfers[view] = std::move(transfer);
    } else {
      uint64_t transfer_id = 0;
      auto found = transfers.find(view);
      if (!ReadId(request, "transfer", &transfer_id) || found == transfers.end() ||
          found->second.id != transfer_id)
        return error("transfer_not_found");
      auto& transfer = found->second;
      if (*method == "navigation.transfer.cancel") {
        transfers.erase(found);
        reply.Set("ok", true);
        return reply;
      }
      if (*method == "navigation.export.chunk" && !transfer.importing) {
        const auto* offset_text = request.FindString("offset");
        uint64_t offset = 0;
        const int length = request.FindInt("length").value_or(256 * 1024);
        if (!offset_text || !base::StringToUint64(*offset_text, &offset) ||
            offset > transfer.total || length < 1 || length > 256 * 1024)
          return error("invalid_export_chunk");
        auto chunk = std::string_view(transfer.data).substr(static_cast<size_t>(offset), length);
        reply.Set("data", base::Base64Encode(chunk));
        reply.Set("offset", base::NumberToString(offset));
      } else if (*method == "navigation.import.chunk" && transfer.importing) {
        const auto* offset_text = request.FindString("offset");
        const auto* data = request.FindString("data");
        uint64_t offset = 0;
        std::string chunk;
        if (!offset_text || !base::StringToUint64(*offset_text, &offset) ||
            offset != transfer.data.size() || !data || data->size() > 350000 ||
            !base::Base64Decode(*data, &chunk) || chunk.empty() || chunk.size() > 256 * 1024 ||
            chunk.size() > transfer.total - transfer.data.size())
          return error("invalid_import_chunk");
        transfer.data += chunk;
      } else if (*method == "navigation.import.commit" && transfer.importing) {
        if (transfer.instance != token.instance || transfer.document != token.document ||
            transfer.data.size() != transfer.total)
          return error("incomplete_or_stale_import");
        auto imported = adapter.ImportNavigation(transfer.data);
        if (!imported)
          return error(imported.message);
        transfers.erase(found);
        reply.Set("ok", true);
        return reply;
      } else
        return error("invalid_transfer_method");
    }
    const auto& transfer = transfers.at(view);
    reply.Set("ok", true);
    reply.Set("transfer", base::NumberToString(transfer.id));
    reply.Set("size", base::NumberToString(transfer.total));
    reply.Set("received", base::NumberToString(transfer.importing ? transfer.data.size() : 0));
    return reply;
  }
  Status status{Error::unsupported, "unsupported_method"};
  if (*method == "input.touchStatus" || *method == "input.touchRetire") {
    const auto* sequence = request.FindString("sequenceId");
    InputToken owner{session, view};
    reply.Set("state", "terminal-unconfirmed");
    reply.Set("pending", false);
    if (!sequence || sequence->empty() || sequence->size() > 128 ||
        !ReadId(request, "instance", &owner.instance) ||
        !ReadId(request, "document", &owner.document) || !ReadId(request, "focus", &owner.focus))
      return error("invalid_touch_status_identity");
    reply.Set("sequenceId", *sequence);
    adapter.RefreshClientTouchOwner();
    using State = ClientTouchRetirement::State;
    const auto completion = *method == "input.touchRetire"
                                ? adapter.RetireClientTouch(owner, *sequence)
                                : adapter.ClientTouchStatus(owner, *sequence);
    if (completion == State::invalidated) {
      reply.Set("state", "terminal-invalidated");
      return error("touch_owner_invalidated");
    }
    if (completion == State::pending) {
      reply.Set("state", "pending");
      reply.Set("pending", true);
      return error("touch_terminal_pending");
    }
    if (completion != State::processed)
      return error("touch_terminal_unconfirmed");
    reply.Set("state", "processed");
    reply.Set("ok", true);
    return reply;
  }
  if (*method == "focus") {
    if (!request.Find("focus"))
      return error("focus_token_required");
    const auto current = view_model.Token(session, view).value;
    for (auto [key, expected] :
         {std::pair{"instance", current.instance}, std::pair{"document", current.document},
          std::pair{"focus", current.focus}}) {
      if (request.Find(key)) {
        uint64_t value = 0;
        if (!ReadId(request, key, &value) || value != expected)
          return error("stale_focus_target");
      }
    }
    auto focused = request.FindBool("focused");
    if (!focused)
      return error("focused_boolean_required");
    if (*focused) {
      for (auto& old : contents)
        if (old->session_id() == session && old->view_id() != view)
          old->Focus(false);
    }
    status = adapter.Focus(*focused);
  } else if (*method == "visible") {
    auto visible = request.FindBool("visible");
    if (!visible)
      return error("visible_boolean_required");
    auto next = specs;
    next[index].visible = *visible;
    auto layout = Layout(next);
    if (!layout)
      return error("atlas_no_space");
    status = adapter.SetVisible(*visible);
    if (status) {
      specs = std::move(next);
      ApplyLayout(layout.value);
    }
  } else if (*method == "navigate") {
    const auto* url = request.FindString("url");
    if (!url)
      return error("url_required");
    status = adapter.Navigate(GURL(*url), &request);
  } else if (*method == "lifecycle") {
    const auto* action = request.FindString("action");
    if (!action)
      return error("action_required");
    std::optional<Lifecycle> operation;
    if (*action == "unload")
      operation = Lifecycle::unload;
    if (*action == "restore")
      operation = Lifecycle::restore;
    if (*action == "freeze")
      operation = Lifecycle::freeze;
    if (*action == "discard")
      operation = Lifecycle::discard;
    if (!operation)
      return error("unknown_lifecycle_action");
    const bool guarded = request.Find("expected_lifecycle_generation") != nullptr;
    const bool recover_uncertain = guarded && *operation == Lifecycle::unload;
    if (guarded) {
      uint64_t generation = 0;
      const auto* model = view_model.FindWebView(session, view);
      if (!ReadId(request, "expected_lifecycle_generation", &generation) || !model ||
          model->lifecycle_generation != generation || model->pending ||
          page_requests[index]->close_state() == "closing" ||
          page_requests[index]->close_state() == "closed")
        return error("stale_lifecycle_recovery");
      if (recover_uncertain) {
        const auto allowed = adapter.CanRecoverLifecycle();
        if (!allowed)
          return error(allowed.message);
      } else if (*operation != Lifecycle::restore || model->actual != Residency::unloaded ||
                 adapter.lifecycle_uncertain()) {
        return error("stale_lifecycle_recovery");
      }
    }
    if (*operation == Lifecycle::discard || *operation == Lifecycle::freeze) {
      const auto allowed = CanDiscard(index);
      if (!allowed)
        return error(allowed.message);
    }
    if (output) {
      paused_output.insert(view);
      output->StopView(view);
      UpdateOutput();
    }
    page_requests[index]->CancelAll("lifecycle_transition");
    page_requests[index]->Bind(nullptr);
    status = adapter.RequestLifecycle(*operation, {}, recover_uncertain);
    page_requests[index]->Bind(adapter.contents());
    paused_output.erase(view);
    UpdateOutput();
    reply.Set("accepted", static_cast<bool>(status));
    const auto* lifecycle = view_model.FindWebView(session, view);
    reply.Set("pending", lifecycle->pending.has_value());
    reply.Set("completed", static_cast<bool>(status) && !lifecycle->pending);
    reply.Set("lifecycleGeneration", base::NumberToString(lifecycle->lifecycle_generation));
  } else if (*method == "input") {
    if (request.Find("output_generation")) {
      uint64_t generation = 0;
      if (!ReadId(request, "output_generation", &generation) || !output ||
          generation != output_generation)
        return error("stale_output_generation");
    }
    InputEvent input;
    input.token.session = session;
    input.token.view = view;
    if (!ReadId(request, "instance", &input.token.instance) ||
        !ReadId(request, "document", &input.token.document) ||
        !ReadId(request, "focus", &input.token.focus) ||
        !ReadId(request, "sequence", &input.sequence))
      return error("input_token_required");
    const auto* event = request.FindDict("event");
    const auto* type = event ? event->FindString("type") : nullptr;
    if (!type)
      return error("event_type_required");
    if (event->Find("editableTarget")) {
      const auto* target = event->FindString("editableTarget");
      if (!target || !ReadId(*event, "editableTarget", &input.editable_target) ||
          *target != base::NumberToString(input.editable_target))
        return error("invalid_editable_target");
    }
    if (*type == "ime_commit" || *type == "ime_set") {
      const auto* text = event->FindString("text");
      if (!text)
        return error("text_required");
      if (*type == "ime_commit")
        input.payload = ImeCommit{base::UTF8ToUTF16(*text)};
      else {
        const auto start = event->FindInt("selection_start"), end = event->FindInt("selection_end");
        if (!start || !end || *start < 0 || *end < 0)
          return error("selection_required");
        input.payload = ImeSet{base::UTF8ToUTF16(*text), static_cast<uint32_t>(*start),
                               static_cast<uint32_t>(*end)};
      }
    } else if (*type == "ime_cancel")
      input.payload = ImeCancel{};
    else if (*type == "ime_finish")
      input.payload = ImeFinish{};
    else if (*type == "key") {
      const auto* action = event->FindString("action");
      const auto physical = event->FindInt("physical_code"),
                 windows = event->FindInt("windows_key_code"),
                 dom_code = event->FindInt("dom_code");
      const auto* dom_key = event->FindString("dom_key");
      uint64_t key_value = 0;
      if (!action || !physical || *physical < 0 || !windows || !dom_code || *dom_code < 0 ||
          !dom_key || !base::StringToUint64(*dom_key, &key_value))
        return error("invalid_key");
      KeyInput key;
      if (*action == "down")
        key.action = KeyInput::Action::down;
      else if (*action == "up")
        key.action = KeyInput::Action::up;
      else if (*action == "char")
        key.action = KeyInput::Action::character;
      else
        return error("invalid_key_action");
      key.physical_code = static_cast<uint32_t>(*physical);
      key.windows_key_code = *windows;
      key.dom_code = static_cast<uint32_t>(*dom_code);
      key.dom_key = key_value;
      key.modifiers = static_cast<uint32_t>(event->FindInt("modifiers").value_or(0));
      key.repeat = event->FindBool("repeat").value_or(false);
      if (const auto* text = event->FindString("text"))
        key.text = base::UTF8ToUTF16(*text);
      if (const auto* text = event->FindString("unmodified_text"))
        key.unmodified_text = base::UTF8ToUTF16(*text);
      input.payload = std::move(key);
    } else if (*type == "touch") {
      const auto* action = event->FindString("action");
      const auto* points = event->FindList("points");
      if (!action || !points || points->size() > 16)
        return error("invalid_touch");
      TouchInput touch;
      if (const auto* mode = event->FindString("gestureMode")) {
        if (*mode != "client-v1" && *mode != "legacy")
          return error("invalid_gesture_mode");
        touch.client_gestures = *mode == "client-v1";
      }
      const auto* candidates = event->FindList("gestures");
      if ((touch.client_gestures && !candidates) ||
          (candidates && (!touch.client_gestures || candidates->size() > 8)))
        return error("invalid_gestures");
      if (candidates)
        for (const auto& candidate : *candidates) {
          const auto* g = candidate.GetIfDict();
          const auto* kind = g ? g->FindString("type") : nullptr;
          const auto x = g ? Number(*g, "x") : std::nullopt, y = g ? Number(*g, "y") : std::nullopt;
          if (!kind || !x || !y)
            return error("invalid_gesture");
          static constexpr std::array<const char*, 11> names = {
              "tapDown",    "tapCancel",   "tap",      "scrollBegin", "scrollUpdate", "scrollEnd",
              "pinchBegin", "pinchUpdate", "pinchEnd", "flingStart",  "flingCancel"};
          int candidate_index = 0;
          while (candidate_index != 11 && *kind != names[candidate_index])
            ++candidate_index;
          if (candidate_index == 11)
            return error("invalid_gesture_type");
          for (const auto* field : {"deltaX", "deltaY", "scale", "velocityX", "velocityY"})
            if (g->contains(field) && !Number(*g, field))
              return error("invalid_gesture_number");
          if ((candidate_index == 3 || candidate_index == 4) &&
              (!Number(*g, "deltaX") || !Number(*g, "deltaY")))
            return error("missing_gesture_delta");
          if (candidate_index == 7 && !Number(*g, "scale"))
            return error("missing_gesture_scale");
          if (candidate_index == 9 && (!Number(*g, "velocityX") || !Number(*g, "velocityY")))
            return error("missing_gesture_velocity");
          touch.gestures.push_back(
              {static_cast<TouchInput::Gesture::Type>(candidate_index), *x, *y,
               Number(*g, "deltaX").value_or(0), Number(*g, "deltaY").value_or(0),
               Number(*g, "scale").value_or(1), Number(*g, "velocityX").value_or(0),
               Number(*g, "velocityY").value_or(0)});
        }

      if (*action == "start")
        touch.action = TouchInput::Action::start;
      else if (*action == "move")
        touch.action = TouchInput::Action::move;
      else if (*action == "end")
        touch.action = TouchInput::Action::end;
      else if (*action == "cancel")
        touch.action = TouchInput::Action::cancel;
      else
        return error("invalid_touch_action");
      if (const auto* mode = event->FindString("clockMode")) {
        const auto* sequence = event->FindString("sequenceId");
        const auto elapsed = Number(*event, "sampleElapsedUs");
        const auto wall = Number(*event, "startServerWallUs");
        if (!sequence || sequence->empty() || sequence->size() > 128 || !elapsed || *elapsed < 0 ||
            *elapsed > 86400000000.0 || std::floor(*elapsed) != *elapsed ||
            (*mode != "source" && *mode != "arrival-fallback") ||
            (*mode == "source" &&
             (!wall || *wall <= 0 || *wall > 9007199254740991.0 || std::floor(*wall) != *wall)) ||
            (*mode == "arrival-fallback" && wall))
          return error("invalid_touch_clock");
        touch.clock =
            TouchInput::Clock{*sequence, *mode == "source", static_cast<int64_t>(*elapsed),
                              wall ? static_cast<int64_t>(*wall) : 0};
      } else if (event->contains("sequenceId") || event->contains("sampleElapsedUs") ||
                 event->contains("startServerWallUs"))
        return error("incomplete_touch_clock");
      if (const auto* samples = event->FindList("samples")) {
        if (!touch.clock || touch.action != TouchInput::Action::move || samples->size() > 32)
          return error("invalid_touch_samples");
        for (const auto& sample : *samples) {
          const auto* dict = sample.GetIfDict();
          const auto elapsed = dict ? Number(*dict, "sampleElapsedUs") : std::nullopt;
          const auto* changed = dict ? dict->FindList("points") : nullptr;
          if (!elapsed || *elapsed < 0 || *elapsed > touch.clock->elapsed_us ||
              std::floor(*elapsed) != *elapsed || !changed || changed->empty() ||
              changed->size() > 16)
            return error("invalid_touch_sample");
          TouchInput::Sample value{static_cast<int64_t>(*elapsed), {}};
          for (const auto& point : *changed) {
            const auto* point_dict = point.GetIfDict();
            if (!point_dict)
              return error("invalid_touch_sample_point");
            const auto contact_id = point_dict->FindInt("id");
            const auto x = Number(*point_dict, "x"), y = Number(*point_dict, "y"),
                       pressure = Number(*point_dict, "pressure");
            if (!contact_id || *contact_id < 0 || !x || !y || !pressure)
              return error("invalid_touch_sample_point");
            value.points.push_back({static_cast<uint32_t>(*contact_id), *x, *y, *pressure});
          }
          touch.samples.push_back(std::move(value));
        }
      }
      for (const auto& point : *points) {
        const auto* dict = point.GetIfDict();
        if (!dict)
          return error("invalid_touch_point");
        auto point_id = dict->FindInt("id");
        auto x = Number(*dict, "x"), y = Number(*dict, "y"), pressure = Number(*dict, "pressure");
        if (!point_id || *point_id < 0 || !x || !y || !pressure)
          return error("invalid_touch_point");
        touch.points.push_back({static_cast<uint32_t>(*point_id), *x, *y, *pressure});
      }
      input.payload = std::move(touch);
    } else if (*type == "gesture") {
      const auto* mode = event->FindString("gestureMode");
      const auto* action = event->FindString("action");
      const auto* sequence = event->FindString("sequenceId");
      const auto elapsed = Number(*event, "sampleElapsedUs"), x = Number(*event, "cumulativeX"),
                 y = Number(*event, "cumulativeY");
      if (!mode || *mode != "client-v1" || !action || !sequence || !elapsed || !x || !y ||
          *elapsed < 0 || *elapsed > 86400000000.0 || std::floor(*elapsed) != *elapsed)
        return error("invalid_momentum");
      GestureInput::Action kind;
      if (*action == "momentum")
        kind = GestureInput::Action::momentum;
      else if (*action == "momentumEnd")
        kind = GestureInput::Action::momentum_end;
      else if (*action == "cancel")
        kind = GestureInput::Action::cancel;
      else
        return error("invalid_momentum_action");
      input.payload = GestureInput{kind, *sequence, static_cast<int64_t>(*elapsed), *x, *y};
    } else if (*type == "mouse") {
      const auto* action = event->FindString("action");
      const auto x = Number(*event, "x"), y = Number(*event, "y");
      const auto button = event->FindInt("button");
      const auto clicks = event->FindInt("click_count").value_or(1);
      if (!action || !x || !y || !button || *button < 0 || *button > 5 || clicks < 0 ||
          clicks > 3 || (*action != "move" && *action != "leave" && clicks == 0))
        return error("invalid_mouse");
      MouseInput::Action kind;
      if (*action == "move")
        kind = MouseInput::Action::move;
      else if (*action == "down")
        kind = MouseInput::Action::down;
      else if (*action == "up")
        kind = MouseInput::Action::up;
      else if (*action == "leave")
        kind = MouseInput::Action::leave;
      else
        return error("invalid_mouse_action");
      input.payload = MouseInput{kind,
                                 *x,
                                 *y,
                                 static_cast<uint8_t>(*button),
                                 static_cast<uint32_t>(event->FindInt("modifiers").value_or(0)),
                                 static_cast<uint8_t>(clicks)};
    } else if (*type == "wheel") {
      auto x = Number(*event, "x"), y = Number(*event, "y"), dx = Number(*event, "dx"),
           dy = Number(*event, "dy");
      if (!x || !y || !dx || !dy)
        return error("invalid_wheel");
      input.payload = WheelInput{*x, *y, *dx, *dy,
                                 static_cast<uint32_t>(event->FindInt("modifiers").value_or(0))};
    } else
      return error("unsupported_input_type");
    bool input_admitted = false;
    if (output)
      output->TraceInput("input_browser_dispatch", input);
    status = adapter.DispatchInput(input, &input_admitted);
    if (output)
      output->TraceInput("input_browser_dispatch_return", input, static_cast<int>(status.error));
    if (const auto* touch = std::get_if<TouchInput>(&input.payload)) {
      reply.Set("touchPending", adapter.TouchProcessingPending());
      reply.Set("touchSequenceId", touch->clock ? touch->clock->sequence_id : std::string());
      reply.Set("inputAdmitted", input_admitted);
      if (touch->client_gestures && touch->clock &&
          (touch->action == TouchInput::Action::end || touch->action == TouchInput::Action::cancel))
        reply.Set("touchTerminal",
                  adapter.ClientTouchStatus(input.token, touch->clock->sequence_id) !=
                      ClientTouchRetirement::State::unknown);
      if (!status && touch->client_gestures && touch->clock &&
          (input_admitted || (status.error == Error::stale &&
                              status.message == "Client touch owner explicitly invalidated")) &&
          adapter.ClientTouchRetired(input.token, touch->clock->sequence_id)) {
        reply.Set("touchState", "terminal-invalidated");
        reply.Set("touchPending", false);
      }
    }
  }
  reply.Set("ok", static_cast<bool>(status));
  reply.Set("code", static_cast<int>(status.error));
  if (!status)
    reply.Set("error", status.message);
  reply.Set("token", TokenValue(view_model.Token(session, view).value));
  UpdateOutput();
  return reply;
}

RemoteKitMainParts::RemoteKitMainParts() = default;
RemoteKitMainParts::~RemoteKitMainParts() = default;
void RemoteKitMainParts::PostCreateMainMessageLoop() {
  // Install before content's thread/service startup. Content owns and destroys
  // this UI-thread clipboard after browser teardown (BrowserMainLoop dtor).
  headless::SetHeadlessClipboardForCurrentThread();
}
int RemoteKitMainParts::PostCreateThreads() {
  CHECK(content::GetIOThreadTaskRunner({})->PostTask(
      FROM_HERE, base::BindOnce([] { new ServiceIoClipboard; })));
  return 0;
}
int RemoteKitMainParts::PreMainMessageLoopRun() {
  LOG(INFO) << "RemoteKit startup PreMain entered";
  state_ = std::make_unique<State>();
  const auto& command = *base::CommandLine::ForCurrentProcess();
  CHECK(!display::Screen::HasScreen());
  state_->screen = CreateOffscreenScreen();
  display::Screen::SetScreenInstance(state_->screen.get());
  const base::FilePath data = command.GetSwitchValuePath("data-path");
  uint64_t service_session = 0;
  if (!command.HasSwitch("control-channel") ||
      !base::StringToUint64(command.GetSwitchValueASCII("session-id"), &service_session) ||
      service_session == 0 || command.GetSwitchValueASCII("tenant-id").empty() ||
      !data.IsAbsolute())
    return 2;
  auto session =
      state_->view_model.CreateSession(command.GetSwitchValueASCII("tenant-id"), service_session);
  CHECK(session);
  auto profile = state_->view_model.AddProfile(session.value, "default");
  CHECK(profile);
  state_->session_id = session.value;
  state_->profiles.push_back(profile.value);
  state_->contexts.push_back(std::make_unique<BrowserContext>(
      data.AppendASCII("session-" + base::NumberToString(session.value))
          .AppendASCII("profile-" + base::NumberToString(profile.value))));
  LOG(INFO) << "RemoteKit startup Profile ready";
  int width = 1920, height = 1080;
  if ((command.HasSwitch("atlas-width") &&
       !base::StringToInt(command.GetSwitchValueASCII("atlas-width"), &width)) ||
      (command.HasSwitch("atlas-height") &&
       !base::StringToInt(command.GetSwitchValueASCII("atlas-height"), &height)) ||
      width < 16 || height < 16 || width > 8192 || height > 8192)
    return 2;
  state_->logical_width = width;
  state_->logical_height = height;
  const auto dimensions =
      AtlasAllocationDimensions(width, height, state_->output_scale, state_->allocation_alignment);
  if (!dimensions)
    return 1;
  state_->output_width = dimensions->width;
  state_->output_height = dimensions->height;
  state_->output_timer.Start(FROM_HERE, base::Milliseconds(8),
                             base::BindRepeating(
                                 [](State* state) {
                                   state->DrainClosed();
                                   state->UpdateOutput();
                                 },
                                 base::Unretained(state_.get())));
  state_->control = std::make_unique<ControlServer>(
      command.GetSwitchValueASCII("control-channel"),
      base::BindRepeating(&State::HandleControl, base::Unretained(state_.get())),
      base::BindRepeating(&State::TakeControlAttachment, base::Unretained(state_.get())),
      base::BindOnce(&State::OnControlClosed, base::Unretained(state_.get())));
  LOG(INFO) << "RemoteKit startup control ready";
  return 0;
}
void RemoteKitMainParts::WillRunMainMessageLoop(std::unique_ptr<base::RunLoop>& run_loop) {
  state_->quit = run_loop->QuitClosure();
}
void RemoteKitMainParts::PostMainMessageLoopRun() {
  if (!state_)
    return;
  state_->shutting_down = true;
  state_->quit.Reset();
  // Stop producers and invalidate page callbacks before destroying consumers.
  state_->output_timer.Stop();
  state_->control.reset();
  state_->output.reset();
  for (auto& request : state_->page_requests) {
    request->SetPopupHandler({});
    request->Bind(nullptr);
  }
  for (auto& [key, popup] : state_->pending_popups) {
    if (popup.requests) {
      popup.requests->SetPopupHandler({});
      popup.requests->Bind(nullptr);
      popup.requests.reset();
    }
  }
  state_->page_requests.clear();
  state_->pending_popups.clear();
  state_->contents.clear();
  // Offscreen compositor teardown can make sync Mojo calls. Run the deferred
  // deletions after WebContents destruction and before its virtual Screen dies.
  base::RunLoop().RunUntilIdle();
  state_->contexts.clear();
  if (state_->screen && display::Screen::Get() == state_->screen.get())
    display::Screen::SetScreenInstance(nullptr);
  state_.reset();
}
}  // namespace remotekit::browser
