#pragma once
#include "browser/webview.h"
#include "remotekit/browser/browser_context.h"
#include "browser/offscreen_host.h"
#include "browser/navigation_state.h"
#include "browser/compat.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <type_traits>
#include <utility>

#include "base/check.h"
#include "base/containers/span.h"
#include "base/feature_list.h"
#include "base/functional/bind.h"
#include "base/location.h"
#include "base/pickle.h"
#include "base/strings/string_number_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "base/time/time.h"
#include "components/input/native_web_keyboard_event.h"
#include "third_party/blink/public/mojom/page/widget.mojom.h"
#include "components/input/render_widget_host_input_event_router.h"
#include "content/browser/renderer_host/frame_tree.h"          // nogncheck
#include "content/browser/renderer_host/frame_tree_node.h"     // nogncheck
#include "content/browser/renderer_host/navigation_request.h"  // nogncheck
#include "browser/client_gesture_bridge.h"
#include "content/browser/renderer_host/input/mouse_wheel_phase_handler.h"      // nogncheck
#include "content/browser/renderer_host/page_lifecycle_state_manager.h"         // nogncheck
#include "content/browser/renderer_host/render_frame_host_impl.h"               // nogncheck
#include "content/browser/renderer_host/render_frame_metadata_provider_impl.h"  // nogncheck
#include "content/browser/renderer_host/render_view_host_impl.h"                // nogncheck
#include "content/browser/renderer_host/render_widget_host_delegate.h"          // nogncheck
#include "content/browser/renderer_host/render_widget_host_impl.h"              // nogncheck
#include "content/browser/renderer_host/render_widget_host_view_base.h"         // nogncheck
#include "content/browser/renderer_host/render_widget_host_view_aura.h"         // nogncheck
#include "content/browser/renderer_host/text_input_manager.h"                   // nogncheck
#include "content/browser/web_contents/web_contents_impl.h"                     // nogncheck
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/navigation_entry.h"
#include "content/public/browser/reload_type.h"
#include "net/base/net_errors.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/site_instance.h"
#include "content/public/browser/visibility.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_capability_type.h"
#include "content/public/common/content_features.h"
#include "third_party/blink/public/common/input/web_keyboard_event.h"
#include "third_party/blink/public/common/input/web_mouse_event.h"
#include "third_party/blink/public/common/input/web_mouse_wheel_event.h"
#include "third_party/blink/public/common/input/web_touch_event.h"
#include "protocol/touch_clock.hpp"
#include "ui/aura/window.h"
#include "ui/aura/window_tree_host.h"
#include "ui/base/ime/text_input_type.h"
#include "ui/display/screen.h"
#include "ui/events/keycodes/dom/dom_key.h"
#include "ui/gfx/geometry/rect_f.h"
#include "ui/gfx/range/range.h"
#include "ui/gfx/selection_bound.h"
#include "ui/latency/latency_info.h"

namespace remotekit::browser {

inline Status Fail(ErrorCode error, const char* message) {
  return {error, message};
}
inline void PostCompletion(WebView::Completion callback, Status status) {
  if (!callback)
    return;
  // WebContents forbids destruction during observer notifications. A lifecycle
  // client may unload/destroy this adapter from its completion callback.
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE,
      base::BindOnce([](WebView::Completion done, Status result) { done(std::move(result)); },
                     std::move(callback), std::move(status)));
}
using Type = blink::WebInputEvent::Type;
inline int MouseButtonModifier(std::uint8_t button) {
  switch (button) {
    case 1:
      return blink::WebInputEvent::kLeftButtonDown;
    case 2:
      return blink::WebInputEvent::kMiddleButtonDown;
    case 3:
      return blink::WebInputEvent::kRightButtonDown;
    case 4:
      return blink::WebInputEvent::kBackButtonDown;
    case 5:
      return blink::WebInputEvent::kForwardButtonDown;
    default:
      return 0;
  }
}
inline bool NavigationAffectsFrame(content::NavigationHandle* navigation,
                                   content::RenderFrameHost* frame) {
  for (auto* current = frame; current; current = current->GetParentOrOuterDocument())
    if (current->GetFrameTreeNodeId() == navigation->GetFrameTreeNodeId())
      return true;
  return false;
}
inline bool InputFrameReady(content::RenderFrameHost* frame) {
  return frame && frame->IsActive() && frame->IsRenderFrameLive() &&
         frame->GetLifecycleState() == content::RenderFrameHost::LifecycleState::kActive;
}
constexpr std::string_view kNavigationOwnerMagic = "RemoteKit.OwnedNavigation";
constexpr std::string_view kNavigationRevision = "157.0.8103.15";
constexpr std::size_t kMaxOwnedNavigationBytes = 64 * 1024 * 1024 + 1024;
inline bool FloatFits(double value) {
  return std::isfinite(value) && std::abs(value) <= std::numeric_limits<float>::max();
}
inline blink::WebPointerProperties::Button Button(std::uint8_t button) {
  using B = blink::WebPointerProperties::Button;
  switch (button) {
    case 1:
      return B::kLeft;
    case 2:
      return B::kMiddle;
    case 3:
      return B::kRight;
    case 4:
      return B::kBack;
    case 5:
      return B::kForward;
    default:
      return B::kNoButton;
  }
}
constexpr blink::WebPointerProperties::Button MouseMoveButton(std::uint32_t modifiers) {
  using B = blink::WebPointerProperties::Button;
  // Blink uses button on moves to retain drag/scrollbar state. The wire button
  // describes the changed button, so moves instead use the held-button flags.
  // Match ui::MakeWebMouseEvent's ordering for chorded mouse buttons.
  if (modifiers & blink::WebInputEvent::kRightButtonDown)
    return B::kRight;
  if (modifiers & blink::WebInputEvent::kMiddleButtonDown)
    return B::kMiddle;
  if (modifiers & blink::WebInputEvent::kLeftButtonDown)
    return B::kLeft;
  if (modifiers & blink::WebInputEvent::kForwardButtonDown)
    return B::kForward;
  if (modifiers & blink::WebInputEvent::kBackButtonDown)
    return B::kBack;
  return B::kNoButton;
}
static_assert(MouseMoveButton(0) == blink::WebPointerProperties::Button::kNoButton);
static_assert(MouseMoveButton(blink::WebInputEvent::kShiftKey) ==
              blink::WebPointerProperties::Button::kNoButton);
static_assert(MouseMoveButton(blink::WebInputEvent::kLeftButtonDown) ==
              blink::WebPointerProperties::Button::kLeft);
static_assert(MouseMoveButton(blink::WebInputEvent::kMiddleButtonDown |
                              blink::WebInputEvent::kLeftButtonDown) ==
              blink::WebPointerProperties::Button::kMiddle);
static_assert(MouseMoveButton(kMouseButtonModifiers) ==
              blink::WebPointerProperties::Button::kRight);
static_assert(MouseMoveButton(blink::WebInputEvent::kBackButtonDown) ==
              blink::WebPointerProperties::Button::kBack);
static_assert(MouseMoveButton(blink::WebInputEvent::kBackButtonDown |
                              blink::WebInputEvent::kForwardButtonDown) ==
              blink::WebPointerProperties::Button::kForward);
inline content::RenderWidgetHostImpl* RootWidget(content::WebContents* contents) {
  if (!contents || !contents->GetPrimaryMainFrame())
    return nullptr;
  return content::RenderWidgetHostImpl::From(
      contents->GetPrimaryMainFrame()->GetRenderWidgetHost());
}
inline content::RenderWidgetHostViewBase* RootView(content::WebContents* contents) {
  return contents
             ? static_cast<content::RenderWidgetHostViewBase*>(contents->GetRenderWidgetHostView())
             : nullptr;
}

inline gfx::PointF ViewportToScreen(content::RenderWidgetHostViewBase* view, gfx::PointF point) {
  const gfx::Rect bounds = view->GetViewBounds();
  point.Offset(static_cast<float>(bounds.x()), static_cast<float>(bounds.y()));
  return point;
}

}  // namespace remotekit::browser
