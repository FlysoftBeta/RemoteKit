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
#include "remotekit/browser/webview.h"
#include "remotekit/endpoint/include/remotekit/core.hpp"
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
  bool output_enabled = true;
  uint32_t output_fps = 30;
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
    if (!output)
      return;
    std::vector<GpuAtlas::View> views;
    for (size_t i = 0; i < contents.size(); ++i) {
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
      view.metadata.device_scale_factor = output_scale;
      view.metadata.text_input = adapter.TextInputState();
      view.contents = adapter.contents();
      view.capture_enabled = adapter.contents() && model->actual == Residency::live &&
                             !model->pending && output_enabled &&
                             !paused_output.contains(adapter.view_id());
      views.push_back(std::move(view));
    }
    output->SetViews(std::move(views));
  }
  void OnControlClosed() {
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
    auto next_scale = output_scale;
    auto next_enabled = output_enabled;
    auto next_fps = output_fps;
    if (request.Find("device_scale")) {
      if (!scale || !std::isfinite(*scale) || *scale < 0.5 || *scale > 4)
        return error("invalid_device_scale");
      if (output)
        return error("close_output_before_scale_change");
      next_scale = static_cast<float>(*scale);
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
    output_scale = next_scale;
    output_enabled = next_enabled;
    output_fps = next_fps;
    output_width = std::ceil(logical_width * output_scale);
    output_height = std::ceil(logical_height * output_scale);
    if (output)
      output->SetFps(output_fps);
    UpdateOutput();
    reply.Set("ok", true);
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
    reply.Set("output", output->Status());
    return reply;
  }
  if (*method == "output.close") {
    if (output)
      output->Stop();
    output.reset();
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
          value.Set("lifecycle_uncertain", adapter->lifecycle_uncertain());
          auto touch = adapter->TouchInjectionStatus();
          value.Set("touch_code", static_cast<int>(touch.error));
          value.Set("touch_detail", touch.message);
          value.Set("pending_page_requests", static_cast<int>(page_requests[i]->pending_count()));
          if (auto* page = adapter->contents()) {
            value.Set("url", page->GetLastCommittedURL().spec());
            value.Set("loading", page->IsLoading());
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
    const auto current = endpoint.Token(session, view).value;
    for (auto [key, expected] :
         {std::pair{"instance", current.instance}, std::pair{"document", current.document}}) {
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
    if (*operation == Lifecycle::unload)
      native_views[index]->SetWebContents(nullptr);
    page_requests[index]->Bind(nullptr);
    status = adapter.RequestLifecycle(*operation);
    page_requests[index]->Bind(adapter.contents());
    native_views[index]->SetWebContents(adapter.contents());
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
          clicks > 3 || (*action != "move" && clicks == 0))
        return error("invalid_mouse");
      MouseInput::Action kind;
      if (*action == "move")
        kind = MouseInput::Action::move;
      else if (*action == "down")
        kind = MouseInput::Action::down;
      else if (*action == "up")
        kind = MouseInput::Action::up;
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
  if (!display::Screen::HasScreen())
    state_->screen = views::CreateDesktopScreen();
  const auto& command = *base::CommandLine::ForCurrentProcess();
  base::FilePath data = command.GetSwitchValuePath("data-path");
  if (data.empty()) {
    CHECK(base::PathService::Get(base::DIR_LOCAL_APP_DATA, &data));
    data = data.AppendASCII("RemoteKit").AppendASCII("demo");
  }
  int session_count = 1;
  if (command.HasSwitch("sessions")) {
    CHECK(base::StringToInt(command.GetSwitchValueASCII("sessions"), &session_count));
    CHECK(session_count >= 1 && session_count <= 8);
  }
  for (int i = 0; i < session_count; ++i) {
    auto session = state_->endpoint.CreateSession("tenant-" + base::NumberToString(i + 1));
    CHECK(session);
    auto profile = state_->endpoint.AddProfile(session.value, "default");
    CHECK(profile);
    state_->sessions.push_back(session.value);
    state_->profiles.push_back(profile.value);
    state_->contexts.push_back(std::make_unique<BrowserContext>(
        data.AppendASCII("session-" + base::NumberToString(session.value))
            .AppendASCII("profile-" + base::NumberToString(profile.value))));
  }
  StartDevTools(data);
  auto urls = base::SplitString(command.GetSwitchValueASCII("urls"), "|", base::TRIM_WHITESPACE,
                                base::SPLIT_WANT_NONEMPTY);
  if (urls.empty())
    urls = {"https://example.com", "https://example.org"};
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
  const int columns = urls.size() <= 2 ? static_cast<int>(urls.size()) : (urls.size() <= 4 ? 2 : 3);
  const int rows = (static_cast<int>(urls.size()) + columns - 1) / columns;
  auto packed = PackAtlas(columns * 488, rows * 368, 4, items);
  CHECK(packed);
  int width = 0, height = 0;
  auto root = std::make_unique<views::View>();
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
    state_->contents.push_back(std::move(contents));
  }
  root->SetPreferredSize(gfx::Size(width, height));
  auto delegate = std::make_unique<views::WidgetDelegate>();
  delegate->SetTitle(u"RemoteKit — content embedder harness");
  const bool embedded = command.HasSwitch("parent-window");
  delegate->SetHasWindowSizeControls(!embedded);
  delegate->SetContentsView(std::move(root));
  auto* widget = new views::Widget();
  // The embedded HWND has no non-client area. Choose the corresponding Views
  // type before Init instead of leaving a titled widget's frame layout behind
  // when changing the Win32 style during reparenting.
  views::Widget::InitParams params(views::Widget::InitParams::NATIVE_WIDGET_OWNS_WIDGET,
                                   embedded ? views::Widget::InitParams::TYPE_WINDOW_FRAMELESS
                                            : views::Widget::InitParams::TYPE_WINDOW);
  params.remove_standard_frame = embedded;
  state_->window_delegate = std::move(delegate);
  params.delegate = state_->window_delegate.get();
  params.bounds = gfx::Rect(40, 40, width + 20, height + 50);
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
  state_->output_scale =
      GetDpiForWindow(widget->GetNativeWindow()->GetHost()->GetAcceleratedWidget()) / 96.0f;
  state_->logical_width = width;
  state_->logical_height = height;
  state_->output_width = std::ceil(width * state_->output_scale);
  state_->output_height = std::ceil(height * state_->output_scale);
  state_->output_timer.Start(
      FROM_HERE, base::Milliseconds(8),
      base::BindRepeating(&State::UpdateOutput, base::Unretained(state_.get())));
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
  state_->contexts.clear();
  state_.reset();
}
}  // namespace remotekit::browser
