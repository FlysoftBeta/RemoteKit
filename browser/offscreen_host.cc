#include "remotekit/browser/offscreen_host.h"

#include <algorithm>
#include <cmath>
#include <map>

#include "base/check.h"
#include "base/no_destructor.h"
#include "base/functional/bind.h"
#include "base/timer/timer.h"
#include "base/strings/string_number_conversions.h"
#include "components/viz/common/frame_sinks/begin_frame_source.h"
#include "base/observer_list.h"
#include "base/scoped_observation.h"
#include "content/public/browser/web_contents.h"
#include "ui/aura/client/focus_change_observer.h"
#include "ui/aura/client/focus_client.h"
#include "ui/aura/client/window_parenting_client.h"
#include "ui/aura/window.h"
#include "ui/aura/window_observer.h"
#include "ui/base/ime/mock_input_method.h"
#include "ui/compositor/compositor.h"
#include "ui/display/display.h"
#include "ui/display/screen_base.h"
#include "ui/events/keycodes/dom/dom_code.h"

namespace remotekit::browser {
namespace {
// UI-sequence service display metrics; never inherit a monitor/RDP DPI.
std::map<aura::Window*, float>& OutputScales() {
  static base::NoDestructor<std::map<aura::Window*, float>> scales;
  return *scales;
}
float OutputScale(aura::Window* window) {
  if (!window) return 1.f;
  auto it = OutputScales().find(window->GetRootWindow());
  return it == OutputScales().end() ? 1.f : it->second;
}

// A self-held retiree is intentionally sealed if GPU completion is unknown.
// Destroying a queued task or the WebView owner cannot release its compositor.
class RetiredHost final : public std::enable_shared_from_this<RetiredHost> {
 public:
  explicit RetiredHost(std::unique_ptr<OffscreenHost> host) : host_(std::move(host)) {}
  void Start() {
    keepalive_ = shared_from_this();
    timer_.Start(FROM_HERE, base::Milliseconds(2),
                 base::BindRepeating(&RetiredHost::Poll, base::Unretained(this)));
  }
 private:
  void Poll() {
    auto protect = shared_from_this();
    if (!host_->CanDestroyGpuOutput()) return;
    timer_.Stop();
    host_.reset();
    keepalive_.reset();
  }
  std::unique_ptr<OffscreenHost> host_;
  base::RepeatingTimer timer_;
  std::shared_ptr<RetiredHost> keepalive_;
};

class ServiceScreen final : public display::ScreenBase {
 public:
  ServiceScreen() {
    display::Display screen(1, gfx::Rect(0, 0, 8192, 8192));
    screen.set_device_scale_factor(1.f);
    display_list().AddDisplay(screen, display::DisplayList::Type::PRIMARY);
  }
  gfx::Point GetCursorScreenPoint() override { return {}; }
  bool IsWindowUnderCursor(gfx::NativeWindow) override { return false; }
  gfx::NativeWindow GetWindowAtScreenPoint(const gfx::Point&) override { return nullptr; }
  gfx::NativeWindow GetLocalProcessWindowAtPoint(const gfx::Point&,
      const std::set<gfx::NativeWindow>&) override { return nullptr; }
  display::Display GetDisplayNearestWindow(gfx::NativeWindow window) const override {
    auto result = GetPrimaryDisplay();
    result.set_device_scale_factor(OutputScale(window));
    return result;
  }
  std::optional<float> GetPreferredScaleFactorForWindow(gfx::NativeWindow window) const override {
    return OutputScale(window);
  }
  bool IsHeadless() const override { return true; }
};

class FocusClient final : public aura::client::FocusClient,
                          public aura::WindowObserver {
 public:
  void AddObserver(aura::client::FocusChangeObserver* observer) override {
    observers_.AddObserver(observer);
  }
  void RemoveObserver(aura::client::FocusChangeObserver* observer) override {
    observers_.RemoveObserver(observer);
  }
  void FocusWindow(aura::Window* window) override {
    if (window == focused_ || (window && !window->CanFocus())) return;
    observation_.Reset();
    auto* old = focused_.get();
    focused_ = window;
    if (window) observation_.Observe(window);
    for (auto& observer : observers_) observer.OnWindowFocused(window, old);
    if (auto* observer = aura::client::GetFocusChangeObserver(old))
      observer->OnWindowFocused(window, old);
    if (auto* observer = aura::client::GetFocusChangeObserver(window))
      observer->OnWindowFocused(window, old);
  }
  void ResetFocusWithinActiveWindow(aura::Window* window) override {
    if (!window->Contains(focused_)) FocusWindow(window);
  }
  aura::Window* GetFocusedWindow() override { return focused_; }
  void OnWindowDestroying(aura::Window*) override { FocusWindow(nullptr); }
 private:
  raw_ptr<aura::Window> focused_ = nullptr;
  base::ScopedObservation<aura::Window, aura::WindowObserver> observation_{this};
  base::ObserverList<aura::client::FocusChangeObserver> observers_;
};

class ParentingClient final : public aura::client::WindowParentingClient {
 public:
  explicit ParentingClient(aura::Window* root) : root_(root) {
    aura::client::SetWindowParentingClient(root, this);
  }
  ~ParentingClient() override { aura::client::SetWindowParentingClient(root_, nullptr); }
  aura::Window* GetDefaultParent(aura::Window*, const gfx::Rect&, int64_t) override {
    return root_;
  }
 private:
  raw_ptr<aura::Window> root_;
};
}  // namespace

std::unique_ptr<display::Screen> CreateOffscreenScreen() {
  return std::make_unique<ServiceScreen>();
}

OffscreenHost::OffscreenHost(content::WebContents* contents,
                           const gfx::Size& viewport)
    : begin_frame_source_id_(viz::StubBeginFrameSource().source_id()) {
  SetNativeWindowOcclusionEnabled(false);
  // InputMethodMinimal is abstract on Windows (native IME/locale hooks).
  // Use the same no-native-IME implementation as the official headless factory.
  minimal_input_method_ = std::make_unique<ui::MockInputMethod>(this);
  SetSharedInputMethod(minimal_input_method_.get());
  CreateCompositor(false, true);
  compositor()->SetExternalBeginFrameControllerClientFactory(this);
  OnAcceleratedWidgetAvailable();
  focus_client_ = std::make_unique<FocusClient>();
  aura::client::SetFocusClient(window(), focus_client_.get());
  parenting_client_ = std::make_unique<ParentingClient>(window());
  InitHost();
  window()->Show();
  content_window_ = contents->GetNativeView();
  CHECK(content_window_);
  window()->AddChild(content_window_);
  content_window_->Show();
  SetViewport(viewport);
  compositor()->SetVisible(false);
}

OffscreenHost::~OffscreenHost() {
  Detach();
  parenting_client_.reset();
  OutputScales().erase(window());
  DestroyCompositor();
  DestroyDispatcher();
  SetSharedInputMethod(nullptr);
}

void OffscreenHost::SetViewport(const gfx::Size& viewport) {
  viewport_ = viewport;
  if (content_window_) content_window_->SetBounds(gfx::Rect(viewport));
  SetBoundsInPixels(gfx::Rect(gfx::Size(std::lround(viewport.width() * output_scale_),
                                     std::lround(viewport.height() * output_scale_))));
}

void OffscreenHost::SetOutputScale(float scale) {
  if (!std::isfinite(scale) || scale <= 0 || output_scale_ == scale) return;
  output_scale_ = scale;
  OutputScales()[window()] = scale;
  const auto old_bounds = bounds_;
  SetViewport(viewport_);
  // Even unchanged rounded pixel dimensions can carry a different DSF.
  if (bounds_ == old_bounds) OnHostResizedInPixels(bounds_.size());
}

void OffscreenHost::SetRenderDemand(bool enabled) {
  if (enabled_ == enabled) return;
  enabled_ = enabled;
  // Endpoint Begin admission is the only render clock. Visibility expresses
  // product demand and never creates a second, autonomous BeginFrame source.
  compositor()->SetVisible(enabled);
}

void OffscreenHost::Detach() {
  needs_begin_frame_callback_.Reset();
  begin_frame_receivers_.Clear();
  compositor()->SetExternalBeginFrameControllerClientFactory(nullptr);
  enabled_ = false;
  weak_factory_.InvalidateWeakPtrs();
  ClearFocus();
  if (content_window_) {
    // WebContents destroys its Aura view while this host is still alive.
    // Keep the parent link available for RWHVAura/IME teardown until then.
    content_window_ = nullptr;
  }
}

viz::BeginFrameArgs OffscreenHost::CreateBeginFrameArgs(base::TimeTicks now,
                                                       base::TimeDelta interval) {
  return viz::BeginFrameArgs::Create(BEGINFRAME_FROM_HERE, begin_frame_source_id_,
      ++begin_frame_sequence_, now, now + interval, interval, viz::BeginFrameArgs::NORMAL);
}

void OffscreenHost::SetNeedsBeginFrameCallback(base::RepeatingClosure callback) {
  needs_begin_frame_callback_ = std::move(callback);
}

mojo::PendingAssociatedRemote<viz::mojom::ExternalBeginFrameControllerClient>
OffscreenHost::CreateExternalBeginFrameControllerClient() {
  begin_frame_receivers_.Clear();
  begin_frame_demand_known_ = false;
  needs_begin_frames_ = false;
  mojo::PendingAssociatedRemote<viz::mojom::ExternalBeginFrameControllerClient> remote;
  begin_frame_receivers_.Add(this, remote.InitWithNewEndpointAndPassReceiver());
  ++begin_frame_binding_epoch_;
  // This list spans all renderer generations that ever configured this host.
  // Readiness is observed without pruning: a currently idle pool may be used
  // again later and must remain registered for the host's final retirement.
  if (begin_frame_binding_epoch_ > 1)
    for (auto& probe : gpu_retirement_probes_)
      if (!probe.Run()) rebound_with_unretired_gpu_work_ = true;
  if (begin_frame_binding_epoch_ > 1 && needs_begin_frame_callback_)
    needs_begin_frame_callback_.Run();
  return remote;
}

void OffscreenHost::SetNeedsBeginFrame(bool needs_begin_frames) {
  const bool changed = !begin_frame_demand_known_ || needs_begin_frames_ != needs_begin_frames;
  begin_frame_demand_known_ = true;
  needs_begin_frames_ = needs_begin_frames;
  if (changed && needs_begin_frame_callback_) needs_begin_frame_callback_.Run();
}

void OffscreenHost::NeedsBeginFrameWithId(int64_t display_id, bool needs_begin_frames) {
  SetNeedsBeginFrame(needs_begin_frames);
}

void OffscreenHost::SetPreferredInterval(base::TimeDelta interval) {
  // The official producer preference is diagnostic. Endpoint remains the only
  // admission clock; a preference update never issues a BeginFrame here.
  preferred_interval_ = interval;
}

void OffscreenHost::AddGpuRetirementProbe(base::RepeatingCallback<bool()> probe) {
  std::erase_if(gpu_retirement_probes_, [](auto& old) { return old.Run(); });
  gpu_retirement_probes_.push_back(std::move(probe));
}

bool OffscreenHost::CanDestroyGpuOutput() {
  std::erase_if(gpu_retirement_probes_, [](auto& probe) { return probe.Run(); });
  return gpu_retirement_probes_.empty();
}

void OffscreenHost::Retire(std::unique_ptr<OffscreenHost> host) {
  if (!host) return;
  host->Detach();
  std::make_shared<RetiredHost>(std::move(host))->Start();
}

void OffscreenHost::ClearFocus() { focus_client_->FocusWindow(nullptr); }

base::DictValue OffscreenHost::Diagnostics() const {
  return base::DictValue().Set("kind", "offscreen-aura")
      .Set("nativePageWindow", false).Set("acceleratedWidgetNull", true)
      .Set("hostDeviceScaleFactor", device_scale_factor())
      .Set("hostWidthPixels", bounds_.width()).Set("hostHeightPixels", bounds_.height())
      .Set("enabled", enabled_).Set("renderClock", "endpoint-begin-frame-source")
      .Set("needsBeginFrames", needs_begin_frames_)
      .Set("beginFrameDemandKnown", begin_frame_demand_known_)
      .Set("beginFrameSourceId", base::NumberToString(begin_frame_source_id_))
      .Set("beginFrameSequence", base::NumberToString(begin_frame_sequence_))
      .Set("beginFrameBindingEpoch", base::NumberToString(begin_frame_binding_epoch_))
      .Set("preferredIntervalUs", static_cast<double>(preferred_interval_.InMicroseconds()));
}

bool OffscreenHost::CanDispatchEvent(const ui::PlatformEvent&) { return false; }
uint32_t OffscreenHost::DispatchEvent(const ui::PlatformEvent&) { return 0; }
ui::EventSource* OffscreenHost::GetEventSource() { return this; }
gfx::AcceleratedWidget OffscreenHost::GetAcceleratedWidget() { return gfx::kNullAcceleratedWidget; }
void OffscreenHost::ShowImpl() {}
void OffscreenHost::HideImpl() {}
gfx::Rect OffscreenHost::GetBoundsInPixels() const { return bounds_; }
void OffscreenHost::SetBoundsInPixels(const gfx::Rect& bounds) {
  if (bounds_ == bounds) return;
  bounds_ = bounds;
  window()->SetBounds(bounds);
  OnHostResizedInPixels(bounds.size());
}
gfx::Point OffscreenHost::GetLocationOnScreenInPixels() const { return {}; }
void OffscreenHost::SetCapture() {}
void OffscreenHost::ReleaseCapture() {}
bool OffscreenHost::CaptureSystemKeyEventsImpl(std::optional<base::flat_set<ui::DomCode>>) { return false; }
void OffscreenHost::ReleaseSystemKeyEventCapture() {}
bool OffscreenHost::IsKeyLocked(ui::DomCode) { return false; }
base::flat_map<std::string, std::string> OffscreenHost::GetKeyboardLayoutMap() { return {}; }
void OffscreenHost::SetCursorNative(gfx::NativeCursor) {}
void OffscreenHost::MoveCursorToScreenLocationInPixels(const gfx::Point&) {}
void OffscreenHost::OnCursorVisibilityChangedNative(bool) {}
}  // namespace remotekit::browser
