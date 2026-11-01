#include "remotekit/browser/harness.h"

#include <algorithm>
#include <cmath>
#include <map>
#include <set>
#include "base/base64.h"
#include "base/base_paths.h"
#include "base/command_line.h"
#include "base/functional/bind.h"
#include "base/path_service.h"
#include "base/run_loop.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_split.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "base/timer/timer.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_process_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_delegate.h"
#include "remotekit/browser/browser_context.h"
#include "remotekit/browser/control_server.h"
#include "remotekit/browser/devtools.h"
#include "remotekit/browser/gpu_atlas.h"
#include "remotekit/browser/page_requests.h"
#include "remotekit/browser/offscreen_host.h"
#include "remotekit/browser/webview.h"
#include "remotekit/endpoint/include/remotekit/core.hpp"
#include "remotekit/endpoint/include/remotekit/atlas_dimensions.hpp"
#include "remotekit/protocol/control.h"
#include "ui/aura/window.h"
#include "ui/aura/window_tree_host.h"
#include "ui/display/screen.h"
#include "ui/views/controls/webview/webview.h"
#include "ui/views/view.h"
#include "ui/views/views_delegate.h"
#include "ui/views/widget/desktop_aura/desktop_native_widget_aura.h"
#include "ui/views/widget/desktop_aura/desktop_screen.h"
#include "ui/views/widget/widget.h"
#include "ui/views/widget/widget_delegate.h"
#include "ui/views/widget/widget_observer.h"
#include "ui/wm/core/wm_state.h"
#include "url/gurl.h"

namespace remotekit::browser {
static_assert(static_cast<int>(Error::busy) == protocol::kBusyError);
namespace {
class HarnessViewsDelegate final : public views::ViewsDelegate {
 public:
  void OnBeforeWidgetInit(views::Widget::InitParams* params,
                          views::internal::NativeWidgetDelegate* delegate) override {
    if (!params->native_widget)
      params->native_widget = new views::DesktopNativeWidgetAura(delegate);
  }
};
// Owns only the harness window. BrowserContext and WebContents are owned by State.
class WindowObserver final : public views::WidgetObserver {
 public:
  explicit WindowObserver(base::RepeatingClosure close) : close_(std::move(close)) {}
  void OnWidgetDestroying(views::Widget* widget) override {
    widget->RemoveObserver(this);
    close_.Run();
  }

 private:
  base::RepeatingClosure close_;
};
}  // namespace

struct HarnessMainParts::State {
  wm::WMState wm_state;
  std::unique_ptr<display::Screen> screen;
  HarnessViewsDelegate views_delegate;
  Endpoint endpoint;
  bool demo = false;
  bool offscreen = false;
  raw_ptr<views::View> root = nullptr;
  struct ViewSpec {
    int width = 480, height = 360;
    bool tablet = false;
    std::string url;
    bool visible = true;
    float page_dsf = 0;  // Unspecified demo views inherit output/native DPI.
    bool operator==(const ViewSpec&) const = default;
  };
  std::vector<ViewSpec> specs;
  float PageScale(const ViewSpec& spec) const {
    return spec.page_dsf > 0 ? spec.page_dsf : output_scale;
  }
  std::map<WebViewId, base::DictValue> closed_views;
  Result<Atlas> Layout(const std::vector<ViewSpec>& next, WebViewId extra = 0,
                       int width = 0, int height = 0) {
    std::vector<PackItem> items;
    for (size_t i = 0; i < next.size(); ++i) {
      if (!next[i].visible) continue;
      items.push_back({i < contents.size() ? contents[i]->view_id() : extra,
                       next[i].width, next[i].height, 1.0});
    }
    return PackAtlas(width ? width : logical_width, height ? height : logical_height, 4, items);
  }
  void ApplyLayout(const Atlas& atlas) {
    placements.clear();
    for (size_t i = 0; i < contents.size(); ++i) {
      const auto found = std::ranges::find(atlas.placements, contents[i]->view_id(), &Placement::view);
      contents[i]->InvalidateLayoutInput();
      const bool visible = found != atlas.placements.end();
      const auto rect = visible ? found->content : PixelRect{0, 0, specs[i].width, specs[i].height};
      if (native_views[i]) {
        native_views[i]->SetBounds(rect.x, rect.y, rect.width, rect.height);
        native_views[i]->SetVisible(visible);
      }
      contents[i]->SetVisible(visible);
      placements.emplace_back(rect.x, rect.y, rect.width, rect.height);
      contents[i]->ConfigureDevice(specs[i].width, specs[i].height, specs[i].tablet, PageScale(specs[i]), !demo);
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
    closed_views.insert_or_assign(view, std::move(tombstone));
    if (output) output->StopView(view);
    paused_output.insert(view);
    UpdateOutput();
    page_requests[index]->Bind(nullptr);
    if (native_views[index]) {
      native_views[index]->SetWebContents(nullptr);
      root->RemoveChildViewT(native_views[index].get());
    }
    native_views.erase(native_views.begin() + index);
    page_requests.erase(page_requests.begin() + index);
    contents.erase(contents.begin() + index);
    specs.erase(specs.begin() + index);
    placements.erase(placements.begin() + index);
    transfers.erase(view);
    paused_output.erase(view);
    endpoint.RemoveWebView(session, view);
    auto layout = Layout(specs);
    if (layout) ApplyLayout(layout.value);
  }
  void DrainClosed() {
    for (size_t i = contents.size(); i > 0; --i)
      if (page_requests[i - 1]->close_state() == "closed") RemoveView(i - 1);
  }
  std::vector<SessionId> sessions;
  std::vector<ProfileId> profiles;
  std::vector<std::unique_ptr<BrowserContext>> contexts;
  std::vector<std::unique_ptr<PageRequests>> page_requests;
  std::vector<std::unique_ptr<WebView>> contents;
  std::vector<raw_ptr<views::WebView>> native_views;
  std::unique_ptr<ControlServer> control;
  std::unique_ptr<GpuAtlas> output;
  base::RepeatingTimer output_timer;
  std::vector<gfx::Rect> placements;
  std::set<WebViewId> paused_output;
  float output_scale = 1;
  uint32_t allocation_alignment = 1;
  bool output_enabled = true;
  uint32_t output_fps = 30;
  uint32_t render_fps = 0;  // Zero follows output fps; never changes capture/encode.
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
  std::unique_ptr<views::WidgetDelegate> window_delegate;
  raw_ptr<views::Widget> widget = nullptr;
  std::unique_ptr<WindowObserver> observer;
  base::RepeatingClosure quit;

  base::DictValue HandleControl(const base::DictValue& request);
  void UpdateOutput() {
    for (size_t i = 0; i < contents.size(); ++i) {
      const auto& adapter = contents[i];
      adapter->RefreshBackingScale();
      const auto* model = endpoint.FindWebView(adapter->session_id(), adapter->view_id());
      adapter->SetRenderDemand(output && output_enabled && specs[i].visible &&
          model && model->actual == Residency::live && !model->pending &&
          !paused_output.contains(adapter->view_id()), render_fps ? render_fps : output_fps);
    }
    if (!output)
      return;
    std::vector<GpuAtlas::View> views;
    for (size_t i = 0; i < contents.size(); ++i) {
      if (!specs[i].visible) continue;
      const auto& adapter = *contents[i];
      const auto token = endpoint.Token(adapter.session_id(), adapter.view_id());
      const auto* model = endpoint.FindWebView(adapter.session_id(), adapter.view_id());
      if (!token || !model)
        continue;
      const auto& p = placements[i];
      GpuAtlas::View view;
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
      view.contents = adapter.contents();
      view.offscreen_host = adapter.offscreen_host();
      view.capture_enabled = adapter.contents() && model->actual == Residency::live &&
                             !model->pending && output_enabled &&
                             !paused_output.contains(adapter.view_id());
      views.push_back(std::move(view));
    }
    output->SetViews(std::move(views));
  }
  void OnControlClosed() {
    if (offscreen) output_enabled = false;
    for (const auto& adapter : contents) adapter->SetRenderDemand(false, output_fps);
    if (output)
      output->Stop();
    for (size_t i = 0; i < contents.size(); ++i) {
      page_requests[i]->CancelAll("control_disconnected");
      contents[i]->Focus(false);
    }
    transfers.clear();
  }

  void OnWindowClosed() {
    widget = nullptr;
    if (quit)
      quit.Run();
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

base::DictValue HarnessMainParts::State::HandleControl(const base::DictValue& request) {
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
    for (const auto& [name, target] : {std::pair{"width", &next_width}, std::pair{"height", &next_height}}) {
      if (!request.Find(name)) continue;
      const auto value = request.FindInt(name);
      if (!value || *value < 16 || *value > 8192) return error("invalid_atlas_dimensions");
      *target = *value;
    }
    if (output && (next_width != logical_width || next_height != logical_height))
      return error("close_output_before_size_change");
    auto next_layout = Layout(specs, 0, next_width, next_height);
    if (!next_layout) return error("atlas_no_space");
    auto next_scale = output_scale;
    auto next_alignment = allocation_alignment;
    auto next_enabled = output_enabled;
    auto next_fps = output_fps;
    auto next_render_fps = render_fps;
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
    if (const auto* value = request.Find("fps")) {
      if (!value->is_int() || value->GetInt() < 1 || value->GetInt() > 120)
        return error("invalid_output_fps");
      next_fps = value->GetInt();
    }
    if (const auto* value = request.Find("render_fps")) {
      if (!value->is_int() || value->GetInt() < 0 || value->GetInt() > 60)
        return error("invalid_render_fps");
      next_render_fps = value->GetInt();
    }
    const auto dimensions = AtlasAllocationDimensions(next_width, next_height, next_scale, next_alignment);
    if (!dimensions) return error("atlas_resource_budget_exceeded");
    const bool layout_changed = logical_width != next_width || logical_height != next_height ||
                                output_scale != next_scale;
    logical_width = next_width; logical_height = next_height;
    output_scale = next_scale;
    allocation_alignment = next_alignment;
    for (size_t i = 0; i < contents.size(); ++i)
      contents[i]->ConfigureDevice(specs[i].width, specs[i].height, specs[i].tablet, PageScale(specs[i]), !demo);
    output_enabled = next_enabled;
    output_fps = next_fps;
    render_fps = next_render_fps;
    output_width = dimensions->width;
    output_height = dimensions->height;
    if (output)
      output->SetFps(output_fps);
    if (layout_changed) {
      if (root) root->SetPreferredSize(gfx::Size(logical_width, logical_height));
      if (widget) widget->SetSize(gfx::Size(logical_width, logical_height));
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
      const auto fps = request.FindInt("fps");
      if (!fps || *fps < 1 || *fps > 120)
        return error("invalid_output_fps");
      if (!output)
        output = std::make_unique<GpuAtlas>(output_width, output_height, ++output_generation);
      output_fps = *fps;
      output->SetFps(output_fps);
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
    if (output)
      output->Stop();
    output.reset();
    UpdateOutput();
    reply.Set("ok", true);
    return reply;
  }
  if (*method == "snapshot") {
    base::ListValue list;
    for (SessionId session_id : sessions) {
      const auto* session = endpoint.FindSession(session_id);
      base::ListValue views;
      for (const auto& [view_id, model] : session->views) {
        auto value = TokenValue(endpoint.Token(session_id, view_id).value);
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
          value.Set("width", specs[i].width);
          value.Set("height", specs[i].height);
          value.Set("device", specs[i].tablet ? "tablet" : "desktop");
          value.Set("deviceScaleFactor", PageScale(specs[i]));
          auto compositor = adapter->CompositorDiagnostics();
          if (output) compositor.Set("capture", output->CaptureStatus(view_id));
          value.Set("compositor", std::move(compositor));
          value.Set("visible", specs[i].visible);
          value.Set("lifecycle_uncertain", adapter->lifecycle_uncertain());
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
            std::set<base::ProcessId> pids;
            page->GetPrimaryMainFrame()->ForEachRenderFrameHost(
                [&](content::RenderFrameHost* frame) {
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
      list.Append(std::move(session_value));
    }
    reply.Set("ok", true);
    reply.Set("sessions", std::move(list));
    return reply;
  }
  if (*method == "view.create") {
    uint64_t session = 0, view = 0;
    if (!ReadId(request, "session", &session) || !ReadId(request, "view", &view) ||
        !endpoint.FindSession(session) || (!demo && session != sessions.front()))
      return error("invalid_session_or_view");
    if (closed_views.contains(view)) return error("view_id_closed");
    ViewSpec spec;
    spec.width = request.FindInt("width").value_or(0);
    spec.height = request.FindInt("height").value_or(0);
    const auto* url = request.FindString("url");
    const auto* device = request.FindString("device");
    if (!url || !GURL(*url).is_valid() || spec.width < 1 || spec.height < 1 ||
        spec.width > 8192 || spec.height > 8192 ||
        (device && *device != "desktop" && *device != "tablet") ||
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
    spec.tablet = device && *device == "tablet";
    for (size_t i = 0; i < contents.size(); ++i) {
      if (contents[i]->view_id() != view) continue;
      if (contents[i]->session_id() != session || specs[i] != spec)
        return error("view_id_configuration_conflict");
      reply.Set("ok", true);
      reply.Set("accepted", true);
      reply.Set("completed", true);
      reply.Set("token", TokenValue(endpoint.Token(session, view).value));
      return reply;
    }
    if (contents.size() >= kSharedAtlasMaxViews) return error("view_limit_reached");
    auto next = specs;
    next.push_back(spec);
    auto layout = Layout(next, view);
    if (!layout) return error("atlas_no_space");
    size_t owner = 0;
    while (owner < sessions.size() && sessions[owner] != session) ++owner;
    auto created = endpoint.CreateWebView(session, profiles[owner], view);
    if (!created) return error(created.status.message);
    auto adapter = std::make_unique<WebView>(contexts[owner].get(), &endpoint, session, view, offscreen);
    adapter->SetNativeFocusEnabled(demo &&
        !base::CommandLine::ForCurrentProcess()->HasSwitch("gpu-output"));
    adapter->ConfigureDevice(spec.width, spec.height, spec.tablet, PageScale(spec), !demo);
    auto requests = std::make_unique<PageRequests>();
    requests->Bind(adapter->contents());
    views::WebView* native = nullptr;
    if (!offscreen) {
      native = root->AddChildView(std::make_unique<views::WebView>(contexts[owner].get()));
      native->SetWebContents(adapter->contents());
    }
    contents.push_back(std::move(adapter));
    page_requests.push_back(std::move(requests));
    native_views.push_back(native);
    specs = std::move(next);
    ApplyLayout(layout.value);
    contents.back()->SetVisible(spec.visible);
    auto navigated = contents.back()->Navigate(GURL(spec.url));
    if (!navigated) {
      RemoveView(contents.size() - 1);
      return error(navigated.message);
    }
    reply.Set("ok", true);
    reply.Set("accepted", true);
    reply.Set("completed", true);
    reply.Set("token", TokenValue(endpoint.Token(session, view).value));
    return reply;
  }
  if (*method == "view.close") {
    uint64_t session = 0, view = 0;
    if (!ReadId(request, "session", &session) || !ReadId(request, "view", &view) ||
        !endpoint.FindSession(session)) return error("invalid_session_or_view");
    if (closed_views.contains(view)) {
      reply.Set("ok", true);
      reply.Set("accepted", true);
      reply.Set("completed", true);
      return reply;
    }
    size_t index = 0;
    while (index < contents.size() && (contents[index]->session_id() != session ||
                                      contents[index]->view_id() != view)) ++index;
    if (index == contents.size()) return error("view_not_in_session");
    if (request.Find("force") && !request.Find("force")->is_bool())
      return error("force_boolean_required");
    bool force = request.FindBool("force").value_or(false);
    if (force) RemoveView(index);
    else page_requests[index]->RequestClose();
    reply.Set("ok", true);
    reply.Set("accepted", true);
    reply.Set("completed", force);
    return reply;
  }
  uint64_t session = 0, view = 0;
  if (!ReadId(request, "session", &session) || !ReadId(request, "view", &view) ||
      !endpoint.FindWebView(session, view))
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
        page_requests[index]->close_state() == "closed") return error("view_closing");
    const auto* url = request.FindString("url");
    if (!url || !GURL(*url).is_valid()) return error("invalid_url");
    if (output) output->StopView(view);
    paused_output.insert(view); UpdateOutput();
    page_requests[index]->Bind(nullptr);
    if (native_views[index]) native_views[index]->SetWebContents(nullptr);
    const auto profile = endpoint.FindWebView(session, view)->profile;
    const auto owner = std::ranges::find(profiles, profile);
    if (owner == profiles.end()) return error("profile_missing");
    contents[index].reset();
    endpoint.ResetWebView(session, view);
    contents[index] = std::make_unique<WebView>(contexts[owner - profiles.begin()].get(), &endpoint, session, view, offscreen);
    contents[index]->SetNativeFocusEnabled(demo && !base::CommandLine::ForCurrentProcess()->HasSwitch("gpu-output"));
    contents[index]->ConfigureDevice(specs[index].width, specs[index].height, specs[index].tablet, PageScale(specs[index]), !demo);
    page_requests[index] = std::make_unique<PageRequests>();
    page_requests[index]->Bind(contents[index]->contents());
    if (native_views[index]) native_views[index]->SetWebContents(contents[index]->contents());
    contents[index]->SetVisible(specs[index].visible);
    const auto status = contents[index]->Navigate(GURL(*url));
    paused_output.erase(view); UpdateOutput();
    reply.Set("ok", static_cast<bool>(status)); reply.Set("accepted", static_cast<bool>(status));
    reply.Set("token", TokenValue(endpoint.Token(session, view).value)); return reply;
  }
  if (*method == "view.configure") {
    auto spec = specs[index];
    if (page_requests[index]->close_state() == "closing") return error("view_closing");
    if (request.Find("visible")) {
      if (!request.Find("visible")->is_bool()) return error("visible_boolean_required");
      spec.visible = *request.FindBool("visible");
    }
    if (request.Find("width")) spec.width = request.FindInt("width").value_or(0);
    if (request.Find("height")) spec.height = request.FindInt("height").value_or(0);
    if (const auto* device = request.FindString("device")) {
      if (*device != "desktop" && *device != "tablet") return error("invalid_device");
      spec.tablet = *device == "tablet";
    } else if (request.Find("device")) return error("invalid_device");
    if (request.Find("device_scale_factor")) {
      const auto scale = Number(request, "device_scale_factor");
      if (!scale || !std::isfinite(*scale) || *scale < 0.5 || *scale > 4)
        return error("invalid_page_device_scale_factor");
      spec.page_dsf = static_cast<float>(*scale);
    }
    if (spec.width < 1 || spec.height < 1 || spec.width > 8192 || spec.height > 8192)
      return error("invalid_viewport");
    if (spec == specs[index]) {
      reply.Set("ok", true); reply.Set("accepted", true); reply.Set("completed", true);
      reply.Set("token", TokenValue(endpoint.Token(session, view).value)); return reply;
    }
    auto next = specs;
    next[index] = spec;
    auto layout = Layout(next);
    if (!layout) return error("atlas_no_space");
    specs = std::move(next);
    ApplyLayout(layout.value);
    reply.Set("ok", true);
    reply.Set("accepted", true);
    reply.Set("completed", true);
    reply.Set("token", TokenValue(endpoint.Token(session, view).value));
    return reply;
  }
  if (*method == "profile.permissions" || *method == "profile.downloads") {
    const auto* command = request.FindDict("command");
    if (!command)
      return error("profile_command_required");
    auto profile = endpoint.FindWebView(session, view)->profile;
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
  if (*method == "page.requests" || *method == "page.reply" || *method == "page.command") {
    auto result = *method == "page.requests"
                      ? page_requests[index]->Snapshot()
                      : (*method == "page.reply" ? page_requests[index]->Reply(request)
                                                 : page_requests[index]->Command(request));
    result.Set("version", 1);
    result.Set("id", id);
    if (*method == "page.requests")
      result.Set("ok", true);
    return result;
  }
  if (page_requests[index]->close_state() == "closing")
    return error("view_closing");
  if (method->starts_with("navigation.")) {
    auto token = endpoint.Token(session, view).value;
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
  if (*method == "focus") {
    if (!demo && !request.Find("focus")) return error("focus_token_required");
    const auto current = endpoint.Token(session, view).value;
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
    status = adapter.SetVisible(*visible);
  } else if (*method == "navigate") {
    const auto* url = request.FindString("url");
    if (!url)
      return error("url_required");
    status = adapter.Navigate(GURL(*url));
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
    if (output) {
      paused_output.insert(view);
      output->StopView(view);
      UpdateOutput();
    }
    page_requests[index]->CancelAll("lifecycle_transition");
    if (*operation == Lifecycle::unload && native_views[index])
      native_views[index]->SetWebContents(nullptr);
    page_requests[index]->Bind(nullptr);
    status = adapter.RequestLifecycle(*operation);
    page_requests[index]->Bind(adapter.contents());
    if (native_views[index]) native_views[index]->SetWebContents(adapter.contents());
    paused_output.erase(view);
    UpdateOutput();
    reply.Set("accepted", static_cast<bool>(status));
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
    status = adapter.DispatchInput(input);
  }
  reply.Set("ok", static_cast<bool>(status));
  reply.Set("code", static_cast<int>(status.error));
  if (!status)
    reply.Set("error", status.message);
  reply.Set("token", TokenValue(endpoint.Token(session, view).value));
  UpdateOutput();
  return reply;
}

HarnessMainParts::HarnessMainParts() = default;
HarnessMainParts::~HarnessMainParts() = default;
int HarnessMainParts::PreMainMessageLoopRun() {
  state_ = std::make_unique<State>();
  const auto& command = *base::CommandLine::ForCurrentProcess();
#if defined(REMOTEKIT_DEMO_HARNESS)
  state_->demo = true;
#endif
  const auto host_mode = command.GetSwitchValueASCII("remotekit-render-host");
  if (!host_mode.empty() && host_mode != "offscreen" && host_mode != "window") return 2;
  state_->offscreen = !state_->demo && host_mode != "window";
  if (state_->offscreen) {
    CHECK(!display::Screen::HasScreen());
    state_->screen = CreateOffscreenScreen();
    display::Screen::SetScreenInstance(state_->screen.get());
    state_->output_fps = 60;
  } else if (!display::Screen::HasScreen()) {
    state_->screen = views::CreateDesktopScreen();
  }
  base::FilePath data = command.GetSwitchValuePath("data-path");
  if (data.empty()) {
    CHECK(base::PathService::Get(base::DIR_LOCAL_APP_DATA, &data));
    data = data.AppendASCII("RemoteKit").AppendASCII("demo");
  }
#if defined(REMOTEKIT_DEMO_HARNESS)
  state_->demo = true;
#endif
  uint64_t service_session = 0;
  if (!state_->demo && (!command.HasSwitch("control-channel") ||
      !base::StringToUint64(command.GetSwitchValueASCII("session-id"), &service_session) ||
      service_session == 0 || command.GetSwitchValueASCII("tenant-id").empty() ||
      !data.IsAbsolute() || !command.HasSwitch("data-path") || command.HasSwitch("sessions")))
    return 2;
  int session_count = 1;
#if defined(REMOTEKIT_DEMO_HARNESS)
  if (command.HasSwitch("sessions")) {
    CHECK(base::StringToInt(command.GetSwitchValueASCII("sessions"), &session_count));
    CHECK(session_count >= 1 && session_count <= 8);
  }
#endif
  for (int i = 0; i < session_count; ++i) {
    auto session = state_->endpoint.CreateSession(
        state_->demo ? "tenant-" + base::NumberToString(i + 1) :
                       command.GetSwitchValueASCII("tenant-id"),
        state_->demo ? 0 : service_session);
    CHECK(session);
    auto profile = state_->endpoint.AddProfile(session.value, "default");
    CHECK(profile);
    state_->sessions.push_back(session.value);
    state_->profiles.push_back(profile.value);
    state_->contexts.push_back(std::make_unique<BrowserContext>(
        data.AppendASCII("session-" + base::NumberToString(session.value))
            .AppendASCII("profile-" + base::NumberToString(profile.value))));
  }
  if (state_->demo) StartDevTools(data);
#if defined(REMOTEKIT_DEMO_HARNESS)
  auto urls = base::SplitString(command.GetSwitchValueASCII("urls"), "|", base::TRIM_WHITESPACE,
                                base::SPLIT_WANT_NONEMPTY);
  if (urls.empty())
    urls = {"https://example.com", "https://example.org"};
#else
  std::vector<std::string> urls;
#endif
  if (urls.size() > 8)
    return 2;
  std::vector<PackItem> items;
  for (size_t i = 0; i < urls.size(); ++i) {
    const size_t owner = i % state_->sessions.size();
    auto view = state_->endpoint.CreateWebView(state_->sessions[owner], state_->profiles[owner]);
    CHECK(view);
    items.push_back({view.value, 480, 360, 1.0});
  }
  // Pick a compact atlas shape, then use MaxRects for the actual placement.
  const int columns = urls.size() <= 2 ? std::max(1, static_cast<int>(urls.size())) : (urls.size() <= 4 ? 2 : 3);
  const int rows = (static_cast<int>(urls.size()) + columns - 1) / columns;
  int atlas_width = columns * 488, atlas_height = rows * 368;
  if (!state_->demo) {
    atlas_width = 1920;
    atlas_height = 1080;
    if ((command.HasSwitch("atlas-width") && !base::StringToInt(
            command.GetSwitchValueASCII("atlas-width"), &atlas_width)) ||
        (command.HasSwitch("atlas-height") && !base::StringToInt(
            command.GetSwitchValueASCII("atlas-height"), &atlas_height)) ||
        atlas_width < 16 || atlas_height < 16 || atlas_width > 8192 || atlas_height > 8192)
      return 2;
  }
  auto packed = PackAtlas(atlas_width, atlas_height, 4, items);
  CHECK(packed);
  int width = 0, height = 0;
  auto root = state_->offscreen ? nullptr : std::make_unique<views::View>();
  state_->root = root.get();
  for (size_t i = 0; i < urls.size(); ++i) {
    const size_t owner = i % state_->sessions.size();
    auto* context = state_->contexts[owner].get();
    auto contents = std::make_unique<WebView>(context, &state_->endpoint, state_->sessions[owner],
                                              items[i].view);
    contents->SetNativeFocusEnabled(!command.HasSwitch("gpu-output"));
    auto requests = std::make_unique<PageRequests>();
    requests->Bind(contents->contents());
    state_->page_requests.push_back(std::move(requests));
    auto* view = root->AddChildView(std::make_unique<views::WebView>(context));
    state_->native_views.push_back(view);
    view->SetWebContents(contents->contents());
    const auto& p = packed.value.placements[i];
    view->SetBounds(p.content.x, p.content.y, p.content.width, p.content.height);
    context->GetClientHintsControllerDelegate()->SetMostRecentMainFrameViewportSize(
        gfx::Size(p.content.width, p.content.height));
    state_->placements.emplace_back(p.content.x, p.content.y, p.content.width, p.content.height);
    width = std::max(width, p.outer.x + p.outer.width);
    height = std::max(height, p.outer.y + p.outer.height);
    CHECK(contents->SetVisible(true));
    CHECK(contents->Navigate(GURL(urls[i])));
    state_->specs.push_back({480, 360, false, urls[i]});
    state_->contents.push_back(std::move(contents));
  }
  if (!state_->demo) { width = atlas_width; height = atlas_height; }
  if (!state_->offscreen) {
  root->SetPreferredSize(gfx::Size(width, height));
  auto delegate = std::make_unique<views::WidgetDelegate>();
  delegate->SetTitle(u"RemoteKit — content embedder harness");
  const bool embedded = command.HasSwitch("parent-window");
  const bool frame_less = embedded || !state_->demo;
  delegate->SetHasWindowSizeControls(!frame_less);
  delegate->SetContentsView(std::move(root));
  auto* widget = new views::Widget();
  // Embedded and service HWNDs have no non-client area. Choose the Views
  // type before Init instead of leaving a titled widget's frame layout behind
  // when changing the Win32 style during reparenting.
  views::Widget::InitParams params(views::Widget::InitParams::NATIVE_WIDGET_OWNS_WIDGET,
                                   frame_less ? views::Widget::InitParams::TYPE_WINDOW_FRAMELESS
                                            : views::Widget::InitParams::TYPE_WINDOW);
  params.remove_standard_frame = frame_less;
  state_->window_delegate = std::move(delegate);
  params.delegate = state_->window_delegate.get();
  params.bounds = gfx::Rect(state_->demo ? 40 : -20000, state_->demo ? 40 : -20000,
                            width + (state_->demo ? 20 : 0),
                            height + (state_->demo ? 50 : 0));
  widget->Init(std::move(params));
  state_->widget = widget;
  state_->observer = std::make_unique<WindowObserver>(
      base::BindRepeating(&State::OnWindowClosed, base::Unretained(state_.get())));
  widget->AddObserver(state_->observer.get());
  if (embedded) {
    uint64_t parent_value = 0;
    CHECK(base::StringToUint64(command.GetSwitchValueASCII("parent-window"), &parent_value));
    HWND parent = reinterpret_cast<HWND>(static_cast<uintptr_t>(parent_value));
    CHECK(IsWindow(parent));
    CHECK(AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(parent),
                                       GetThreadDpiAwarenessContext()))
        << "Endpoint and browser must use the same Per-Monitor V2 DPI context";
    HWND child = widget->GetNativeWindow()->GetHost()->GetAcceleratedWidget();
    LONG_PTR style = GetWindowLongPtr(child, GWL_STYLE);
    SetWindowLongPtr(child, GWL_STYLE,
                     (style & ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU)) | WS_CHILD);
    SetLastError(0);
    HWND previous_parent = SetParent(child, parent);
    CHECK(previous_parent || GetLastError() == 0);
    RECT bounds;
    CHECK(GetClientRect(parent, &bounds));
    CHECK(SetWindowPos(child, nullptr, command.HasSwitch("gpu-output") ? -bounds.right * 2 : 0, 0,
                       bounds.right, bounds.bottom,
                       SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED));
  }
  if (!command.HasSwitch("no-window-show"))
    widget->Show();
  state_->output_scale = state_->demo ?
      GetDpiForWindow(widget->GetNativeWindow()->GetHost()->GetAcceleratedWidget()) / 96.0f : 1.0f;
  } else {
    state_->output_scale = 1.f;
  }
  state_->logical_width = width;
  state_->logical_height = height;
  const auto dimensions = AtlasAllocationDimensions(width, height, state_->output_scale, state_->allocation_alignment);
  if (!dimensions) return 1;
  state_->output_width = dimensions->width;
  state_->output_height = dimensions->height;
  state_->output_timer.Start(
      FROM_HERE, base::Milliseconds(8),
      base::BindRepeating([](State* state) { state->DrainClosed(); state->UpdateOutput(); },
                          base::Unretained(state_.get())));
  if (command.HasSwitch("control-channel")) {
    state_->control = std::make_unique<ControlServer>(
        command.GetSwitchValueASCII("control-channel"),
        base::BindRepeating(&State::HandleControl, base::Unretained(state_.get())),
        base::BindOnce(&State::OnControlClosed, base::Unretained(state_.get())));
  }
  return 0;
}
void HarnessMainParts::WillRunMainMessageLoop(std::unique_ptr<base::RunLoop>& run_loop) {
  state_->quit = run_loop->QuitClosure();
}
void HarnessMainParts::PostMainMessageLoopRun() {
  state_->control.reset();
  state_->output_timer.Stop();
  state_->output.reset();
  state_->page_requests.clear();
  StopDevTools();
  if (state_->widget)
    state_->widget->CloseNow();
  state_->window_delegate.reset();
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
