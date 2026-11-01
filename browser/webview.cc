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
#include "base/no_destructor.h"
#include "base/pickle.h"
#include "base/task/single_thread_task_runner.h"
#include "base/time/time.h"
#include "components/input/native_web_keyboard_event.h"
#include "components/embedder_support/user_agent_utils.h"
#include "components/version_info/version_info.h"
#include "third_party/blink/public/common/web_preferences/web_preferences.h"
#include "third_party/blink/public/common/widget/device_emulation_params.h"
#include "third_party/blink/public/mojom/page/widget.mojom.h"
#include "components/input/render_widget_host_input_event_router.h"
#include "content/browser/renderer_host/frame_tree.h"                    // nogncheck
#include "content/browser/renderer_host/frame_tree_node.h"               // nogncheck
#include "content/browser/renderer_host/input/touch_emulator_impl.h"     // nogncheck
#include "content/browser/renderer_host/page_lifecycle_state_manager.h"  // nogncheck
#include "content/browser/renderer_host/render_frame_host_impl.h"        // nogncheck
#include "content/browser/renderer_host/render_frame_metadata_provider_impl.h"  // nogncheck
#include "content/browser/renderer_host/render_view_host_impl.h"         // nogncheck
#include "content/browser/renderer_host/render_widget_host_delegate.h"   // nogncheck
#include "content/browser/renderer_host/render_widget_host_impl.h"       // nogncheck
#include "content/browser/renderer_host/render_widget_host_view_base.h"  // nogncheck
#include "content/browser/renderer_host/text_input_manager.h"            // nogncheck
#include "content/browser/web_contents/web_contents_impl.h"              // nogncheck
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/navigation_entry.h"
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
namespace {
std::vector<WebView*>& DeviceAdapters() {
  static base::NoDestructor<std::vector<WebView*>> adapters;
  return *adapters;
}
Status Fail(Error error, const char* message) {
  return {error, message};
}
void PostCompletion(WebView::Completion callback, Status status) {
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
int MouseButtonModifier(std::uint8_t button) {
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
bool NavigationAffectsFrame(content::NavigationHandle* navigation,
                            content::RenderFrameHost* frame) {
  for (auto* current = frame; current; current = current->GetParentOrOuterDocument())
    if (current->GetFrameTreeNodeId() == navigation->GetFrameTreeNodeId())
      return true;
  return false;
}
bool InputFrameReady(content::RenderFrameHost* frame) {
  return frame && frame->IsActive() && frame->IsRenderFrameLive() &&
         frame->GetLifecycleState() == content::RenderFrameHost::LifecycleState::kActive;
}
constexpr std::string_view kNavigationOwnerMagic = "RemoteKit.OwnedNavigation";
constexpr std::string_view kNavigationRevision = "157.0.8103.15";
constexpr std::size_t kMaxOwnedNavigationBytes = 64 * 1024 * 1024 + 1024;
bool FloatFits(double value) {
  return std::isfinite(value) && std::abs(value) <= std::numeric_limits<float>::max();
}
blink::WebPointerProperties::Button Button(std::uint8_t button) {
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
content::RenderWidgetHostImpl* RootWidget(content::WebContents* contents) {
  if (!contents || !contents->GetPrimaryMainFrame())
    return nullptr;
  return content::RenderWidgetHostImpl::From(
      contents->GetPrimaryMainFrame()->GetRenderWidgetHost());
}
content::RenderWidgetHostViewBase* RootView(content::WebContents* contents) {
  return contents
             ? static_cast<content::RenderWidgetHostViewBase*>(contents->GetRenderWidgetHostView())
             : nullptr;
}

gfx::PointF ViewportToScreen(content::RenderWidgetHostViewBase* view, gfx::PointF point) {
  const gfx::Rect bounds = view->GetViewBounds();
  point.Offset(static_cast<float>(bounds.x()), static_cast<float>(bounds.y()));
  return point;
}
}  // namespace

WebView::WebView(content::BrowserContext* context,
                 Endpoint* endpoint,
                 SessionId session,
                 WebViewId view,
                 bool offscreen_host, std::unique_ptr<content::WebContents> adopted)
    : context_(context), endpoint_(endpoint), session_(session), view_(view),
      use_offscreen_host_(offscreen_host) {
  DeviceAdapters().push_back(this);
  CHECK(context_);
  CHECK(endpoint_);
  content::DevToolsAgentHost::AddObserver(this);
  CHECK(endpoint_->FindWebView(session_, view_));
  const auto* model = endpoint_->FindWebView(session_, view_);
  if (model->actual == Residency::live)
    CreateContents(std::move(adopted));
}
WebView::~WebView() {
  std::erase(DeviceAdapters(), this);
  content::DevToolsAgentHost::RemoveObserver(this);
  weak_factory_.InvalidateWeakPtrs();
  lifecycle_timer_.Stop();
  if (auto* focused = FocusedWidget())
    PrepareKeyboardTarget(focused);
  ReleaseKeyboard(false, true);
  ReleasePointer(true);
  Observe(nullptr);
  DropContents();
  auto callback = std::move(completion_);
  if (lifecycle_request_)
    endpoint_->CompleteLifecycle(session_, *lifecycle_request_, false);
  endpoint_->InvalidateInstance(session_, view_);
  if (callback)
    callback(Fail(Error::unavailable, "WebView adapter destroyed"));
}
void WebView::CreateContents(std::unique_ptr<content::WebContents> adopted) {
  CancelTouches(false);
  touch_owner_lost_ = false;
  touch_status_ = {};
  input_commit_navigations_.clear();
  content::WebContents::CreateParams params(context_);
  params.initially_hidden = !visible_;
  contents_ = adopted ? std::move(adopted) : content::WebContents::Create(params);
  BrowserContext::InstallSiteIdentity(contents_.get());
  Observe(contents_.get());
  AttachOffscreenHost();
  // Track native sequence starts from the beginning, even while disabled.
  // Creating an emulator only when injecting into an already active native
  // sequence would miss its start and defeat the official mutual exclusion.
  auto* implementation = static_cast<content::WebContentsImpl*>(contents_.get());
  implementation->GetInputEventRouter();
  implementation->GetTouchEmulator(true);
}
void WebView::AttachOffscreenHost() {
  if (!use_offscreen_host_ || !contents_) return;
  offscreen_host_ = std::make_unique<OffscreenHost>(contents_.get(),
      gfx::Size(std::max(1, viewport_width_ ? viewport_width_ : 480),
                std::max(1, viewport_height_ ? viewport_height_ : 360)));
  offscreen_host_->SetRenderDemand(render_demand_ && visible_, render_fps_);
}
void WebView::DropContents() {
  auto host = std::move(offscreen_host_);
  if (host) host->Detach();
  contents_.reset();
  if (host)
    base::SingleThreadTaskRunner::GetCurrentDefault()->DeleteSoon(FROM_HERE, std::move(host));
}
void WebView::SetRenderDemand(bool enabled, uint32_t fps) {
  render_demand_ = enabled;
  render_fps_ = fps;
  if (!use_offscreen_host_) return;
  if (offscreen_host_) offscreen_host_->SetRenderDemand(enabled && visible_, fps);
}
void WebView::OverridePreferences(content::WebContents* contents,
                                   blink::web_pref::WebPreferences* prefs) {
  for (auto* adapter : DeviceAdapters()) {
    if (adapter->contents() != contents || !adapter->tablet_) continue;
    prefs->touch_event_feature_detection_enabled = true;
    prefs->pointer_events_max_touch_points = 10;
    prefs->available_pointer_types = static_cast<int>(blink::mojom::PointerType::kPointerCoarseType);
    prefs->primary_pointer_type = blink::mojom::PointerType::kPointerCoarseType;
    prefs->available_hover_types = static_cast<int>(blink::mojom::HoverType::kHoverNone);
    prefs->primary_hover_type = blink::mojom::HoverType::kHoverNone;
    prefs->viewport_enabled = true;
    prefs->viewport_meta_enabled = true;
    prefs->shrinks_viewport_contents_to_fit = true;
  }
}
void WebView::InvalidateLayoutInput() {
  ReleaseKeyboard(true, true);
  ReleasePointer(true);
  endpoint_->InvalidateInput(session_, view_);
}
void WebView::ConfigureDevice(int width, int height, bool tablet, float scale,
                             bool match_page_backing) {
  const bool mode_changed = tablet_ != tablet;
  const bool changed = viewport_width_ != width || viewport_height_ != height ||
                       mode_changed || device_scale_ != scale ||
                       match_page_backing_ != match_page_backing;
  if (match_page_backing_ && !match_page_backing) {
    if (auto* native_view = RootView(contents_.get()))
      native_view->SetScaleOverrideForCapture(1.0f);
    backing_view_.reset();
  }
  match_page_backing_ = match_page_backing;
  viewport_width_ = width;
  viewport_height_ = height;
  tablet_ = tablet;
  device_scale_ = scale;
  if (offscreen_host_) offscreen_host_->SetViewport(gfx::Size(width, height));
  if (!contents_ || !changed) return;
  contents_->OnWebPreferencesChanged();
  ApplyDevice();
}
void WebView::RefreshBackingScale() {
  ApplyBackingScale(RootView(contents_.get()));
}
void WebView::ApplyBackingScale(content::RenderWidgetHostViewBase* native_view) {
  if (!match_page_backing_ || !native_view)
    return;
  auto* window = native_view->GetNativeView();
  const auto* host = window ? window->GetHost() : nullptr;
  const float host_scale = host ? host->device_scale_factor() : 0;
  if (backing_view_.get() == native_view && backing_host_scale_ == host_scale &&
      std::abs(native_view->GetDeviceScaleFactor() - device_scale_) < 0.0001f)
    return;
  auto* screen = display::Screen::Get();
  if (!screen)
    return;
  // Match GetNewScreenInfosForUpdate's original display selection. Never use
  // GetDeviceScaleFactor as the denominator: it already includes our override.
  const auto display = window ? screen->GetDisplayNearestView(window)
                              : screen->GetPrimaryDisplay();
  const float native_scale = display.device_scale_factor();
  if (!std::isfinite(native_scale) || native_scale <= 0)
    return;
  const float multiplier = device_scale_ / native_scale;
  backing_view_ = native_view->GetWeakPtr();
  backing_host_scale_ = host_scale;
  if (std::abs(native_view->GetScaleOverrideForCapture() - multiplier) > 0.0001f ||
      std::abs(native_view->GetDeviceScaleFactor() - device_scale_) > 0.0001f)
    native_view->SetScaleOverrideForCapture(multiplier);
}
void WebView::ApplyDevice(content::RenderFrameHost* frame) {
  if (!contents_ || !viewport_width_ || !viewport_height_) return;
  if (!frame) frame = contents_->GetPrimaryMainFrame();
  if (!frame || frame->GetParentOrOuterDocument()) return;
  auto* host = static_cast<content::RenderFrameHostImpl*>(frame)->GetRenderWidgetHost();
  ApplyBackingScale(host->GetView());
  auto& widget = host->GetAssociatedFrameWidget();
  if (!widget) return;
  blink::DeviceEmulationParams params;
  params.screen_type = tablet_ ? blink::mojom::EmulatedScreenType::kMobile :
                                blink::mojom::EmulatedScreenType::kDesktop;
  params.screen_size = gfx::Size(viewport_width_, viewport_height_);
  params.view_size = params.screen_size;
  params.device_scale_factor = device_scale_;
  params.screen_orientation_type = viewport_width_ > viewport_height_ ?
      display::mojom::ScreenOrientation::kLandscapePrimary : display::mojom::ScreenOrientation::kPortraitPrimary;
  params.screen_orientation_angle = viewport_width_ > viewport_height_ ? 90 : 0;
  params.force_viewport_meta = tablet_;
  params.force_text_size_adjust = tablet_;
  params.force_android_overlay_scrollbar = tablet_;
  widget->EnableDeviceEmulation(params, blink::mojom::DeviceEmulationCacheBehavior::kKeepCache);
}
Result<std::string> WebView::ExportNavigation() const {
  if (lifecycle_request_ || lifecycle_uncertain_)
    return {{}, Fail(Error::busy, "Navigation state is transitioning or uncertain")};
  const auto* model = endpoint_->FindWebView(session_, view_);
  if (!model)
    return {{}, Fail(Error::not_found, "WebView model missing")};
  Result<std::string> payload;
  if (contents_) {
    auto captured = CaptureNavigationState(*contents_);
    if (!captured)
      return {{}, captured.status};
    payload = ExportNavigationState(captured.value);
  } else {
    if (!navigation_state_)
      return {{}, Fail(Error::not_found, "No saved navigation state")};
    payload = ExportNavigationState(*navigation_state_);
  }
  if (!payload)
    return payload;
  base::Pickle envelope;
  envelope.WriteString(kNavigationOwnerMagic);
  envelope.WriteInt(1);
  envelope.WriteUInt64(session_);
  envelope.WriteUInt64(model->profile);
  envelope.WriteString(kNavigationRevision);
  envelope.WriteString(payload.value);
  if (envelope.AsBytes().size() > kMaxOwnedNavigationBytes)
    return {{}, Fail(Error::invalid, "Owned navigation snapshot exceeds size limit")};
  return {std::string(envelope.AsStringView()), {}};
}
Status WebView::ImportNavigation(std::string_view bytes) {
  const auto* model = endpoint_->FindWebView(session_, view_);
  if (contents_ || lifecycle_request_ || !model || model->actual != Residency::unloaded)
    return Fail(Error::unavailable, "Navigation import requires an unloaded WebView");
  if (bytes.size() < sizeof(std::uint32_t) || bytes.size() > kMaxOwnedNavigationBytes)
    return Fail(Error::invalid, "Invalid owned navigation size");
  auto input = base::PickleIterator::WithData(base::as_byte_span(bytes));
  if (input.RemainingBytes() != bytes.size() - sizeof(std::uint32_t))
    return Fail(Error::invalid, "Invalid owned navigation header");
  std::string magic, revision, payload;
  int schema = 0;
  std::uint64_t owner_session = 0, owner_profile = 0;
  if (!input.ReadString(&magic) || magic != kNavigationOwnerMagic || !input.ReadInt(&schema) ||
      schema != 1 || !input.ReadUInt64(&owner_session) || !input.ReadUInt64(&owner_profile) ||
      !input.ReadString(&revision) || revision != kNavigationRevision)
    return Fail(Error::invalid, "Unsupported owned navigation schema or Chromium revision");
  if (owner_session != session_ || owner_profile != model->profile)
    return Fail(Error::wrong_session, "Navigation snapshot belongs to another Session/Profile");
  if (!input.ReadString(&payload) || !input.ReachedEnd())
    return Fail(Error::invalid, "Invalid owned navigation payload length");
  auto imported = ImportNavigationState(payload);
  if (!imported)
    return imported.status;
  navigation_state_ = std::make_unique<NavigationState>(std::move(imported.value));
  return {};
}
Status WebView::Navigate(const GURL& url) {
  if (!url.is_valid())
    return Fail(Error::invalid, "Invalid navigation URL");
  const auto* model = endpoint_->FindWebView(session_, view_);
  if (lifecycle_uncertain_ || !contents_ || !model || model->actual != Residency::live ||
      model->pending)
    return Fail(Error::unavailable, "WebView cannot navigate in this state");
  content::NavigationController::LoadURLParams params(url);
  params.override_user_agent = tablet_ ? content::NavigationController::UA_OVERRIDE_TRUE :
                                       content::NavigationController::UA_OVERRIDE_FALSE;
  if (!contents_->GetController().LoadURLWithParams(params))
    return Fail(Error::unavailable, "Navigation was not started");
  return {};
}
Status WebView::SetVisible(bool visible) {
  if (!contents_ && !visible) {
    visible_ = false;
    return {};
  }
  if (!contents_)
    return Fail(Error::unavailable, "WebView is unloaded");
  const auto* model = endpoint_->FindWebView(session_, view_);
  if (visible &&
      (lifecycle_uncertain_ || !model || model->actual != Residency::live || model->pending))
    return Fail(Error::unavailable, "Restore must complete before showing the WebView");
  if (!visible) {
    auto status = Focus(false);
    if (!status)
      return status;
  }
  visible_ = visible;
  if (offscreen_host_) offscreen_host_->SetRenderDemand(visible && render_demand_, render_fps_);
  if (visible)
    contents_->WasShown();
  else
    contents_->WasHidden();
  return {};
}
content::RenderWidgetHostImpl* WebView::FocusedWidget() const {
  if (!contents_)
    return nullptr;
  auto* frame = contents_->GetFocusedFrame();
  if (!InputFrameReady(frame))
    return nullptr;
  return content::RenderWidgetHostImpl::From(frame->GetRenderWidgetHost());
}
void WebView::SetNativeFocusEnabled(bool enabled) {
  native_focus_enabled_ = enabled;
}
bool WebView::KeyboardTargetAlive() const {
  if (!(input_widget_ && input_frame_ && input_document_ && InputFrameReady(input_frame_.get()) &&
        input_frame_->GetDocumentToken() == *input_document_ &&
        input_frame_->GetRenderWidgetHost() == input_widget_.get()))
    return false;
  auto* focused = contents_ ? contents_->GetFocusedFrame() : nullptr;
  // A shared widget cannot address its previous same-process focused frame.
  // Never send old-frame releases/IME cancellation into that new focused frame.
  return !focused || focused == input_frame_.get() ||
         focused->GetRenderWidgetHost() != input_widget_.get();
}
bool WebView::PointerTargetAlive() const {
  return pointer_root_widget_ && pointer_root_view_ && pointer_frame_ && pointer_document_ &&
         InputFrameReady(pointer_frame_.get()) &&
         pointer_frame_->GetDocumentToken() == *pointer_document_ &&
         pointer_frame_->GetRenderWidgetHost() == pointer_root_widget_.get() &&
         pointer_root_widget_->GetView() == pointer_root_view_.get();
}
void WebView::ReleaseKeyboard(bool finish_composition, bool deliver) {
  if (deliver && KeyboardTargetAlive()) {
    if (finish_composition)
      input_widget_->ImeFinishComposingText(false);
    else
      input_widget_->ImeCancelComposition();
    for (const auto& [physical, key] : pressed_keys_) {
      if (!KeyboardTargetAlive())
        break;
      input::NativeWebKeyboardEvent event(Type::kKeyUp, 0, base::TimeTicks::Now());
      event.native_key_code = static_cast<int>(physical);
      event.windows_key_code = key.windows_key_code;
      event.dom_code = static_cast<int>(key.dom_code);
      event.dom_key = static_cast<std::uint32_t>(key.dom_key);
      input_widget_->ForwardKeyboardEvent(event);
    }
  }
  pressed_keys_.clear();
  input_widget_.reset();
  input_frame_.reset();
  input_document_.reset();
}
void WebView::PrepareKeyboardTarget(content::RenderWidgetHostImpl* widget) {
  auto* focused = contents_ ? contents_->GetFocusedFrame() : nullptr;
  if (!widget || !InputFrameReady(focused))
    return;
  auto* frame = static_cast<content::RenderFrameHostImpl*>(focused);
  if (input_widget_.get() != widget) {
    // An OOPIF focus change leaves pointer capture/routing intact, but held
    // keys and composition belong to the previous widget/document.
    ReleaseKeyboard(false, true);
  } else if (input_frame_.get() != frame || !KeyboardTargetAlive()) {
    // Two same-process frames may share one widget. Once frame focus changed,
    // sending cancellation to that widget could cancel the NEW frame's IME.
    // Renderer focus handling already tears down the old focused element.
    ReleaseKeyboard(false, false);
  }
  input_widget_ = widget->GetWeakPtr();
  input_frame_ = frame->GetWeakPtr();
  input_document_ = frame->GetDocumentToken();
}
void WebView::RememberPointerTarget() {
  if (PointerTargetAlive())
    return;
  ReleasePointer(false);
  auto* root = RootWidget(contents_.get());
  auto* view = RootView(contents_.get());
  auto* frame = contents_
                    ? static_cast<content::RenderFrameHostImpl*>(contents_->GetPrimaryMainFrame())
                    : nullptr;
  if (!root || !view || !InputFrameReady(frame))
    return;
  pointer_root_widget_ = root->GetWeakPtr();
  pointer_root_view_ = view->GetWeakPtr();
  pointer_frame_ = frame->GetWeakPtr();
  pointer_document_ = frame->GetDocumentToken();
}
void WebView::ReleasePointer(bool deliver) {
  CancelTouches(deliver);
  if (deliver && PointerTargetAlive()) {
    auto* router = pointer_root_widget_->GetInputEventRouter();
    int modifiers = static_cast<int>(last_mouse_.modifiers);
    if (router)
      for (auto button : pressed_mouse_buttons_) {
        if (!PointerTargetAlive())
          break;
        modifiers &= ~MouseButtonModifier(button);
        blink::WebMouseEvent event(Type::kMouseUp, modifiers, base::TimeTicks::Now());
        event.button = Button(button);
        event.click_count = 1;
        event.SetPositionInWidget(static_cast<float>(last_mouse_.x),
                                  static_cast<float>(last_mouse_.y));
        event.SetPositionInScreen(
            ViewportToScreen(pointer_root_view_.get(), event.PositionInWidget()));
        router->RouteMouseEvent(pointer_root_view_.get(), &event, ui::LatencyInfo());
      }
  }
  touches_.clear();
  pressed_mouse_buttons_.clear();
  last_mouse_ = {};
  pointer_root_widget_.reset();
  pointer_root_view_.reset();
  pointer_frame_.reset();
  pointer_document_.reset();
}
SharedAtlasTextInput WebView::TextInputState() const {
  SharedAtlasTextInput result{};
  const auto* model = endpoint_->FindWebView(session_, view_);
  if (!model || !model->focused || model->actual != Residency::live || model->pending ||
      !input_commit_navigations_.empty() || lifecycle_uncertain_)
    return result;
  auto* root = RootView(contents_.get());
  auto* manager = root ? root->GetTextInputManager() : nullptr;
  auto* active = manager ? manager->GetActiveWidget() : nullptr;
  if (!active || active != FocusedWidget() || !active->GetView())
    return result;
  const auto* state = manager->GetTextInputState();
  if (!state || !state->node_id || state->type == ui::TEXT_INPUT_TYPE_NONE)
    return result;
  result.type = static_cast<std::uint32_t>(state->type);
  result.flags = kAtlasTextInputActive;
  if (state->selection.IsValid()) {
    result.selection_start = static_cast<std::uint32_t>(state->selection.GetMin());
    result.selection_end = static_cast<std::uint32_t>(state->selection.GetMax());
    result.flags |= kAtlasTextInputSelectionValid;
  }
  if (state->composition && state->composition->IsValid()) {
    result.composition_start = static_cast<std::uint32_t>(state->composition->GetMin());
    result.composition_end = static_cast<std::uint32_t>(state->composition->GetMax());
    result.flags |= kAtlasTextInputCompositionValid;
  }
  std::optional<gfx::RectF> caret;
  if (auto edit_context = manager->GetTextSelectionBounds())
    caret = gfx::RectF(*edit_context);
  else if (const auto* region = manager->GetSelectionRegion()) {
    if (region->focus.type() != gfx::SelectionBound::EMPTY &&
        region->focus.type() != gfx::SelectionBound::HIDDEN) {
      const auto& a = region->focus.edge_start();
      const auto& b = region->focus.edge_end();
      caret = gfx::RectF(std::min(a.x(), b.x()), std::min(a.y(), b.y()), std::abs(a.x() - b.x()),
                         std::abs(a.y() - b.y()));
    }
  }
  // TextInputManager already transforms OOPIF/EditContext selection bounds to
  // root viewport DIPs. Aura's GetCaretBounds adds a SCREEN offset; do not use
  // it here, and do not transform these already-root bounds a second time.
  if (caret && std::isfinite(caret->x()) && std::isfinite(caret->y()) &&
      std::isfinite(caret->width()) && std::isfinite(caret->height()) && caret->width() >= 0 &&
      caret->height() > 0) {
    result.caret_x = caret->x();
    result.caret_y = caret->y();
    result.caret_width = caret->width();
    result.caret_height = caret->height();
    result.flags |= kAtlasTextInputCaretValid;
  }
  return result;
}
Status WebView::Focus(bool focused) {
  if (focused && (lifecycle_uncertain_ || !contents_ || !visible_ || !RootWidget(contents_.get()) ||
                  !RootView(contents_.get())))
    return Fail(Error::unavailable, "Visible renderer view required for focus");
  if (!focused) {
    auto previous = input_widget_;
    const bool could_finish_previous = KeyboardTargetAlive();
    ReleaseKeyboard(true, true);
    if (auto* actual = FocusedWidget();
        actual && (!could_finish_previous || actual != previous.get())) {
      PrepareKeyboardTarget(actual);
      ReleaseKeyboard(true, true);
    }
    ReleasePointer(true);
  }
  auto status = endpoint_->SetFocus(session_, view_, focused);
  if (!status)
    return status;
  if (contents_) {
    if (focused && (native_focus_enabled_ || offscreen_host_))
      contents_->Focus();
    if (!focused && offscreen_host_) offscreen_host_->ClearFocus();
    if (auto* host = RootWidget(contents_.get())) {
      host->SetActive(focused);
      if (focused)
        host->Focus();
      else
        host->Blur();
    }
  }
  return {};
}
void WebView::OnWebContentsFocused(content::RenderWidgetHost*) {
  if (!native_focus_enabled_)
    return;
  endpoint_->SetFocus(session_, view_, true);
}
void WebView::OnWebContentsLostFocus(content::RenderWidgetHost*) {
  if (!native_focus_enabled_)
    return;
  ReleaseKeyboard(true, true);
  ReleasePointer(true);
  endpoint_->SetFocus(session_, view_, false);
}
void WebView::RenderFrameDeleted(content::RenderFrameHost* frame) {
  if (input_frame_.get() == frame)
    ReleaseKeyboard(false, false);
  if (pointer_frame_.get() == frame || touch_target_frame_.get() == frame)
    ReleasePointer(false);
}
void WebView::RenderFrameHostChanged(content::RenderFrameHost* old_frame,
                                     content::RenderFrameHost* new_frame) {
  ApplyDevice(new_frame);
  // This notification is a document/RFH replacement, not an ordinary iframe
  // focus move. The old target may already have gone away: never use the new.
  if (input_frame_.get() == old_frame)
    ReleaseKeyboard(false, KeyboardTargetAlive());
  if (pointer_frame_.get() == old_frame || touch_target_frame_.get() == old_frame)
    ReleasePointer(false);
}
Status WebView::BuildTouchState(const TouchInput& input,
                                std::map<std::uint32_t, TouchPoint>* next) const {
  *next = PointerTargetAlive() ? touches_ : std::map<std::uint32_t, TouchPoint>{};
  for (const auto& point : input.points) {
    if (!FloatFits(point.x) || !FloatFits(point.y))
      return Fail(Error::invalid, "Touch point outside Blink representation");
    bool exists = next->contains(point.id);
    if ((input.action == TouchInput::Action::start && exists) ||
        ((input.action == TouchInput::Action::move || input.action == TouchInput::Action::end) &&
         !exists))
      return Fail(Error::invalid, "Invalid touch contact transition");
    if (input.action != TouchInput::Action::cancel)
      (*next)[point.id] = point;
  }
  if (next->size() > blink::WebTouchEvent::kTouchesLengthCap)
    return Fail(Error::unsupported, "At most 16 simultaneous touch contacts supported");
  if (input.action == TouchInput::Action::cancel && next->empty())
    return Fail(Error::invalid, "No touch sequence to cancel");
  return {};
}
base::DictValue WebView::CompositorDiagnostics() const {
  base::DictValue result;
  if (offscreen_host_) result.Set("renderHost", offscreen_host_->Diagnostics());
  auto* native_view = RootView(contents_.get());
  if (!native_view)
    return result;
  const auto size_value = [](const gfx::Size& size) {
    base::DictValue value;
    value.Set("width", size.width());
    value.Set("height", size.height());
    return value;
  };
  const float native_scale = native_view->GetDeviceScaleFactor();
  if (std::isfinite(native_scale) && native_scale > 0)
    result.Set("nativeDeviceScaleFactor", native_scale);
  result.Set("captureScaleOverride", native_view->GetScaleOverrideForCapture());
  if (auto* screen = display::Screen::Get()) {
    auto* window = native_view->GetNativeView();
    const auto display = window ? screen->GetDisplayNearestView(window)
                                : screen->GetPrimaryDisplay();
    result.Set("hostDisplayDeviceScaleFactor", display.device_scale_factor());
  }
  const auto requested = native_view->GetRequestedRendererSizeDevicePx();
  if (!requested.IsEmpty())
    result.Set("requestedRendererDevicePixels", size_value(requested));
  const auto viewport = native_view->GetCompositorViewportPixelSize();
  if (!viewport.IsEmpty())
    result.Set("compositorViewportPixels", size_value(viewport));
  if (auto* host = content::RenderWidgetHostImpl::From(
          native_view->GetRenderWidgetHost())) {
    // This is the last metadata already delivered to the browser; do not turn
    // on ReportAllFrameSubmissionsForTesting or introduce per-frame IPC.
    const auto& metadata =
        host->render_frame_metadata_provider()->LastRenderFrameMetadata();
    if (!metadata.viewport_size_in_pixels.IsEmpty()) {
      base::DictValue submitted;
      if (std::isfinite(metadata.device_scale_factor) &&
          metadata.device_scale_factor > 0)
        submitted.Set("deviceScaleFactor", metadata.device_scale_factor);
      submitted.Set("viewportPixels", size_value(metadata.viewport_size_in_pixels));
      result.Set("lastSubmittedFrame", std::move(submitted));
    }
  }
  return result;
}

Status WebView::TouchInjectionStatus() const {
  if (touch_cleanup_pending_)
    return Fail(Error::busy, "Draining remote touch before releasing its emulator");
  if (touch_hit_test_pending_)
    return Fail(Error::busy, "Resolving touch target; retry subsequent input");
  if (HasTouchEmulatorConflict())
    return Fail(Error::unsupported, "Remote touch is exclusive with DevTools touch emulation");
  if (!touches_.empty() && !TouchTargetAlive())
    return Fail(Error::stale, "Touch target/document is no longer current");
  if (touch_pending_callbacks_)
    return {Error::none, "Submitted to Chromium; input processing pending, execution unconfirmed"};
  return touch_status_;
}

void WebView::DevToolsAgentHostAttached(content::DevToolsAgentHost* host) {
  if (!contents_ || host->GetWebContents() != contents_.get())
    return;
  // Remember a takeover even if CDP attaches and detaches between two remote
  // calls. Its private mode can change before we next inspect IsEnabled().
  touch_emulator_owned_ = false;
  touch_emulator_.reset();
  CancelTouches(false);
  touch_status_ =
      Fail(Error::unsupported, "DevTools attachment invalidated remote touch ownership");
}

bool WebView::HasTouchEmulatorConflict() const {
  if (!contents_)
    return false;
  // IsDebuggerAttached only checks the main-frame/tab hosts. Include attached
  // OOPIF hosts too: all these hosts share a single WebContents touch emulator.
  for (const auto& host : content::DevToolsAgentHost::GetAll())
    if (host->IsAttached() && host->GetWebContents() == contents_.get())
      return true;
  return false;
}

bool WebView::TouchTargetAlive() const {
  return PointerTargetAlive() && touch_target_view_ && touch_target_frame_ &&
         touch_target_document_ && InputFrameReady(touch_target_frame_.get()) &&
         touch_target_frame_->GetDocumentToken() == *touch_target_document_ &&
         touch_target_frame_->GetRenderWidgetHost()->GetView() == touch_target_view_.get() &&
         touch_target_view_->GetRootView() == pointer_root_view_.get() &&
         pointer_root_widget_->GetInputEventRouter() &&
         pointer_root_widget_->GetInputEventRouter()->IsViewInMap(touch_target_view_.get());
}

Status WebView::EnsureTouchEmulator() {
  if (HasTouchEmulatorConflict()) {
    // Its mode is private. Once CDP attaches we cannot prove it is still ours;
    // in particular, never Disable() an emulator that CDP may have taken over.
    touch_emulator_owned_ = false;
    touch_emulator_.reset();
    touches_.clear();
    touch_pointer_ids_.clear();
    return Fail(Error::unsupported, "Remote touch is exclusive with attached DevTools");
  }
  if (!PointerTargetAlive())
    return Fail(Error::stale, "Touch document is no longer current");
  auto* emulator = pointer_root_widget_->GetTouchEmulator(true);
  if (!emulator)
    return Fail(Error::unavailable, "Touch emulator unavailable");
  if (touch_emulator_owned_ && touch_emulator_.get() == emulator && emulator->IsEnabled())
    return {};
  if (emulator->IsEnabled())
    return Fail(Error::unavailable,
                "Touch emulator already enabled by another owner; reload required");
  emulator->Enable(input::TouchEmulator::Mode::kInjectingTouchEvents,
                   ui::GestureProviderConfigType::CURRENT_PLATFORM);
  touch_emulator_ = emulator->GetWeakPtr();
  touch_emulator_owned_ = true;
  return {};
}

void WebView::CancelTouches(bool deliver) {
  ++touch_epoch_;
  touch_hit_test_pending_ = false;
  // A second lifecycle notification must not cancel the drain's deadline or
  // inject a second cancel. Its first cancel already belongs to the old doc.
  if (touch_cleanup_pending_ && touch_emulator_owned_ && touch_emulator_ &&
      !HasTouchEmulatorConflict())
    return;
  touch_hit_test_timer_.Stop();
  if (touch_emulator_owned_ && touch_emulator_ && !HasTouchEmulatorConflict()) {
    auto* emulator = static_cast<content::TouchEmulatorImpl*>(touch_emulator_.get());
    if (deliver && TouchTargetAlive() && (!touches_.empty() || touch_pending_callbacks_)) {
      touch_cleanup_pending_ = true;
      const auto ack_epoch = touch_ack_epoch_;
      touch_hit_test_timer_.Start(
          FROM_HERE, base::Seconds(2),
          base::BindOnce(
              [](base::WeakPtr<WebView> self, std::uint64_t expected) {
                if (!self || !self->touch_cleanup_pending_ || self->touch_ack_epoch_ != expected)
                  return;
                // No CPU wait and no unsafe Disable/re-enable with old ACKs still
                // in flight. Keep Chromium's resources until WebContents teardown.
                self->touch_emulator_owned_ = false;
                self->touch_emulator_.reset();
                self->touch_cleanup_pending_ = false;
                self->touch_owner_lost_ = true;
                ++self->touch_ack_epoch_;
                self->touch_pending_callbacks_ = 0;
                self->touch_status_ =
                    Fail(Error::unavailable, "Touch cleanup ACK timed out; reload required");
              },
              weak_factory_.GetWeakPtr(), ack_epoch));
      if (!touches_.empty()) {
        // CancelTouch() itself is a no-op in injection mode. Inject exactly one
        // ALL-cancelled event while still bound to the old document instead.
        blink::WebTouchEvent cancel(Type::kTouchCancel, 0, base::TimeTicks::Now());
        cancel.dispatch_type = blink::WebInputEvent::DispatchType::kEventNonBlocking;
        for (const auto& [id, point] : touches_) {
          auto& p = cancel.touches[cancel.touches_length++];
          p.id = touch_pointer_ids_.at(id);
          p.state = blink::WebTouchPoint::State::kStateCancelled;
          p.pointer_type = blink::WebPointerProperties::PointerType::kTouch;
          p.SetPositionInWidget(static_cast<float>(point.x + touch_root_offset_x_),
                                static_cast<float>(point.y + touch_root_offset_y_));
          p.SetPositionInScreen(ViewportToScreen(pointer_root_view_.get(), p.PositionInWidget()));
          p.force = static_cast<float>(point.pressure);
        }
        ++touch_pending_callbacks_;
        emulator->InjectTouchEvent(
            cancel, touch_target_view_.get(),
            base::BindOnce(&WebView::OnTouchProcessed, weak_factory_.GetWeakPtr(), ack_epoch));
      }
      touches_.clear();
      touch_pointer_ids_.clear();
      return;
    }
    if (!touch_target_view_ || (touches_.empty() && touch_pending_callbacks_ == 0)) {
      emulator->Disable();
    } else {
      // Never replay an old cancel into a replacement doc using the same RWHV.
      touch_owner_lost_ = true;
      touch_status_ = Fail(Error::stale, "Touch owner lost its document; reload required");
    }
  }
  touch_emulator_owned_ = false;
  touch_emulator_.reset();
  touch_cleanup_pending_ = false;
  ++touch_ack_epoch_;
  touch_pending_callbacks_ = 0;
  touches_.clear();
  touch_pointer_ids_.clear();
  touch_target_view_.reset();
  touch_target_frame_.reset();
  touch_target_document_.reset();
  touch_root_offset_x_ = touch_root_offset_y_ = 0;
}

void WebView::OnTouchProcessed(std::uint64_t expected) {
  if (touch_ack_epoch_ != expected || !touch_pending_callbacks_)
    return;
  --touch_pending_callbacks_;
  if (touch_cleanup_pending_ && touch_pending_callbacks_ == 0) {
    // OnInjectedTouchCompleted pops its queue AFTER running our callback.
    // Defer Disable so it cannot mutate that queue under its caller.
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE,
        base::BindOnce(&WebView::FinishTouchCleanup, weak_factory_.GetWeakPtr(), expected));
  }
}

void WebView::FinishTouchCleanup(std::uint64_t expected) {
  if (!touch_cleanup_pending_ || touch_ack_epoch_ != expected || touch_pending_callbacks_)
    return;
  // The cancel/end's canonical completion has drained all our injected events.
  // Disable can now release the provider without sending another live cancel
  // or feeding late ACKs into a newly created provider.
  touch_cleanup_pending_ = false;
  CancelTouches(false);
}

Status WebView::DispatchTouches(const TouchInput& touch, const InputToken& token) {
  if (touch.action == TouchInput::Action::start && touches_.empty()) {
    if (touch_pending_callbacks_)
      return Fail(Error::unavailable, "Previous touch sequence is still being acknowledged");
    auto* root = pointer_root_widget_.get();
    if (!root || !root->delegate())
      return Fail(Error::unavailable, "Touch hit testing unavailable");
    touch_hit_test_pending_ = true;
    touch_status_ = {};
    const auto epoch = ++touch_epoch_;
    touch_hit_test_timer_.Start(FROM_HERE, base::Seconds(2),
                                base::BindOnce(
                                    [](base::WeakPtr<WebView> self, std::uint64_t expected) {
                                      if (!self || self->touch_epoch_ != expected)
                                        return;
                                      self->CancelTouches(true);
                                      self->touch_status_ =
                                          Fail(Error::unavailable, "Touch hit test timed out");
                                    },
                                    weak_factory_.GetWeakPtr(), epoch));
    // As in DevTools InputHandler, hit test once before injection. Injecting
    // into rootView directly would skip OOPIF hit testing entirely.
    root->delegate()->GetRenderWidgetHostAtPointAsynchronously(
        pointer_root_view_.get(),
        gfx::PointF(static_cast<float>(touch.points.front().x),
                    static_cast<float>(touch.points.front().y)),
        base::BindOnce(&WebView::OnTouchTarget, weak_factory_.GetWeakPtr(), epoch, token, touch));
    // The hit tester may complete synchronously. Otherwise this means accepted,
    // not delivered: TouchInjectionStatus() exposes the eventual result.
    return touch_hit_test_pending_ ? Status{} : touch_status_;
  }
  return touch_status_ = InjectTouches(touch);
}

void WebView::OnTouchTarget(std::uint64_t epoch,
                            InputToken token,
                            TouchInput touch,
                            base::WeakPtr<content::RenderWidgetHostViewBase> target,
                            std::optional<gfx::PointF> transformed) {
  if (epoch != touch_epoch_ || !touch_hit_test_pending_)
    return;
  touch_hit_test_pending_ = false;
  touch_hit_test_timer_.Stop();
  const auto* model = endpoint_->FindWebView(session_, view_);
  if (!PointerTargetAlive() || !input_commit_navigations_.empty() || !model ||
      model->instance != token.instance || model->document != token.document ||
      model->focus_generation != token.focus || !model->focused || model->pending ||
      model->actual != Residency::live) {
    touch_status_ = Fail(Error::stale, "Touch target resolution crossed a document/focus boundary");
    return;
  }
  if (!target || !transformed || target->GetRootView() != pointer_root_view_.get()) {
    touch_status_ = Fail(Error::unavailable, "No current touch target in this WebView");
    return;
  }
  auto* widget = target->GetRenderWidgetHost();
  content::RenderFrameHostImpl* target_frame = nullptr;
  contents_->GetPrimaryMainFrame()->ForEachRenderFrameHost([&](content::RenderFrameHost* frame) {
    if (frame->GetRenderWidgetHost() == widget &&
        (!frame->GetParent() || frame->GetParent()->GetRenderWidgetHost() != widget))
      target_frame = static_cast<content::RenderFrameHostImpl*>(frame);
  });
  if (!InputFrameReady(target_frame)) {
    touch_status_ = Fail(Error::unavailable, "Touch target has no active local-root document");
    return;
  }
  // The router expects root coordinates even when its explicit target is an
  // OOPIF. Preserve the same coordinate conversion used by DevTools.
  const gfx::PointF root_point = target->TransformPointToRootCoordSpaceF(*transformed);
  touch_root_offset_x_ = root_point.x() - touch.points.front().x;
  touch_root_offset_y_ = root_point.y() - touch.points.front().y;
  touch_target_view_ = std::move(target);
  touch_target_frame_ = target_frame->GetWeakPtr();
  touch_target_document_ = target_frame->GetDocumentToken();
  touch_status_ = InjectTouches(touch);
}

Status WebView::SendTouchEvent(const blink::WebTouchEvent& event) {
  if (!TouchTargetAlive())
    return Fail(Error::stale, "Touch target/document changed");
  auto ready = EnsureTouchEmulator();
  if (!ready)
    return ready;
  // No public result distinguishes native-stream exclusion from a synchronous
  // browser-filtered ACK. Neither is a confirmed injection: fail conservatively
  // and discard our contact model rather than retaining a fictitious contact.
  auto completed_inline = std::make_shared<bool>(false);
  const auto epoch = touch_ack_epoch_;
  ++touch_pending_callbacks_;
  static_cast<content::TouchEmulatorImpl*>(touch_emulator_.get())
      ->InjectTouchEvent(event, touch_target_view_.get(),
                         base::BindOnce(
                             [](base::WeakPtr<WebView> self, std::uint64_t expected,
                                std::shared_ptr<bool> completed) {
                               *completed = true;
                               if (self)
                                 self->OnTouchProcessed(expected);
                             },
                             weak_factory_.GetWeakPtr(), epoch, completed_inline));
  if (*completed_inline) {
    CancelTouches(true);
    return Fail(Error::unavailable,
                "Touch delivery unconfirmed: native touch or browser filtering");
  }
  return {};
}

Status WebView::InjectTouches(const TouchInput& touch) {
  if (!TouchTargetAlive()) {
    CancelTouches(false);
    return Fail(Error::stale, "Touch target/document changed");
  }
  if (touch_pending_callbacks_ + touch.points.size() + 1 > 128)
    return Fail(Error::unavailable, "Touch ACK queue full");
  for (const auto& point : touch.points)
    if (!FloatFits(point.x + touch_root_offset_x_) || !FloatFits(point.y + touch_root_offset_y_))
      return Fail(Error::invalid, "Transformed touch point outside Blink representation");
  auto ready = EnsureTouchEmulator();
  if (!ready)
    return ready;
  const auto emit = [&](Type type, std::optional<std::uint32_t> changed) -> Status {
    blink::WebTouchEvent event(type, 0, base::TimeTicks::Now());
    event.dispatch_type = type == Type::kTouchCancel
                              ? blink::WebInputEvent::DispatchType::kEventNonBlocking
                              : blink::WebInputEvent::DispatchType::kBlocking;
    for (const auto& [id, point] : touches_) {
      auto& p = event.touches[event.touches_length++];
      p.id = touch_pointer_ids_.at(id);
      p.pointer_type = blink::WebPointerProperties::PointerType::kTouch;
      p.SetPositionInWidget(static_cast<float>(point.x + touch_root_offset_x_),
                            static_cast<float>(point.y + touch_root_offset_y_));
      p.SetPositionInScreen(ViewportToScreen(pointer_root_view_.get(), p.PositionInWidget()));
      p.force = static_cast<float>(point.pressure);
      using State = blink::WebTouchPoint::State;
      p.state = type == Type::kTouchCancel  ? State::kStateCancelled
                : changed != id             ? State::kStateStationary
                : type == Type::kTouchStart ? State::kStatePressed
                : type == Type::kTouchMove  ? State::kStateMoved
                                            : State::kStateReleased;
    }
    // TouchEmulator assigns the global ui::GetNextTouchEventId() before routing
    // and owns canonical (including synthetic/OOPIF) ACK and gesture synthesis.
    return SendTouchEvent(event);
  };
  if (touch.action == TouchInput::Action::cancel) {
    // MotionEventWeb requires ALL contacts cancelled in a cancellation event.
    auto status = emit(Type::kTouchCancel, std::nullopt);
    touches_.clear();
    touch_pointer_ids_.clear();
    return status;
  }
  for (const auto& point : touch.points) {
    if (touch.action == TouchInput::Action::start) {
      // Android-derived gesture code requires compact pointer IDs <= 31.
      // External IDs remain arbitrary uint32; only this per-sequence map is compact.
      int pointer_id = 0;
      while (std::any_of(touch_pointer_ids_.begin(), touch_pointer_ids_.end(),
                         [pointer_id](const auto& pair) { return pair.second == pointer_id; }))
        ++pointer_id;
      touch_pointer_ids_[point.id] = pointer_id;
    }
    touches_[point.id] = point;
    auto status = emit(touch.action == TouchInput::Action::start  ? Type::kTouchStart
                       : touch.action == TouchInput::Action::move ? Type::kTouchMove
                                                                  : Type::kTouchEnd,
                       point.id);
    if (!status) {
      CancelTouches(true);
      return status;
    }
    if (touch.action == TouchInput::Action::end) {
      touches_.erase(point.id);
      touch_pointer_ids_.erase(point.id);
    }
  }
  return {};
}
Status WebView::DispatchInput(const InputEvent& input) {
  static_assert(kMouseButtonModifiers ==
      (blink::WebInputEvent::kLeftButtonDown | blink::WebInputEvent::kMiddleButtonDown |
       blink::WebInputEvent::kRightButtonDown | blink::WebInputEvent::kBackButtonDown |
       blink::WebInputEvent::kForwardButtonDown));
  if (touch_hit_test_pending_ || touch_cleanup_pending_)
    return Fail(Error::busy, "Resolving/draining touch; retry this input with the same sequence");
  if (!input_commit_navigations_.empty())
    return Fail(Error::unavailable, "Document commit is in progress");
  if (lifecycle_uncertain_)
    return Fail(Error::unavailable, "Browser lifecycle state uncertain; unload required");
  if (input.token.view != view_ || input.token.session != session_)
    return Fail(Error::wrong_session, "Input targets another WebView/session");
  const bool hover = IsHoverInput(input.payload);
  auto* root = RootWidget(contents_.get());
  auto* host = hover ? root : FocusedWidget();
  auto* root_view = RootView(contents_.get());
  if (!host || !root || !root_view)
    return Fail(Error::unavailable, "Renderer widget required");
  auto valid = ValidateInput(input.payload);
  if (!valid)
    return valid;
  if (hover && (!visible_ || !InputFrameReady(contents_->GetPrimaryMainFrame())))
    return Fail(Error::unavailable, "Hover requires a visible live WebView");
  if (hover && !pressed_mouse_buttons_.empty()) {
    const auto* model = endpoint_->FindWebView(session_, view_);
    if (!model || !model->focused)
      return Fail(Error::unavailable, "Mouse drag requires focus");
  }
  const bool routed = std::holds_alternative<MouseInput>(input.payload) ||
                      std::holds_alternative<WheelInput>(input.payload) ||
                      std::holds_alternative<TouchInput>(input.payload);
  auto* router = root->GetInputEventRouter();
  if (routed && !router)
    return Fail(Error::unavailable, "Input routing unavailable");
  std::map<std::uint32_t, TouchPoint> next_touches;
  if (const auto* touch = std::get_if<TouchInput>(&input.payload)) {
    if (touch_owner_lost_)
      return Fail(Error::unavailable, "Touch ownership became uncertain; reload WebView required");
    if (HasTouchEmulatorConflict())
      return Fail(Error::unsupported, "Remote touch is exclusive with attached DevTools");
    auto* existing_emulator = root->GetTouchEmulator(false);
    if (existing_emulator && existing_emulator->IsEnabled() &&
        (!touch_emulator_owned_ || touch_emulator_.get() != existing_emulator))
      return Fail(Error::busy, "Touch emulator belongs to another owner; reload may be required");
    if (touch_pending_callbacks_ + touch->points.size() + 1 > 128 ||
        (touch->action == TouchInput::Action::start && touches_.empty() &&
         touch_pending_callbacks_))
      return Fail(Error::busy, "Touch ACK queue busy; retry this input with the same sequence");
    auto status = BuildTouchState(*touch, &next_touches);
    if (!status)
      return status;
  }
  auto representable = std::visit(
      [](const auto& value) {
        using T = std::decay_t<decltype(value)>;
        if constexpr (std::is_same_v<T, MouseInput>)
          return FloatFits(value.x) && FloatFits(value.y);
        else if constexpr (std::is_same_v<T, WheelInput>)
          return FloatFits(value.x) && FloatFits(value.y) && FloatFits(value.delta_x) &&
                 FloatFits(value.delta_y);
        else if constexpr (std::is_same_v<T, KeyInput>)
          return value.physical_code <=
                     static_cast<std::uint32_t>(std::numeric_limits<int>::max()) &&
                 value.dom_code <= static_cast<std::uint32_t>(std::numeric_limits<int>::max());
        else if constexpr (std::is_same_v<T, ImeSet>)
          return value.selection_end <= static_cast<std::uint32_t>(std::numeric_limits<int>::max());
        else
          return true;
      },
      input.payload);
  if (!representable)
    return Fail(Error::invalid, "Input exceeds Blink representation");
  auto accepted = endpoint_->AcceptInput(session_, input);
  if (!accepted)
    return accepted;
  if (routed)
    RememberPointerTarget();
  else
    PrepareKeyboardTarget(host);
  if (const auto* touch = std::get_if<TouchInput>(&input.payload))
    return DispatchTouches(*touch, input.token);
  std::visit(
      [&](const auto& value) {
        using T = std::decay_t<decltype(value)>;
        const auto now = base::TimeTicks::Now();
        if constexpr (std::is_same_v<T, KeyInput>) {
          int modifiers = static_cast<int>(value.modifiers);
          if (value.repeat)
            modifiers |= blink::WebInputEvent::kIsAutoRepeat;
          input::NativeWebKeyboardEvent event(
              value.action == KeyInput::Action::character ? Type::kChar
              : value.action == KeyInput::Action::down    ? Type::kRawKeyDown
                                                          : Type::kKeyUp,
              modifiers, now);
          event.windows_key_code = value.windows_key_code;
          event.native_key_code = static_cast<int>(value.physical_code);
          event.dom_code = static_cast<int>(value.dom_code);
          event.dom_key = static_cast<std::uint32_t>(value.dom_key);
          if (value.action == KeyInput::Action::character && !value.text.empty() &&
              value.text[0] >= 32) {
            uint32_t character = value.text[0];
            if (character >= 0xd800 && character <= 0xdbff && value.text.size() >= 2)
              character = 0x10000 + ((character - 0xd800) << 10) + value.text[1] - 0xdc00;
            event.dom_key = static_cast<uint32_t>(ui::DomKey::FromCharacter(character));
          }
          std::copy(value.text.begin(), value.text.end(), event.text.begin());
          std::copy(value.unmodified_text.begin(), value.unmodified_text.end(),
                    event.unmodified_text.begin());
          if (value.action == KeyInput::Action::down)
            pressed_keys_[value.physical_code] = value;
          else if (value.action == KeyInput::Action::up)
            pressed_keys_.erase(value.physical_code);
          host->ForwardKeyboardEvent(event);
          if (value.action == KeyInput::Action::down && !value.text.empty()) {
            event.SetType(Type::kChar);
            host->ForwardKeyboardEvent(event);
          }
        } else if constexpr (std::is_same_v<T, MouseInput>) {
          Type type = value.action == MouseInput::Action::move   ? Type::kMouseMove
                      : value.action == MouseInput::Action::down ? Type::kMouseDown
                      : value.action == MouseInput::Action::leave ? Type::kMouseLeave
                                                                 : Type::kMouseUp;
          blink::WebMouseEvent event(type, static_cast<int>(value.modifiers), now);
          event.SetPositionInWidget(static_cast<float>(value.x), static_cast<float>(value.y));
          event.SetPositionInScreen(ViewportToScreen(root_view, event.PositionInWidget()));
          event.button = Button(value.button);
          event.click_count = (value.action == MouseInput::Action::move ||
                               value.action == MouseInput::Action::leave) ? 0 : value.click_count;
          last_mouse_ = value;
          if (value.button && value.action == MouseInput::Action::down)
            pressed_mouse_buttons_.insert(value.button);
          else if (value.action == MouseInput::Action::up)
            pressed_mouse_buttons_.erase(value.button);
          router->RouteMouseEvent(root_view, &event, ui::LatencyInfo());
        } else if constexpr (std::is_same_v<T, WheelInput>) {
          blink::WebMouseWheelEvent event(Type::kMouseWheel, static_cast<int>(value.modifiers),
                                          now);
          event.SetPositionInWidget(static_cast<float>(value.x), static_cast<float>(value.y));
          event.SetPositionInScreen(ViewportToScreen(root_view, event.PositionInWidget()));
          event.delta_x = static_cast<float>(value.delta_x);
          event.delta_y = static_cast<float>(value.delta_y);
          event.delta_units = ui::ScrollGranularity::kScrollByPixel;
          event.event_action =
              blink::WebMouseWheelEvent::GetPlatformSpecificDefaultEventAction(event);
          router->RouteMouseWheelEvent(root_view, &event, ui::LatencyInfo());
        } else if constexpr (std::is_same_v<T, ImeSet>) {
          host->ImeSetComposition(value.text, {}, gfx::Range::InvalidRange(),
                                  static_cast<int>(value.selection_start),
                                  static_cast<int>(value.selection_end));
        } else if constexpr (std::is_same_v<T, ImeCommit>) {
          host->ImeCommitText(value.text, {}, gfx::Range::InvalidRange(), 0);
        } else if constexpr (std::is_same_v<T, ImeCancel>)
          host->ImeCancelComposition();
        else if constexpr (std::is_same_v<T, ImeFinish>)
          host->ImeFinishComposingText(false);
      },
      input.payload);
  return {};
}

Status WebView::CheckQuiescent() const {
  if (!contents_) return Fail(Error::unavailable, "WebView is unloaded");
  if (contents_->GetVisibility() != content::Visibility::HIDDEN)
    return Fail(Error::unavailable, "WebView is visible");
  if (contents_->IsCurrentlyAudible())
    return Fail(Error::unavailable, "WebView is playing audio");
  if (contents_->IsLoading() || contents_->HasUncommittedNavigationInPrimaryMainFrame() ||
      contents_->GetController().GetPendingEntry())
    return Fail(Error::unavailable, "Navigation is in progress");
  if (contents_->IsCrashed()) return Fail(Error::unavailable, "Renderer has crashed");
  if (contents_->IsBeingDestroyed()) return Fail(Error::unavailable, "WebView is being destroyed");
  if (!contents_->GetPrimaryMainFrame())
    return Fail(Error::unavailable, "Live main frame required");
  if (contents_->GetPrimaryMainFrame()->GetSiteInstance()->GetRelatedActiveContentsCount() > 1)
    return Fail(Error::unavailable, "Related active WebContents prevents lifecycle transition");
  if (contents_->IsBeingCaptured() || contents_->HasPictureInPictureVideo() ||
      contents_->HasPictureInPictureDocument() || contents_->IsFullscreen() ||
      contents_->GetCurrentlyPlayingVideoCount() > 0 || contents_->HasFileSystemAccessHandles() ||
      !contents_->GetInnerWebContents().empty())
    return Fail(
        Error::unavailable,
        "Active capture, media, filesystem, or inner contents prevents lifecycle transition");
  using Capability = content::WebContentsCapabilityType;
  for (auto type :
       {Capability::kUSB, Capability::kBluetoothConnected, Capability::kBluetoothScanning,
        Capability::kHID, Capability::kSerial, Capability::kGeolocation})
    if (contents_->IsCapabilityActive(type))
      return Fail(Error::unavailable, "Active device capability prevents lifecycle transition");
  auto* impl = static_cast<content::WebContentsImpl*>(contents_.get());
  if (impl->GetKeyboardLockWidget() || impl->GetPointerLockWidget())
    return Fail(Error::unavailable, "Active input lock prevents lifecycle transition");
  for (auto* node : impl->GetPrimaryFrameTree().Nodes())
    if (node->HasNavigation() || node->HasPendingCommitNavigation() ||
        node->HasPendingCrossDocumentNavigation())
      return Fail(Error::unavailable, "Frame navigation prevents lifecycle transition");
  bool media_stream = false;
  auto* main = contents_->GetPrimaryMainFrame();
  if (!main || !main->IsRenderFrameLive())
    return Fail(Error::unavailable, "Live main frame required");
  main->ForEachRenderFrameHost([&](content::RenderFrameHost* frame) {
    auto* frame_impl = static_cast<content::RenderFrameHostImpl*>(frame);
    media_stream |=
        frame_impl->HasMediaStreams(content::RenderFrameHostImpl::kCapturingMediaStream) ||
        frame_impl->HasMediaStreams(content::RenderFrameHostImpl::kPlayingAudioStream);
  });
  return media_stream
             ? Fail(Error::unavailable, "Active media stream prevents lifecycle transition")
             : Status{};
}

Status WebView::CanDiscard() const {
  if (lifecycle_request_)
    return Fail(Error::busy, "Lifecycle transition pending");
  if (lifecycle_uncertain_)
    return Fail(Error::unavailable, "Browser lifecycle state uncertain; unload required");
  const auto* model = endpoint_->FindWebView(session_, view_);
  if (!model) return Fail(Error::not_found, "WebView model missing");
  if (model->pending) return Fail(Error::busy, "Lifecycle operation pending");
  if (model->actual != Residency::live && model->actual != Residency::frozen)
    return Fail(Error::invalid, "Discard requires live or frozen state");
  if (touch_cleanup_pending_ || (touch_emulator_owned_ &&
      (!touches_.empty() || touch_pending_callbacks_)))
    return Fail(Error::busy, "Touch cancellation must drain before discard; retry");
  if (touch_owner_lost_)
    return Fail(Error::unavailable, "Touch cleanup uncertain; unload required");
  if (contents_ && contents_->NeedToFireBeforeUnloadOrUnloadEvents())
    return Fail(Error::unavailable, "Beforeunload or unload handler prevents discard");
  auto quiet = CheckQuiescent();
  if (!quiet) return quiet;
  if (!base::FeatureList::IsEnabled(::features::kWebContentsDiscard))
    return Fail(Error::unsupported, "WebContentsDiscard feature is disabled");
  if (contents_->WasDiscarded())
    return Fail(Error::unavailable, "WebContents is already marked discarded");
  return CaptureNavigationState(*contents_).status;
}

bool WebView::AllPageViewsAcknowledged(bool frozen) const {
  if (!contents_ || !contents_->GetPrimaryMainFrame()->IsRenderFrameLive())
    return false;
  auto* impl = static_cast<content::WebContentsImpl*>(contents_.get());
  bool all = true;
  std::size_t count = 0;
  // This is exactly the primary-frame-tree RVH range used by SetPageFrozen,
  // including the OOPIF processes and any speculative view. Do not infer ack
  // from the requested flag or from an RFH's broad "active" lifecycle state.
  impl->GetPrimaryFrameTree().ForEachRenderViewHost([&](content::RenderViewHostImpl* host) {
    ++count;
    auto* manager = host->GetPageLifecycleStateManager();
    if (!host->IsRenderViewLive() || !manager) {
      all = false;
      return;
    }
    const auto& acknowledged = manager->last_acknowledged_state();
    all &= acknowledged.is_frozen == frozen && !acknowledged.is_in_back_forward_cache &&
           acknowledged.visibility == blink::mojom::PageVisibilityState::kHidden;
  });
  return count > 0 && all;
}

void WebView::StartLifecycleTimer() {
  lifecycle_deadline_ = base::TimeTicks::Now() + base::Seconds(10);
  lifecycle_timer_.Start(FROM_HERE, base::Milliseconds(50),
                         base::BindRepeating(&WebView::PollLifecycle, weak_factory_.GetWeakPtr()));
}

Status WebView::RequestLifecycle(Lifecycle action, Completion completion) {
  if (lifecycle_request_)
    return Fail(Error::busy, "Lifecycle transition pending");
  if (lifecycle_uncertain_ && action != Lifecycle::unload)
    return Fail(Error::unavailable, "Browser lifecycle state uncertain; unload required");
  if (action == Lifecycle::freeze || action == Lifecycle::discard) {
    // Freezing/discarding before the cancel ACK can strand the old sequence.
    // Reject before creating a lifecycle request; callers may retry after drain.
    if (touch_emulator_owned_ && (!touches_.empty() || touch_pending_callbacks_))
      ReleasePointer(true);
    if (touch_cleanup_pending_)
      return Fail(Error::busy, "Touch cancellation must drain before freeze/discard; retry");
    if (touch_owner_lost_)
      return Fail(Error::unavailable, "Touch cleanup uncertain; unload required");
  }
  const auto* model = endpoint_->FindWebView(session_, view_);
  if (!model)
    return Fail(Error::not_found, "WebView model missing");
  if (action == Lifecycle::discard) {
    auto allowed = CanDiscard();
    if (!allowed) return allowed;
  }
  const Residency previous = model->actual;
  PendingKind kind = PendingKind::none;
  if (action == Lifecycle::freeze || action == Lifecycle::discard ||
      (action == Lifecycle::restore && previous == Residency::frozen)) {
    auto guard = CheckQuiescent();
    if (!guard)
      return guard;
    if (action == Lifecycle::discard) {
      if (!base::FeatureList::IsEnabled(::features::kWebContentsDiscard))
        return Fail(Error::unsupported, "WebContentsDiscard feature is disabled");
      if (contents_->WasDiscarded())
        return Fail(Error::unavailable, "WebContents is already marked discarded");
      kind = PendingKind::discard;
    } else
      kind = action == Lifecycle::freeze ? PendingKind::freeze : PendingKind::thaw;
  } else if (action == Lifecycle::restore) {
    if (previous == Residency::discarded) {
      if (!contents_ || !contents_->WasDiscarded() || !contents_->GetController().NeedsReload() ||
          contents_->HasUncommittedNavigationInPrimaryMainFrame() ||
          contents_->GetController().GetPendingEntry())
        return Fail(Error::unavailable,
                    "Discard restore requires its idle retained NavigationController");
      auto captured = CaptureNavigationState(*contents_);
      if (!captured)
        return captured.status;
      auto allowed = CheckAutomaticNavigationRestore(captured.value);
      if (!allowed)
        return allowed;
      kind = PendingKind::restore_discarded;
    } else if (previous == Residency::unloaded) {
      if (!navigation_state_)
        return Fail(Error::not_found, "No saved navigation history is available");
      auto allowed = CheckAutomaticNavigationRestore(*navigation_state_);
      if (!allowed)
        return allowed;
      kind = PendingKind::restore_unloaded;
    }
  } else if (action != Lifecycle::unload)
    return Fail(Error::invalid, "Unknown lifecycle action");
  // Snapshot before modifying the browser/model. A failed discard/freeze can
  // then be safely unloaded using the last stable complete controller state.
  if (contents_ && (action == Lifecycle::unload || action == Lifecycle::freeze ||
                    action == Lifecycle::discard)) {
    auto captured = CaptureNavigationState(*contents_);
    if (captured)
      navigation_state_ = std::make_unique<NavigationState>(std::move(captured.value));
    else if (!lifecycle_uncertain_ || !navigation_state_)
      return captured.status;
  }
  auto request = endpoint_->RequestLifecycle(session_, view_, action);
  if (!request)
    return request.status;
  if (auto* focused = FocusedWidget())
    PrepareKeyboardTarget(focused);
  ReleaseKeyboard(action == Lifecycle::freeze, true);
  ReleasePointer(true);
  if (auto* root = RootWidget(contents_.get())) {
    root->SetActive(false);
    root->Blur();
  }
  if (action == Lifecycle::unload) {
    Observe(nullptr);
    DropContents();
    CancelTouches(false);
    input_commit_navigations_.clear();
    lifecycle_uncertain_ = false;
    auto result = endpoint_->CompleteLifecycle(session_, request.value, true);
    if (completion)
      completion(result);
    return {};
  }
  lifecycle_request_ = request.value;
  pending_kind_ = kind;
  discard_acknowledged_ = false;
  completion_ = std::move(completion);
  restore_navigation_ = -1;
  StartLifecycleTimer();
  if (kind == PendingKind::freeze || kind == PendingKind::thaw) {
    contents_->SetPageFrozen(kind == PendingKind::freeze);
    // Even a no-op/previously acknowledged transition is checked by the poll,
    // never reported complete merely because SetPageFrozen returned.
    return {};
  }
  if (kind == PendingKind::discard) {
    contents_->Discard(base::BindOnce(&WebView::OnDiscarded, weak_factory_.GetWeakPtr(),
                                      request.value.generation));
    return {};
  }
  if (kind == PendingKind::restore_discarded) {
    // Keep WebContents, controller history, storage partition, and all browser
    // side controller state. Chromium determines what PageState can restore.
    contents_->GetController().LoadIfNecessary();
    return {};
  }
  Observe(nullptr);
  DropContents();
  CancelTouches(false);
  touch_owner_lost_ = false;
  touch_status_ = {};
  auto restored = CreateRestoredWebContents(context_, *navigation_state_, true);
  if (!restored) {
    FinishLifecycle(false, restored.status);
    return {};
  }
  contents_ = std::move(restored.value);
  BrowserContext::InstallSiteIdentity(contents_.get());
  AttachOffscreenHost();
  const int configured_width = viewport_width_;
  const int configured_height = viewport_height_;
  viewport_width_ = 0;
  ConfigureDevice(configured_width, configured_height, tablet_, device_scale_,
                  match_page_backing_);
  visible_ = false;
  Observe(contents_.get());
  auto* implementation = static_cast<content::WebContentsImpl*>(contents_.get());
  implementation->GetInputEventRouter();
  implementation->GetTouchEmulator(true);
  // DidStartNavigation identifies this controller's selected history restore;
  // actual becomes live only after its non-error main-frame commit.
  contents_->GetController().LoadIfNecessary();
  return {};
}

Status WebView::FinishLifecycle(bool success, Status status) {
  if (!lifecycle_request_)
    return Fail(Error::stale, "No pending lifecycle operation");
  lifecycle_timer_.Stop();
  auto result =
      endpoint_->CompleteLifecycle(session_, *lifecycle_request_, success, status.message);
  lifecycle_request_.reset();
  pending_kind_ = PendingKind::none;
  restore_navigation_ = -1;
  discard_acknowledged_ = false;
  auto callback = std::move(completion_);
  if (!success || !result)
    lifecycle_uncertain_ = true;
  if (!result)
    status = result;
  PostCompletion(std::move(callback), status);
  return status;
}

void WebView::PollLifecycle() {
  if (!lifecycle_request_) {
    lifecycle_timer_.Stop();
    return;
  }
  const auto* model = endpoint_->FindWebView(session_, view_);
  if (!model || !model->pending || model->pending->generation != lifecycle_request_->generation) {
    FinishLifecycle(false, Fail(Error::stale, "Lifecycle operation invalidated externally"));
    return;
  }
  if (pending_kind_ == PendingKind::discard && discard_acknowledged_) {
    if (!contents_ || !contents_->WasDiscarded() || !contents_->GetController().NeedsReload() ||
        contents_->HasUncommittedNavigationInPrimaryMainFrame() ||
        contents_->GetController().GetPendingEntry()) {
      FinishLifecycle(
          false, Fail(Error::unavailable, "Discard completion did not retain idle reload state"));
      return;
    }
    FinishLifecycle(true, {});
    return;
  }
  if (base::TimeTicks::Now() >= lifecycle_deadline_) {
    FinishLifecycle(false,
                    Fail(Error::unavailable,
                         "Lifecycle completion timed out after 10 seconds; unload required"));
    return;
  }
  if (pending_kind_ == PendingKind::freeze || pending_kind_ == PendingKind::thaw) {
    auto guard = CheckQuiescent();
    if (!guard) {
      FinishLifecycle(false, guard);
      return;
    }
    if (AllPageViewsAcknowledged(pending_kind_ == PendingKind::freeze))
      FinishLifecycle(true, {});
  }
}

void WebView::OnDiscarded(std::uint64_t generation) {
  if (!lifecycle_request_ || lifecycle_request_->generation != generation ||
      pending_kind_ != PendingKind::discard)
    return;
  // The closure is invoked after the renderer's discard response (or upstream
  // detects renderer teardown). WasDiscarded alone is only a request-time flag.
  // Defer the user callback to the next poll: Chromium still accesses its RFH
  // after invoking this closure, while user completion may destroy WebContents.
  if (base::TimeTicks::Now() < lifecycle_deadline_)
    discard_acknowledged_ = true;
}

void WebView::DidStartNavigation(content::NavigationHandle* navigation) {
  if (!navigation->IsSameDocument()) {
    auto* focused = contents_ ? contents_->GetFocusedFrame() : nullptr;
    if (focused && NavigationAffectsFrame(navigation, focused))
      PrepareKeyboardTarget(FocusedWidget());
    if (input_frame_ && NavigationAffectsFrame(navigation, input_frame_.get()))
      ReleaseKeyboard(false, true);
    // Pointer targets are selected/latched by InputEventRouter (including
    // OOPIFs). End the sequence while the OLD frame tree is still current.
    bool in_primary_page = false;
    if (contents_ && contents_->GetPrimaryMainFrame())
      contents_->GetPrimaryMainFrame()->ForEachRenderFrameHost(
          [&](content::RenderFrameHost* frame) {
            in_primary_page |= frame->GetFrameTreeNodeId() == navigation->GetFrameTreeNodeId();
          });
    if (in_primary_page)
      ReleasePointer(true);
  }
  if (!lifecycle_request_)
    return;
  if (pending_kind_ == PendingKind::freeze || pending_kind_ == PendingKind::thaw) {
    FinishLifecycle(false,
                    Fail(Error::unavailable, "Navigation interrupted lifecycle acknowledgement"));
    return;
  }
  if ((pending_kind_ == PendingKind::restore_discarded ||
       pending_kind_ == PendingKind::restore_unloaded) &&
      navigation->IsInPrimaryMainFrame() && !navigation->IsSameDocument() &&
      restore_navigation_ == -1)
    restore_navigation_ = navigation->GetNavigationId();
}

void WebView::RenderViewReady() {
  ApplyDevice();
}
void WebView::ReadyToCommitNavigation(content::NavigationHandle* navigation) {
  if (navigation->IsInPrimaryMainFrame())
    ApplyDevice(navigation->GetRenderFrameHost());
  if (navigation->IsSameDocument())
    return;
  bool in_primary_page = navigation->IsInPrimaryMainFrame();
  if (contents_ && contents_->GetPrimaryMainFrame())
    contents_->GetPrimaryMainFrame()->ForEachRenderFrameHost([&](content::RenderFrameHost* frame) {
      in_primary_page |= frame->GetFrameTreeNodeId() == navigation->GetFrameTreeNodeId();
    });
  if (!in_primary_page)
    return;
  // Catch keys pressed after DidStartNavigation but before the commit boundary.
  // Refuse further remote input until DidFinishNavigation: the browser's old
  // token must not enqueue input into a renderer already committing a new doc.
  input_commit_navigations_.insert(navigation->GetNavigationId());
  if (input_frame_ && NavigationAffectsFrame(navigation, input_frame_.get()))
    ReleaseKeyboard(false, true);
  ReleasePointer(true);
}
void WebView::DidFinishNavigation(content::NavigationHandle* navigation) {
  input_commit_navigations_.erase(navigation->GetNavigationId());
  if (input_frame_ && !KeyboardTargetAlive())
    ReleaseKeyboard(false, false);
  if (!navigation->IsInPrimaryMainFrame())
    return;
  const auto* model = endpoint_->FindWebView(session_, view_);
  // Discard commits an internal empty document. It is not a remote navigation
  // and must not advance the logical document generation a second time.
  if (pending_kind_ == PendingKind::discard ||
      (model && model->actual == Residency::discarded && !lifecycle_request_))
    return;
  const bool committed = navigation->HasCommitted() && !navigation->IsSameDocument();
  if (committed) {
    // A same-RFH navigation may already expose its NEW document here. Never
    // dispatch cleanup events from DidFinishNavigation to that new document.
    ReleaseKeyboard(false, false);
    ReleasePointer(false);
  }
  if (lifecycle_request_ && navigation->GetNavigationId() == restore_navigation_ &&
      (pending_kind_ == PendingKind::restore_discarded ||
       pending_kind_ == PendingKind::restore_unloaded)) {
    const bool success = committed && !navigation->IsErrorPage();
    // Callbacks run last because they may destroy this adapter.
    auto callback = std::move(completion_);
    auto status = FinishLifecycle(
        success, success
                     ? Status{}
                     : Fail(Error::unavailable, "Restore navigation did not commit successfully"));
    if (success)
      endpoint_->CommitDocument(session_, view_);
    PostCompletion(std::move(callback), status);
    return;
  }
  if (committed && !lifecycle_uncertain_) {
    endpoint_->CommitDocument(session_, view_);
  }
}

void WebView::PrimaryMainFrameRenderProcessGone(base::TerminationStatus) {
  input_commit_navigations_.clear();
  ReleaseKeyboard(false, false);
  ReleasePointer(false);
  // Discard can legitimately shut down an otherwise unused renderer after its
  // ack. The retained controller remains the restore boundary in that state.
  const auto* model = endpoint_->FindWebView(session_, view_);
  if (pending_kind_ == PendingKind::discard && discard_acknowledged_)
    return;
  if (model && model->actual == Residency::discarded && !lifecycle_request_)
    return;
  auto callback = std::move(completion_);
  if (lifecycle_request_)
    FinishLifecycle(false, Fail(Error::unavailable, "Renderer exited during lifecycle transition"));
  endpoint_->InvalidateInstance(session_, view_);
  PostCompletion(std::move(callback),
                 Fail(Error::unavailable, "Renderer exited during lifecycle transition"));
}
}  // namespace remotekit::browser
