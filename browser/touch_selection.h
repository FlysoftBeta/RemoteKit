#pragma once
#include <optional>

#include "browser/view_model.h"
#include "protocol/shared_render_slots.h"
#include "ui/touch_selection/touch_selection_menu_runner.h"

namespace input {
class RenderWidgetHostViewInput;
}
namespace ui {
struct GestureEventData;
class MotionEvent;
}  // namespace ui
namespace remotekit::browser {
class ViewRegistry;

// Chromium's touch selection asks this runner to show its quick menu. The menu
// is drawn by the Viewer: the runner owns the single open menu and publishes
// it through per-view atlas metadata.
class RemoteTouchSelectionMenuRunner final : public ui::TouchSelectionMenuRunner {
 public:
  explicit RemoteTouchSelectionMenuRunner(ViewRegistry& views);
  ~RemoteTouchSelectionMenuRunner() override;
  static RemoteTouchSelectionMenuRunner& Get();

  bool IsMenuAvailable(const ui::TouchSelectionMenuClient*, bool can_paste) const override;
  void OpenMenu(base::WeakPtr<ui::TouchSelectionMenuClient>,
                const gfx::Rect& anchor_in_screen,
                const gfx::Size& handle_size,
                aura::Window* context,
                bool can_paste) override;
  void CloseMenu() override;
  bool IsRunning() const override;

  SharedAtlasSelectionMenu StateFor(SessionId, WebViewId) const;
  Status Execute(SessionId, WebViewId, const SelectionCommand&);

 private:
  struct OpenState {
    SessionId session{};
    WebViewId view{};
    base::WeakPtr<ui::TouchSelectionMenuClient> client;
    SharedAtlasSelectionMenu menu{};
    bool can_paste{};
  };
  ViewRegistry& views_;
  std::optional<OpenState> open_;
  uint64_t next_id_{};
};
bool HandleSelectionTouch(input::RenderWidgetHostViewInput*, const ui::MotionEvent&);
void SelectionTouchBoundary(input::RenderWidgetHostViewInput*, bool down);
void HandleSelectionGesture(input::RenderWidgetHostViewInput*, const ui::GestureEventData&);
void HideTouchSelection(input::RenderWidgetHostViewInput*);
}  // namespace remotekit::browser
