#ifndef REMOTEKIT_BROWSER_OFFSCREEN_HOST_H_
#define REMOTEKIT_BROWSER_OFFSCREEN_HOST_H_

#include <memory>
#include <optional>

#include "base/memory/weak_ptr.h"
#include "base/timer/timer.h"
#include "base/values.h"
#include "ui/aura/window_tree_host.h"
#include "ui/events/platform/platform_event_dispatcher.h"

namespace content { class WebContents; }
namespace display { class Screen; }
namespace viz { struct BeginFrameAck; }
namespace ui { class InputMethod; }
namespace aura::client {
class FocusClient;
class WindowParentingClient;
}

namespace remotekit::browser {

std::unique_ptr<display::Screen> CreateOffscreenScreen();

// One WebContents, one virtual Aura root. No native page window is created.
class OffscreenHost final : public aura::WindowTreeHost,
                            public ui::PlatformEventDispatcher {
 public:
  explicit OffscreenHost(content::WebContents* contents, const gfx::Size& viewport);
  ~OffscreenHost() override;
  void SetViewport(const gfx::Size& viewport);
  void SetRenderDemand(bool enabled, uint32_t fps);
  void Detach();
  void ClearFocus();
  base::DictValue Diagnostics() const;

  bool CanDispatchEvent(const ui::PlatformEvent& event) override;
  uint32_t DispatchEvent(const ui::PlatformEvent& event) override;
  ui::EventSource* GetEventSource() override;
  gfx::AcceleratedWidget GetAcceleratedWidget() override;
  void ShowImpl() override;
  void HideImpl() override;
  gfx::Rect GetBoundsInPixels() const override;
  void SetBoundsInPixels(const gfx::Rect& bounds) override;
  gfx::Point GetLocationOnScreenInPixels() const override;
  void SetCapture() override;
  void ReleaseCapture() override;
  bool CaptureSystemKeyEventsImpl(std::optional<base::flat_set<ui::DomCode>> codes) override;
  void ReleaseSystemKeyEventCapture() override;
  bool IsKeyLocked(ui::DomCode code) override;
  base::flat_map<std::string, std::string> GetKeyboardLayoutMap() override;
  void SetCursorNative(gfx::NativeCursor cursor) override;
  void MoveCursorToScreenLocationInPixels(const gfx::Point& location) override;
  void OnCursorVisibilityChangedNative(bool show) override;

 private:
  void Tick();
  void OnAck(uint64_t generation, uint64_t sequence, const viz::BeginFrameAck& ack);
  gfx::Rect bounds_;
  const uint64_t source_id_;
  raw_ptr<aura::Window> content_window_ = nullptr;
  std::unique_ptr<aura::client::FocusClient> focus_client_;
  std::unique_ptr<aura::client::WindowParentingClient> parenting_client_;
  std::unique_ptr<ui::InputMethod> minimal_input_method_;
  base::RepeatingTimer timer_;
  base::TimeDelta interval_ = base::Hertz(60);
  uint32_t configured_fps_ = 60;
  bool enabled_ = false, pending_ = false, tick_due_ = false;
  uint64_t generation_ = 1, sequence_ = 0, sent_ = 0, acked_ = 0;
  uint64_t merged_ = 0, aborted_ = 0;
  base::WeakPtrFactory<OffscreenHost> weak_factory_{this};
};
}  // namespace remotekit::browser
#endif
