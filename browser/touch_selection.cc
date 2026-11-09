#include "browser/touch_selection.h"

#include <array>
#include <utility>
#include "browser/offscreen_host.h"
#include "browser/selection_geometry.h"
#include "browser/view_registry.h"
#include "content/browser/renderer_host/input/touch_selection_controller_client_aura.h"  // nogncheck
#include "content/browser/renderer_host/render_widget_host_view_aura.h"  // nogncheck
#include "content/public/browser/context_menu_params.h"
#include "ui/base/mojom/menu_source_type.mojom.h"
#include "ui/aura/window.h"
#include "ui/base/class_property.h"
#include "ui/touch_selection/touch_editing_controller.h"
#include "ui/events/gesture_detection/gesture_event_data.h"
#include "ui/events/velocity_tracker/motion_event.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/size.h"

namespace remotekit::browser {
namespace {
DEFINE_UI_CLASS_PROPERTY_KEY(bool, kViewerSelectionClient, false)

class ViewerHandleDrawable final : public ui::TouchHandleDrawable {
 public:
  void SetEnabled(bool enabled) override { enabled_ = enabled; }
  void SetOrientation(ui::TouchHandleOrientation, bool, bool) override {}
  void SetOrigin(const gfx::PointF& origin) override { origin_ = origin; }
  void SetAlpha(float alpha) override { alpha_ = alpha; }
  gfx::RectF GetVisibleBounds() const override {
    return enabled_ && alpha_ > 0 ? gfx::RectF(origin_, gfx::SizeF(24, 24)) : gfx::RectF();
  }
  float GetDrawableHorizontalPaddingRatio() const override { return 0; }

 private:
  gfx::PointF origin_;
  bool enabled_ = false;
  float alpha_ = 0;
};

class ViewerSelectionClient final : public content::TouchSelectionControllerClientAura {
 public:
  explicit ViewerSelectionClient(content::RenderWidgetHostViewAura* view)
      : TouchSelectionControllerClientAura(view) {}
  std::unique_ptr<ui::TouchHandleDrawable> CreateDrawable() override {
    return std::make_unique<ViewerHandleDrawable>();
  }
};

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
  auto* aura = static_cast<content::RenderWidgetHostViewAura*>(view);
  if (!aura->GetNativeView()->GetProperty(kViewerSelectionClient)) {
    aura->SetSelectionControllerClientForTest(std::make_unique<ViewerSelectionClient>(aura));
    aura->GetNativeView()->SetProperty(kViewerSelectionClient, true);
  }
  return aura;
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
void RemoteTouchSelectionMenuRunner::CloseFor(SessionId session, WebViewId view) {
  if (open_ && open_->session == session && (!view || open_->view == view))
    CloseMenu();
  for (const auto& [id, record] : views_.records) {
    auto& candidate = *record.webview;
    if (candidate.session_id() != session || (view && candidate.view_id() != view))
      continue;
    ResetTouchSelection(static_cast<content::RenderWidgetHostViewBase*>(
        candidate.contents() ? candidate.contents()->GetRenderWidgetHostView() : nullptr));
  }
}
void RemoteTouchSelectionMenuRunner::Dismiss(SessionId session, WebViewId view, uint64_t menu) {
  if (!menu ||
      (open_ && open_->session == session && open_->view == view && open_->menu.menu_id == menu))
    CloseFor(session, view);
}
bool RemoteTouchSelectionMenuRunner::IsRunning() const {
  return open_ && open_->client;
}
SharedAtlasSelectionMenu RemoteTouchSelectionMenuRunner::StateFor(SessionId session,
                                                                  WebViewId view) const {
  SharedAtlasSelectionMenu state{};
  if (IsRunning() && open_->session == session && open_->view == view) {
    state = open_->menu;
    state.flags = kAtlasSelectionMenuVisible | Enabled(open_->client.get(), open_->can_paste);
  }
  const auto* record = views_.Find(session, view);
  if (record && record->webview->contents()) {
    auto* root = static_cast<content::RenderWidgetHostViewBase*>(
        record->webview->contents()->GetRenderWidgetHostView());
    if (root) {
      auto* controller = Aura(root)->selection_controller();
      ReadSelectionHandles(*controller, state);
      if (state.menu_id) {
        const auto rect = controller->GetRectBetweenBounds();
        state.anchor_x = rect.x();
        state.anchor_y = rect.y();
        state.anchor_width = rect.width();
        state.anchor_height = rect.height();
      }
    }
  }
  return state;
}
Status DragSelectionHandle(input::RenderWidgetHostViewInput* view, const SelectionExtent& extent) {
  if (!view)
    return {ErrorCode::kUnavailable, "Selection view unavailable"};
  auto* aura = Aura(view);
  if (!MoveSelectionExtent(*aura->selection_controller(), *aura->selection_controller_client(),
                           extent))
    return {ErrorCode::kConflict, "Selection changed"};
  if (extent.which == SelectionExtent::Which::insertion)
    ShowInsertionMenu(view, aura->selection_controller()->GetStartHandleRect().CenterPoint());
  return {};
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
  if (value.command != SelectionCommand::Command::select_all)
    CloseFor(session, view);
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
void ShowInsertionMenu(input::RenderWidgetHostViewInput* view, const gfx::PointF& point) {
  if (!view)
    return;
  auto* aura = Aura(view);
  auto* controller = aura->selection_controller();
  if (controller->active_status() != ui::TouchSelectionController::ActiveStatus::kInsertionActive ||
      !controller->GetStartHandleRect().Contains(point))
    return;
  content::ContextMenuParams params;
  params.is_editable = true;
  params.source_type = ui::mojom::MenuSourceType::kLongPress;
  aura->selection_controller_client()->HandleContextMenu(params, true);
}
void ResetTouchSelection(input::RenderWidgetHostViewInput* view) {
  if (!view)
    return;
  auto* aura = Aura(view);
  aura->selection_controller()->HideAndDisallowShowingAutomatically();
  aura->selection_controller_client()->OnTouchUp();
  aura->selection_controller_client()->OnScrollCompleted();
}
}  // namespace remotekit::browser
