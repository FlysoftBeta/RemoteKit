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
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/path_service.h"
#include "base/run_loop.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "base/task/current_thread.h"
#include "base/timer/timer.h"
#include "base/unguessable_token.h"
#include "build/build_config.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/gpu_data_manager.h"
#include "gpu/config/gpu_info.h"
#include "content/public/browser/browser_task_traits.h"
#include "content/public/browser/browser_thread.h"
#include "components/headless/clipboard/headless_clipboard.h"
#include "ui/base/clipboard/clipboard.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_process_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_delegate.h"
#include "remotekit/browser/browser_context.h"
#include "remotekit/browser/profile_key.h"
#include "remotekit/browser/control_server.h"
#include "remotekit/browser/osr_renderer.h"
#include "remotekit/browser/page_requests.h"
#include "remotekit/browser/offscreen_host.h"
#include "remotekit/browser/webview.h"
#include "remotekit/browser/view_model.h"
#include "browser/view_registry.h"
#include "browser/touch_selection.h"
#include "browser/layout_transaction.h"
#include "browser/popup_registry.h"
#include "browser/closed_views.h"
#include "browser/navigation_transfer.h"
#include "browser/control_response.h"
#include "protocol/atlas_dimensions.hpp"
#include "remotekit/protocol/control.h"
#include "ui/display/screen.h"
#include "url/gurl.h"

namespace remotekit::browser {
static_assert(static_cast<int>(ErrorCode::busy) == protocol::kBusyError);
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

BrowserRuntime::BrowserRuntime() {
  CHECK(!ui::TouchSelectionMenuRunner::GetInstance());
  selection_menu = std::make_unique<RemoteTouchSelectionMenuRunner>(views);
  content::GpuDataManager::GetInstance()->AddObserver(this);
}
void BrowserRuntime::OnGpuInfoUpdate() {
  auto* manager = content::GpuDataManager::GetInstance();
  const auto info = manager->GetGPUInfo();
  const auto& active = info.active_gpu();
  LOG(INFO) << "RemoteKit GPU init ANGLE=" << info.gl_renderer
            << " adapter=" << active.device_string << " luid=" << active.luid.HighPart << ","
            << active.luid.LowPart
            << " hardware=" << (!active.IsSoftwareRenderer() && !info.UsesSwiftShader())
            << " compositing=" << manager->GetFeatureStatus(gpu::GPU_FEATURE_TYPE_ACCELERATED_GL)
            << " rasterization="
            << manager->GetFeatureStatus(gpu::GPU_FEATURE_TYPE_GPU_TILE_RASTERIZATION);
}
BrowserRuntime::~BrowserRuntime() {
  content::GpuDataManager::GetInstance()->RemoveObserver(this);
  // PostMainMessageLoopRun also runs after a partial PreMain startup failure.
  // Contexts must never be left to implicit member destruction order.
  CHECK(popups.pending.empty());
  CHECK(views.records.empty());
  CHECK(contexts.empty());
}
void BrowserRuntime::RemoveView(WebViewId index) {
  views.records.at(index).webview->SetSessionStorageShouldPersist(false);
  const auto session = views.records.at(index).webview->session_id();
  const auto view = views.records.at(index).webview->view_id();
  closed.Record(session, view, views.records.at(index).requests->close_reason());
  std::erase_if(popups.adopted, [view](const auto& item) { return item.second == view; });
  if (output)
    output->StopView(view);
  paused_output.insert(view);
  UpdateOutput();
  views.records.at(index).requests->Bind(nullptr);
  views.Remove(index);
  navigation_transfers.records.erase(view);
  paused_output.erase(view);
  view_model.RemoveWebView(session, view);
  auto layout = layout_transaction.Prepare(views.Specs());
  if (layout)
    layout_transaction.Commit(std::move(layout.value));
  UpdateOutput();
}
void BrowserRuntime::DrainClosed() {
  popups.Prune();
  std::vector<WebViewId> closed_ids;
  for (const auto& [id, record] : views.records)
    if (record.requests->close_state() == "closed")
      closed_ids.push_back(id);
  for (auto id : closed_ids)
    RemoveView(id);
}
Status BrowserRuntime::CanDiscard(WebViewId index) const {
  if (views.records.at(index).requests->close_state() == "closing" ||
      views.records.at(index).requests->close_state() == "closed")
    return {ErrorCode::unavailable, "WebView is closing"};
  if (views.records.at(index).requests->pending_count())
    return {ErrorCode::busy, "Page request pending"};
  return views.records.at(index).webview->CanDiscard();
}
void BrowserRuntime::UpdateOutput() {
  for (auto& [i, record] : views.records) {
    const auto& adapter = record.webview;
    if (adapter->offscreen_host())
      adapter->offscreen_host()->SetOutputScale(layout_transaction.output_scale);
    adapter->RefreshBackingScale();
    const auto* model = view_model.FindWebView(adapter->session_id(), adapter->view_id());
    adapter->SetRenderDemand(output && output_enabled && record.spec.visible && model &&
                             model->actual == Residency::live && !model->pending &&
                             !paused_output.contains(adapter->view_id()));
  }
  if (!output)
    return;
  std::vector<OsrRenderer::View> render_views;
  for (auto& [i, record] : views.records) {
    if (!record.spec.visible)
      continue;
    auto& adapter = *record.webview;
    const auto token = view_model.Token(adapter.session_id(), adapter.view_id());
    const auto* model = view_model.FindWebView(adapter.session_id(), adapter.view_id());
    if (!token || !model)
      continue;
    const auto& p = record.placement.content;
    OsrRenderer::View view;
    view.metadata.session_id = token.value.session;
    view.metadata.webview_id = token.value.view;
    view.metadata.instance_generation = token.value.instance;
    view.metadata.document_generation = token.value.document;
    view.metadata.focus_generation = token.value.focus;
    view.metadata.x_pixels = std::lround(p.x * layout_transaction.output_scale);
    view.metadata.y_pixels = std::lround(p.y * layout_transaction.output_scale);
    view.metadata.width_pixels =
        std::lround((p.x + p.width) * layout_transaction.output_scale) - view.metadata.x_pixels;
    view.metadata.height_pixels =
        std::lround((p.y + p.height) * layout_transaction.output_scale) - view.metadata.y_pixels;
    view.metadata.atlas_pixels_per_dip = layout_transaction.output_scale;
    view.metadata.page_device_scale_factor = layout_transaction.PageScale(record.spec);
    view.metadata.text_input = adapter.TextInputState();
    view.metadata.selection_menu =
        selection_menu->StateFor(adapter.session_id(), adapter.view_id());
    view.offscreen_host = adapter.offscreen_host();
    view.render_enabled = adapter.contents() && model->actual == Residency::live &&
                          !model->pending && output_enabled &&
                          !paused_output.contains(adapter.view_id());
    render_views.push_back(std::move(view));
  }
  output->SetViews(std::move(render_views));
}
mojo::ScopedMessagePipeHandle BrowserRuntime::TakeControlAttachment(const base::DictValue& request,
                                                                    const base::DictValue& reply) {
  uint64_t pid = 0;
  const auto* token = reply.FindString("render_channel");
  const auto* pid_text = request.FindString("consumer_pid");
  if (!output || !token || !pid_text || !base::StringToUint64(*pid_text, &pid) || !pid ||
      pid > UINT32_MAX)
    return {};
  return output->TakeRenderEndpoint(*token, static_cast<uint32_t>(pid));
}
void BrowserRuntime::OnControlClosed() {
  if (shutting_down)
    return;
  output_enabled = false;
  for (const auto& [id, record] : views.records)
    record.webview->SetRenderDemand(false);
  if (output)
    output->Stop();
  for (auto& [i, record] : views.records) {
    record.requests->CancelAll("control_disconnected");
    record.webview->Focus(false);
  }
  navigation_transfers.records.clear();
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
namespace {
// PathService key for --data-path; above the ranges used by base, content and chrome.
constexpr int kDataPathKey = 16000;
}  // namespace

int RemoteKitMainParts::PreMainMessageLoopRun() {
  LOG(INFO) << "RemoteKit startup PreMain entered";
  state_ = std::make_unique<BrowserRuntime>();
  const auto& command = *base::CommandLine::ForCurrentProcess();
  CHECK(!display::Screen::HasScreen());
  state_->screen = CreateOffscreenScreen();
  display::Screen::SetScreenInstance(state_->screen.get());
  const base::FilePath data = command.GetSwitchValuePath("data-path");
  auto profile_key = ProfileKey::ReadFromCommandLine(command);
  if (!profile_key)
    return 2;
  uint64_t service_session = 0;
  if (!command.HasSwitch("control-channel") ||
      !base::StringToUint64(command.GetSwitchValueASCII("session-id"), &service_session) ||
      service_session == 0 || command.GetSwitchValueASCII("tenant-id").empty() ||
      !data.IsAbsolute())
    return 2;
#if BUILDFLAG(IS_WIN)
  // Writable files handed to renderers (the File System API among them) get a deny-execute
  // ACE, which base only permits under TEMP and one embedder data root; without this a page
  // using those APIs fails a CHECK when the data path lies elsewhere.
  CHECK(base::PathService::Override(kDataPathKey, data));
  base::SetExtraNoExecuteAllowedPath(kDataPathKey);
#endif
  auto session =
      state_->view_model.CreateSession(command.GetSwitchValueASCII("tenant-id"), service_session);
  CHECK(session);
  auto profile = state_->view_model.AddProfile(session.value, "default");
  CHECK(profile);
  state_->session_id = session.value;
  state_->profiles.push_back(profile.value);
  state_->contexts.push_back(std::make_unique<BrowserContext>(
      data.AppendASCII("session-" + base::NumberToString(session.value))
          .AppendASCII("profile-" + base::NumberToString(profile.value)),
      std::move(profile_key)));
  LOG(INFO) << "RemoteKit startup Profile ready";
  int width = 1920, height = 1080;
  if ((command.HasSwitch("atlas-width") &&
       !base::StringToInt(command.GetSwitchValueASCII("atlas-width"), &width)) ||
      (command.HasSwitch("atlas-height") &&
       !base::StringToInt(command.GetSwitchValueASCII("atlas-height"), &height)) ||
      width < 16 || height < 16 || width > 8192 || height > 8192)
    return 2;
  state_->layout_transaction.logical_width = width;
  state_->layout_transaction.logical_height = height;
  const auto dimensions =
      protocol::AtlasAllocationDimensions(width, height, state_->layout_transaction.output_scale,
                                          state_->layout_transaction.allocation_alignment);
  if (!dimensions)
    return 1;
  state_->layout_transaction.output_width = dimensions->width;
  state_->layout_transaction.output_height = dimensions->height;
  state_->output_timer.Start(FROM_HERE, base::Milliseconds(8),
                             base::BindRepeating(
                                 [](BrowserRuntime* state) {
                                   state->DrainClosed();
                                   state->UpdateOutput();
                                 },
                                 base::Unretained(state_.get())));
  state_->dispatcher = std::make_unique<ControlDispatcher>(*state_);
  state_->control = std::make_unique<ControlServer>(
      command.GetSwitchValueASCII("control-channel"),
      base::BindRepeating(&ControlDispatcher::Dispatch, base::Unretained(state_->dispatcher.get())),
      base::BindRepeating(&BrowserRuntime::TakeControlAttachment, base::Unretained(state_.get())),
      base::BindOnce(&BrowserRuntime::OnControlClosed, base::Unretained(state_.get())));
  LOG(INFO) << "RemoteKit startup control ready";
  return 0;
}
void RemoteKitMainParts::WillRunMainMessageLoop(std::unique_ptr<base::RunLoop>& run_loop) {
  state_->quit = run_loop->QuitClosure();
}
void RemoteKitMainParts::PostMainMessageLoopRun() {
  if (!state_)
    return;
  state_->VerifyShutdownComplete();
  state_->shutting_down = true;
  state_->quit.Reset();
  // Stop producers and invalidate page callbacks before destroying consumers.
  state_->output_timer.Stop();
  state_->control.reset();
  state_->dispatcher.reset();
  state_->storage_import_jobs.Clear();
  state_->output.reset();
  state_->views.Clear();
  state_->popups.Clear();
  // Offscreen compositor teardown can make sync Mojo calls. Run the deferred
  // deletions after WebContents destruction and before its virtual Screen dies.
  base::RunLoop().RunUntilIdle();
  state_->contexts.clear();
  if (state_->screen && display::Screen::Get() == state_->screen.get())
    display::Screen::SetScreenInstance(nullptr);
  state_.reset();
}
}  // namespace remotekit::browser
