#include "browser/touch_selection.h"

#include <array>
#include <utility>
#include "browser/offscreen_host.h"
#include "browser/view_registry.h"
#include "content/browser/renderer_host/input/touch_selection_controller_client_aura.h"  // nogncheck
#include "content/browser/renderer_host/render_widget_host_view_aura.h"  // nogncheck
#include "ui/aura/window.h"
#include "ui/touch_selection/touch_editing_controller.h"
#include "ui/events/gesture_detection/gesture_event_data.h"
#include "ui/events/velocity_tracker/motion_event.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/size.h"

namespace remotekit::browser {
namespace {
constexpr std::array commands = {
    ui::TouchEditable::MenuCommands::kCut, ui::TouchEditable::MenuCommands::kCopy,
    ui::TouchEditable::MenuCommands::kPaste, ui::TouchEditable::MenuCommands::kSelectAll};
uint32_t Enabled(const ui::TouchSelectionMenuClient* client, bool can_paste) {
  uint32_t mask = kAtlasSelectionCanContextMenu;
  for (size_t i = 0; i < commands.size(); ++i)
    if (client->IsCommandIdEnabled(std::to_underlying(commands[i]), can_paste))
      mask |= 2u << i;
  return mask;
}
content::RenderWidgetHostViewAura* Aura(input::RenderWidgetHostViewInput* view) {
  return static_cast<content::RenderWidgetHostViewAura*>(view);
}
}  // namespace
RemoteTouchSelectionMenuRunner::RemoteTouchSelectionMenuRunner(ViewRegistry& views)
    : views_(views) {}
RemoteTouchSelectionMenuRunner::~RemoteTouchSelectionMenuRunner() = default;
RemoteTouchSelectionMenuRunner& RemoteTouchSelectionMenuRunner::Get() {
  // BrowserRuntime installs this runner before any WebView exists.
  return *static_cast<RemoteTouchSelectionMenuRunner*>(ui::TouchSelectionMenuRunner::GetInstance());
}
bool RemoteTouchSelectionMenuRunner::IsMenuAvailable(const ui::TouchSelectionMenuClient* client,
                                                     bool can_paste) const {
  return client && Enabled(client, can_paste);
}
void RemoteTouchSelectionMenuRunner::OpenMenu(base::WeakPtr<ui::TouchSelectionMenuClient> client,
                                              const gfx::Rect& anchor_in_screen,
                                              const gfx::Size& handle_size,
                                              aura::Window* context,
                                              bool can_paste) {
  CloseMenu();
  if (!client || !context || !IsMenuAvailable(client.get(), can_paste))
    return;
  for (const auto& [id, record] : views_.records) {
    auto& view = *record.webview;
    auto* host = view.offscreen_host();
    if (!host || context->GetRootWindow() != host->window())
      continue;
    const gfx::Rect root = host->window()->GetBoundsInScreen();
    gfx::Rect anchor = anchor_in_screen;
    anchor.Offset(-root.x(), -root.y());
    CHECK_NE(next_id_, UINT64_MAX);
    OpenState state;
    state.session = view.session_id();
    state.view = view.view_id();
    state.can_paste = can_paste;
    state.menu.menu_id = ++next_id_;
    state.menu.anchor_x = anchor.x();
    state.menu.anchor_y = anchor.y();
    state.menu.anchor_width = anchor.width();
    state.menu.anchor_height = anchor.height();
    state.menu.handle_height = handle_size.height();
    state.client = std::move(client);
    open_ = std::move(state);
    return;
  }
}
void RemoteTouchSelectionMenuRunner::CloseMenu() {
  open_.reset();
}
bool RemoteTouchSelectionMenuRunner::IsRunning() const {
  return open_ && open_->client;
}
SharedAtlasSelectionMenu RemoteTouchSelectionMenuRunner::StateFor(SessionId session,
                                                                  WebViewId view) const {
  if (!IsRunning() || open_->session != session || open_->view != view)
    return {};
  auto state = open_->menu;
  state.flags = kAtlasSelectionMenuVisible | Enabled(open_->client.get(), open_->can_paste);
  return state;
}
Status RemoteTouchSelectionMenuRunner::Execute(SessionId session,
                                               WebViewId view,
                                               const SelectionCommand& value) {
  const auto index = static_cast<size_t>(value.command);
  if (!StateFor(session, view).menu_id || open_->menu.menu_id != value.menu)
    return {ErrorCode::kConflict, "Selection menu changed"};
  if (value.command == SelectionCommand::Command::context_menu) {
    auto client = open_->client;
    CloseMenu();
    client->RunContextMenu();
    return {};
  }
  if (index >= commands.size())
    return {ErrorCode::kConflict, "Selection menu changed"};
  const int command = std::to_underlying(commands[index]);
  auto client = open_->client;
  if (!client->IsCommandIdEnabled(command, open_->can_paste))
    return {ErrorCode::kConflict, "Selection menu changed"};
  CloseMenu();
  client->ExecuteCommand(command, 0);
  return {};
}
bool HandleSelectionTouch(input::RenderWidgetHostViewInput* view, const ui::MotionEvent& event) {
  return view && Aura(view)->selection_controller()->WillHandleTouchEvent(event);
}
void SelectionTouchBoundary(input::RenderWidgetHostViewInput* view, bool down) {
  if (!view)
    return;
  auto* client = Aura(view)->selection_controller_client();
  if (down)
    client->OnTouchDown();
  else
    client->OnTouchUp();
}
void HandleSelectionGesture(input::RenderWidgetHostViewInput* view,
                            const ui::GestureEventData& data) {
  if (!view)
    return;
  auto* aura = Aura(view);
  auto* controller = aura->selection_controller();
  const gfx::PointF point(data.x, data.y);
  switch (data.type()) {
    case ui::EventType::kGestureLongPress:
      controller->HandleLongPressEvent(data.time, point);
      break;
    case ui::EventType::kGestureTapDown:
      if (data.details.tap_down_count() == 2)
        controller->HandleDoublePressEvent(data.time, point);
      break;
    case ui::EventType::kGestureTap:
      controller->HandleTapEvent(point, data.details.tap_count());
      break;
    case ui::EventType::kGestureScrollBegin:
      aura->selection_controller_client()->OnScrollStarted();
      break;
    case ui::EventType::kGestureScrollEnd:
      aura->selection_controller_client()->OnScrollCompleted();
      break;
    default:
      break;
  }
}
void HideTouchSelection(input::RenderWidgetHostViewInput* view) {
  if (!view)
    return;
  auto* controller = Aura(view)->selection_controller();
  if (controller->active_status() != ui::TouchSelectionController::ActiveStatus::kInactive)
    controller->HideAndDisallowShowingAutomatically();
}
}  // namespace remotekit::browser
