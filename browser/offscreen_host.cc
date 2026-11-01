#include "remotekit/browser/offscreen_host.h"

#include <algorithm>

#include "base/check.h"
#include "base/functional/bind.h"
#include "base/observer_list.h"
#include "base/scoped_observation.h"
#include "base/strings/string_number_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "base/task/task_features.h"
#include "components/viz/common/frame_sinks/begin_frame_args.h"
#include "components/viz/common/frame_sinks/begin_frame_source.h"
#include "content/public/browser/web_contents.h"
#include "mojo/public/cpp/bindings/callback_helpers.h"
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
uint64_t g_begin_frame_sequence = 0;  // UI sequence, unique across page hosts.

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
  display::Display GetDisplayNearestWindow(gfx::NativeWindow) const override {
    return GetPrimaryDisplay();
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
    : source_id_(viz::StubBeginFrameSource().source_id()) {
  // Allocate in the browser's non-restartable source domain. Viz uses its
  // positive GPU-host restart id. A shared kManualSourceId makes Viz's global
  // frame-sink observer mistake another page host's pending frames for ours.
  SetNativeWindowOcclusionEnabled(false);
  // InputMethodMinimal is abstract on Windows (native IME/locale hooks).
  // Use the same no-native-IME implementation as the official headless factory.
  minimal_input_method_ = std::make_unique<ui::MockInputMethod>(this);
  SetSharedInputMethod(minimal_input_method_.get());
  CreateCompositor(false, true);
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
  DestroyCompositor();
  DestroyDispatcher();
  SetSharedInputMethod(nullptr);
}

void OffscreenHost::SetViewport(const gfx::Size& viewport) {
  if (content_window_) content_window_->SetBounds(gfx::Rect(viewport));
  SetBoundsInPixels(gfx::Rect(viewport));
}

void OffscreenHost::SetRenderDemand(bool enabled, uint32_t fps) {
  const auto interval = base::Hertz(std::clamp(fps, 1u, 120u));
  if (enabled_ == enabled && interval_ == interval) return;
  enabled_ = enabled;
  configured_fps_ = std::clamp(fps, 1u, 120u);
  interval_ = interval;
  timer_.Stop();
  compositor()->SetVisible(enabled);
  if (!enabled) { tick_due_ = false; return; }
  // Establish a new phase on demand/fps changes. The first frame refreshes
  // immediately; subsequent ticks stay on this absolute phase.
  next_deadline_ = base::TimeTicks::Now() + interval_;
  tick_due_ = true;
  MaybeIssueFrame();
  ArmDeadline();
}

void OffscreenHost::Detach() {
  enabled_ = false;
  timer_.Stop();
  weak_factory_.InvalidateWeakPtrs();
  ClearFocus();
  if (content_window_) {
    // WebContents destroys its Aura view while this host is still alive.
    // Keep the parent link available for RWHVAura/IME teardown until then.
    content_window_ = nullptr;
  }
}

void OffscreenHost::ClearFocus() { focus_client_->FocusWindow(nullptr); }

void OffscreenHost::ArmDeadline() {
  if (!enabled_) return;
  const auto remaining = next_deadline_ - base::TimeTicks::Now();
  const auto maximum = base::kMaxPreciseDelay.Get();
  if (maximum <= base::Microseconds(1)) {
    // An override can disable precision altogether. Keep one cancellable
    // coarse task instead of repeatedly pre-waking at the same deadline.
    timer_.Start(FROM_HERE, next_deadline_, this, &OffscreenHost::Tick,
                 base::subtle::DelayPolicy::kFlexibleNoSooner);
    return;
  }
  // The scheduler downgrades precise delays >= maximum. Default 36ms gives
  // a 32ms precise window; smaller configured thresholds retain a margin too.
  const auto window = std::min(base::Milliseconds(32),
      maximum - std::max(base::Microseconds(1),
                        std::min(base::Milliseconds(4), maximum / 2)));
  if (remaining > window) {
    timer_.Start(FROM_HERE, next_deadline_ - window, this,
                 &OffscreenHost::OnCoarseWake,
                 base::subtle::DelayPolicy::kFlexibleNoSooner);
  } else {
    timer_.Start(FROM_HERE, next_deadline_, this, &OffscreenHost::Tick,
                 base::subtle::DelayPolicy::kPrecise);
  }
}

void OffscreenHost::OnCoarseWake() {
  ++coarse_wakes_;
  ArmDeadline();  // A pre-wake never issues a BeginFrame.
}

void OffscreenHost::Tick() {
  if (!enabled_) return;
  const auto now = base::TimeTicks::Now();
  if (now < next_deadline_) { ArmDeadline(); return; }
  const int64_t missed = (now - next_deadline_).IntDiv(interval_);
  skipped_ticks_ += missed;
  next_deadline_ += interval_ * (missed + 1);
  tick_due_ = true;
  if (pending_) ++merged_;
  else MaybeIssueFrame();
  ArmDeadline();  // Skip obsolete phase slots; never replay them in a burst.
}

void OffscreenHost::MaybeIssueFrame() {
  if (!enabled_ || pending_ || !tick_due_) return;
  tick_due_ = false;
  pending_ = true;
  sequence_ = ++g_begin_frame_sequence;
  ++sent_;
  const auto now = base::TimeTicks::Now();
  auto args = viz::BeginFrameArgs::Create(BEGINFRAME_FROM_HERE,
      source_id_, sequence_, now, now + interval_,
      interval_, viz::BeginFrameArgs::NORMAL);
  compositor()->IssueExternalBeginFrame(args,
      mojo::WrapCallbackWithDefaultInvokeIfNotRun(
          base::BindOnce(&OffscreenHost::OnAck, weak_factory_.GetWeakPtr(),
                         generation_, sequence_), viz::BeginFrameAck()));
}

void OffscreenHost::OnAck(uint64_t generation, uint64_t sequence,
                          const viz::BeginFrameAck& ack) {
  if (!pending_ || generation != generation_ || sequence != sequence_) return;
  pending_ = false;
  if (ack.frame_id.source_id != source_id_ ||
      ack.frame_id.sequence_number != sequence) {
    // Controller disconnection cancels only pacer admission, never a GPU lease.
    ++generation_;
    ++aborted_;
    tick_due_ = false;
    return;  // Retry on the next timer tick, avoiding a disconnected-pipe loop.
  }
  ++acked_;
  if (enabled_ && tick_due_)
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&OffscreenHost::MaybeIssueFrame, weak_factory_.GetWeakPtr()));
}

base::DictValue OffscreenHost::Diagnostics() const {
  return base::DictValue().Set("kind", "offscreen-aura")
      .Set("nativePageWindow", false).Set("acceleratedWidgetNull", true)
      .Set("hostDeviceScaleFactor", device_scale_factor())
      .Set("hostWidthPixels", bounds_.width()).Set("hostHeightPixels", bounds_.height())
      .Set("enabled", enabled_).Set("pendingBeginFrame", pending_)
      .Set("pacerFps", interval_.ToHz()).Set("controllerGeneration", base::NumberToString(generation_))
      .Set("configuredFps", static_cast<int>(configured_fps_))
      .Set("sampleTimeTicksUs", base::NumberToString(base::TimeTicks::Now().since_origin().InMicroseconds()))
      .Set("timerKind", "absolute-deadline")
      .Set("maxPreciseDelayUs", base::NumberToString(base::kMaxPreciseDelay.Get().InMicroseconds()))
      .Set("coarseWakes", base::NumberToString(coarse_wakes_))
      .Set("skippedPhaseTicks", base::NumberToString(skipped_ticks_))
      .Set("beginFrameSourceId", base::NumberToString(source_id_))
      .Set("lastSequence", base::NumberToString(sequence_)).Set("sent", base::NumberToString(sent_))
      .Set("acked", base::NumberToString(acked_)).Set("merged", base::NumberToString(merged_))
      .Set("cancelled", base::NumberToString(aborted_));
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
