#ifndef REMOTEKIT_BROWSER_OFFSCREEN_HOST_H_
#define REMOTEKIT_BROWSER_OFFSCREEN_HOST_H_

#include <memory>
#include <optional>
#include <vector>

#include "base/functional/callback.h"

#include "base/memory/weak_ptr.h"
#include "base/values.h"
#include "components/viz/common/frame_sinks/begin_frame_args.h"
#include "mojo/public/cpp/bindings/associated_receiver_set.h"
#include "services/viz/privileged/mojom/compositing/external_begin_frame_controller.mojom.h"
#include "ui/compositor/compositor.h"
#include "ui/aura/window_tree_host.h"
#include "ui/events/platform/platform_event_dispatcher.h"

namespace content {
class WebContents;
}
namespace display {
class Screen;
}
namespace viz {
struct BeginFrameAck;
}
namespace ui {
class InputMethod;
}
namespace aura::client {
class FocusClient;
class WindowParentingClient;
}  // namespace aura::client

namespace remotekit::browser {

std::unique_ptr<display::Screen> CreateOffscreenScreen();

// One WebContents, one virtual Aura root. No native page window is created.
class OffscreenHost final : public aura::WindowTreeHost,
                            public ui::PlatformEventDispatcher,
                            public ui::ExternalBeginFrameControllerClientFactory,
                            public viz::mojom::ExternalBeginFrameControllerClient {
 public:
  explicit OffscreenHost(content::WebContents* contents, const gfx::Size& viewport);
  ~OffscreenHost() override;
  void SetViewport(const gfx::Size& viewport);
  void SetScreenConfiguration(const gfx::Size& viewport, float scale);
  static void UpdateIdentity(content::WebContents* contents, bool tablet);
  void SetOutputScale(float scale);
  void SetRenderDemand(bool enabled);
  void SetNeedsBeginFrameCallback(base::RepeatingClosure callback);
  viz::BeginFrameArgs CreateBeginFrameArgs(base::TimeTicks now, base::TimeDelta interval);
  bool needs_begin_frames() const { return needs_begin_frames_; }
  bool begin_frame_demand_known() const { return begin_frame_demand_known_; }
  uint64_t begin_frame_binding_epoch() const { return begin_frame_binding_epoch_; }
  bool rebound_with_unretired_gpu_work() const { return rebound_with_unretired_gpu_work_; }
  mojo::PendingAssociatedRemote<viz::mojom::ExternalBeginFrameControllerClient>
  CreateExternalBeginFrameControllerClient() override;
  void SetNeedsBeginFrame(bool needs_begin_frames) override;
  void SetPreferredInterval(base::TimeDelta interval) override;
  void NeedsBeginFrameWithId(int64_t display_id, bool needs_begin_frames) override;
  void Detach();
  void AddGpuRetirementProbe(base::RepeatingCallback<bool()> probe);
  bool CanDestroyGpuOutput();
  static void Retire(std::unique_ptr<OffscreenHost> host);
  void ClearFocus();
  base::DictValue Diagnostics() const;
  base::WeakPtr<OffscreenHost> GetWeakPtr() { return weak_factory_.GetWeakPtr(); }

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
  gfx::Rect bounds_;
  gfx::Size viewport_;
  float output_scale_ = 1.f;
  float screen_scale_ = 1.f;
  bool tablet_identity_ = false;
  void UpdateVirtualDisplay();
  raw_ptr<aura::Window> content_window_ = nullptr;
  std::unique_ptr<aura::client::FocusClient> focus_client_;
  std::unique_ptr<aura::client::WindowParentingClient> parenting_client_;
  std::unique_ptr<ui::InputMethod> minimal_input_method_;
  const uint64_t begin_frame_source_id_;
  uint64_t begin_frame_sequence_ = 0, begin_frame_binding_epoch_ = 0;
  bool enabled_ = false;
  bool needs_begin_frames_ = false, begin_frame_demand_known_ = false;
  bool rebound_with_unretired_gpu_work_ = false;
  base::TimeDelta preferred_interval_;
  base::RepeatingClosure needs_begin_frame_callback_;
  mojo::AssociatedReceiverSet<viz::mojom::ExternalBeginFrameControllerClient>
      begin_frame_receivers_;
  std::vector<base::RepeatingCallback<bool()>> gpu_retirement_probes_;
  base::WeakPtrFactory<OffscreenHost> weak_factory_{this};
};
}  // namespace remotekit::browser
#endif
