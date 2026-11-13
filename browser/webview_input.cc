#include "browser/webview_input.h"
#include "browser/touch_selection.h"
#include "browser/context_menu.h"
#include "browser/webview_internal.h"
#include "browser/webview_execution.h"
#include "browser/device_configuration.h"
#include "browser/webview_navigation.h"
#include "browser/webview_touch.h"
#include "browser/webview_lifecycle.h"
#include "ui/events/blink/blink_event_util.h"

#include <bit>

namespace remotekit::browser {
namespace {
int KeyLocationModifiers(const KeyInput& key) {
  return ui::DomCodeToWebInputEventModifiers(static_cast<ui::DomCode>(key.dom_code));
}

void SetPenProperties(blink::WebMouseEvent& event, const std::optional<MouseInput::Pen>& pen) {
  if (!pen)
    return;
  using PointerType = blink::WebPointerProperties::PointerType;
  event.pointer_type = pen->eraser ? PointerType::kEraser : PointerType::kPen;
  event.id = std::bit_cast<blink::PointerId>(pen->id);
  event.force = event.GetType() == Type::kMouseUp ? 0.f : static_cast<float>(pen->pressure);
  event.tilt_x = pen->tilt_x;
  event.tilt_y = pen->tilt_y;
  event.twist = static_cast<int>(pen->twist);
}
}  // namespace

InputController::InputController(WebView& owner) : owner_(owner) {}
InputController::~InputController() = default;
void InputController::OnFocusChangedInPage(const content::FocusedNodeDetails& details) {
  const auto& node = details.global_dom_node_id;
  auto* frame = node.document.AsRenderFrameHostIfValid();
  const auto node_id = node.target_element_dom_id.value();
  if (!frame || !node_id || details.editable_level == content::EditableLevel::kNotEditable) {
    editable_target_.reset();
    focused_document_ = {};
    focused_node_id_ = 0;
    focus_source_ = 0;
    return;
  }
  if (focused_document_.AsRenderFrameHostIfValid() != frame || focused_node_id_ != node_id)
    editable_target_.reset();
  focused_document_ = node.document;
  focused_node_id_ = node_id;
  using Source = blink::mojom::FocusType;
  switch (details.focus_type) {
    case Source::kMouse:
      focus_source_ = 1;
      break;
    case Source::kForward:
    case Source::kBackward:
    case Source::kSpatialNavigation:
    case Source::kAccessKey:
      focus_source_ = 2;
      break;
    case Source::kScript:
      focus_source_ = 3;
      break;
    default:
      focus_source_ = 0;
      break;
  }
  CHECK(++focus_observation_);
}
void InputController::InvalidateLayoutInput(bool remains_visible) {
  RemoteContextMenu::Get().CloseFor(owner_.session_, owner_.view_);
  RemoteTouchSelectionMenuRunner::Get().CloseFor(owner_.session_, owner_.view_);
  if (!remains_visible) {
    ReleaseKeyboard(true, true);
  } else {
    const auto* state = UpdateEditableTarget(text_input_observation_.GetSource());
    const bool preserve =
        state && KeyboardTargetAlive() && keyboard_editable_target_id_ == last_editable_target_id_;
    // Coordinate tokens and held keys expire with layout. Composition still
    // belongs to the same editable node and can continue under the new token.
    ReleaseHeldKeys(true);
    if (!preserve) {
      // Chromium tears down the previous editable on focus change. An IME
      // operation on a shared widget now addresses its new focused element.
      ReleaseKeyboard(false, false);
    }
  }
  ReleasePointer(true);
  owner_.model_->InvalidateInput(owner_.session_, owner_.view_);
}
content::RenderWidgetHostImpl* InputController::FocusedWidget() const {
  if (!owner_.contents())
    return nullptr;
  auto* frame = owner_.contents()->GetFocusedFrame();
  if (!InputFrameReady(frame))
    return nullptr;
  return content::RenderWidgetHostImpl::From(frame->GetRenderWidgetHost());
}
bool InputController::KeyboardTargetAlive() const {
  if (!(input_widget_ && input_frame_ && input_document_ && InputFrameReady(input_frame_.get()) &&
        input_frame_->GetDocumentToken() == *input_document_ &&
        input_frame_->GetRenderWidgetHost() == input_widget_.get()))
    return false;
  auto* focused = owner_.contents() ? owner_.contents()->GetFocusedFrame() : nullptr;
  // A shared widget cannot address its previous same-process focused frame.
  // Never send old-frame releases/IME cancellation into that new focused frame.
  return !focused || focused == input_frame_.get() ||
         focused->GetRenderWidgetHost() != input_widget_.get();
}
bool InputController::PointerTargetAlive() const {
  return pointer_root_widget_ && pointer_root_view_ && pointer_frame_ && pointer_document_ &&
         InputFrameReady(pointer_frame_.get()) &&
         pointer_frame_->GetDocumentToken() == *pointer_document_ &&
         pointer_frame_->GetRenderWidgetHost() == pointer_root_widget_.get() &&
         pointer_root_widget_->GetView() == pointer_root_view_.get();
}
void InputController::ReleaseKeyboard(bool finish_composition, bool deliver) {
  if (deliver && KeyboardTargetAlive()) {
    if (finish_composition)
      input_widget_->ImeFinishComposingText(false);
    else
      input_widget_->ImeCancelComposition();
  }
  ReleaseHeldKeys(deliver);
  input_widget_.reset();
  input_frame_.reset();
  input_document_.reset();
  keyboard_editable_target_id_ = 0;
}
void InputController::ReleaseHeldKeys(bool deliver) {
  if (deliver) {
    for (const auto& [physical, key] : pressed_keys_) {
      if (!KeyboardTargetAlive())
        break;
      constexpr int kLockModifiers =
          blink::WebInputEvent::kCapsLockOn | blink::WebInputEvent::kNumLockOn;
      input::NativeWebKeyboardEvent event(
          Type::kKeyUp, KeyLocationModifiers(key) | (key.modifiers & kLockModifiers),
          base::TimeTicks::Now());
      event.native_key_code = static_cast<int>(physical);
      event.windows_key_code = key.windows_key_code;
      event.dom_code = static_cast<int>(key.dom_code);
      event.dom_key = static_cast<std::uint32_t>(key.dom_key);
      input_widget_->ForwardKeyboardEvent(event);
    }
  }
  pressed_keys_.clear();
}
void InputController::PrepareKeyboardTarget(content::RenderWidgetHostImpl* widget) {
  auto* focused = owner_.contents() ? owner_.contents()->GetFocusedFrame() : nullptr;
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
void InputController::RememberPointerTarget() {
  if (PointerTargetAlive())
    return;
  ReleasePointer(false);
  auto* root = RootWidget(owner_.contents());
  auto* view = RootView(owner_.contents());
  auto* frame =
      owner_.contents()
          ? static_cast<content::RenderFrameHostImpl*>(owner_.contents()->GetPrimaryMainFrame())
          : nullptr;
  if (!root || !view || !InputFrameReady(frame))
    return;
  pointer_root_widget_ = root->GetWeakPtr();
  pointer_root_view_ = view->GetWeakPtr();
  pointer_frame_ = frame->GetWeakPtr();
  pointer_document_ = frame->GetDocumentToken();
}
void InputController::ReleasePointer(bool deliver) {
  owner_.touch_->CancelTouches(deliver);
  if (deliver && PointerTargetAlive()) {
    auto* router = pointer_root_widget_->GetInputEventRouter();
    if (router) {
      for (const auto& [id, held] : held_pointers_) {
        const auto& last = held.last_event;
        int modifiers = static_cast<int>(last.modifiers);
        for (auto button : held.buttons) {
          if (!PointerTargetAlive())
            break;
          modifiers &= ~MouseButtonModifier(button);
          blink::WebMouseEvent event(Type::kMouseUp, modifiers, base::TimeTicks::Now());
          SetPenProperties(event, last.pen);
          event.button = Button(button);
          event.click_count = 1;
          event.SetPositionInWidget(static_cast<float>(last.x), static_cast<float>(last.y));
          event.SetPositionInScreen(
              ViewportToScreen(pointer_root_view_.get(), event.PositionInWidget()));
          router->RouteMouseEvent(pointer_root_view_.get(), &event, ui::LatencyInfo());
        }
      }
    }
  }
  owner_.touch_->touches_.clear();
  held_pointers_.clear();
  pointer_root_widget_.reset();
  pointer_root_view_.reset();
  pointer_frame_.reset();
  pointer_document_.reset();
}
const ui::mojom::TextInputState* InputController::UpdateEditableTarget(
    content::TextInputManager* manager) {
  const auto* model = owner_.model_->FindWebView(owner_.session_, owner_.view_);
  auto* active = manager ? manager->GetActiveWidget() : nullptr;
  auto* focused = owner_.contents() ? owner_.contents()->GetFocusedFrame() : nullptr;
  const auto* state = active ? manager->GetTextInputState() : nullptr;
  // TextInputManager can retain the old editable after the page moved focus.
  // Only the observed focused node may own an editable target.
  if (!owner_.execution_->visible_ || !model || !model->focused ||
      model->actual != Residency::live || model->pending || !input_commit_navigations_.empty() ||
      owner_.lifecycle_->lifecycle_uncertain_ || !active || !active->GetView() ||
      !InputFrameReady(focused) || active != focused->GetRenderWidgetHost() || !state ||
      !state->node_id || state->type == ui::TEXT_INPUT_TYPE_NONE ||
      focused_document_.AsRenderFrameHostIfValid() != focused ||
      focused_node_id_ != state->node_id) {
    editable_target_.reset();
    return nullptr;
  }
  auto* frame = static_cast<content::RenderFrameHostImpl*>(focused);
  const auto document = frame->GetDocumentToken();
  if (!editable_target_ || editable_target_->widget.get() != active ||
      editable_target_->frame.get() != frame || editable_target_->document != document ||
      editable_target_->node_id != state->node_id) {
    editable_target_ =
        EditableTarget{active->GetWeakPtr(), frame->GetWeakPtr(), document, state->node_id};
    CHECK(++last_editable_target_id_);
  }
  return state;
}
void InputController::OnUpdateTextInputStateCalled(content::TextInputManager* manager,
                                                   content::RenderWidgetHostViewBase*,
                                                   bool) {
  UpdateEditableTarget(manager);
}
SharedAtlasTextInput InputController::TextInputState() {
  SharedAtlasTextInput result{};
  auto* manager = text_input_observation_.GetSource();
  const auto* state = UpdateEditableTarget(manager);
  if (!state)
    return result;
  result.target_id = last_editable_target_id_;
  result.type = static_cast<std::uint32_t>(state->type);
  result.flags = kAtlasTextInputActive;
  if (focused_document_.AsRenderFrameHostIfValid() == editable_target_->frame.get() &&
      focused_node_id_ == state->node_id) {
    result.focus_source = focus_source_;
    result.focus_observation = focus_observation_;
  }
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
Status InputController::CanFocus(bool focused) const {
  if (focused && (owner_.lifecycle_->lifecycle_uncertain_ || !owner_.contents() ||
                  !owner_.execution_->visible_ || !RootWidget(owner_.contents()) ||
                  !RootView(owner_.contents())))
    return Fail(ErrorCode::kConflict, "Visible renderer view required for focus");
  return owner_.model_->CanFocus(owner_.session_, owner_.view_, focused);
}
Status InputController::Focus(bool focused) {
  auto allowed = CanFocus(focused);
  if (!allowed)
    return allowed;
  if (!focused) {
    RemoteContextMenu::Get().CloseFor(owner_.session_, owner_.view_);
    RemoteTouchSelectionMenuRunner::Get().CloseFor(owner_.session_, owner_.view_);
    editable_target_.reset();
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
  auto status = owner_.model_->SetFocus(owner_.session_, owner_.view_, focused);
  if (!status)
    return status;
  if (owner_.contents()) {
    if (focused)
      owner_.contents()->Focus();
    if (!focused && owner_.offscreen_host())
      owner_.offscreen_host()->ClearFocus();
    if (auto* host = RootWidget(owner_.contents())) {
      host->SetActive(focused);
      if (focused)
        host->Focus();
      else
        host->Blur();
    }
  }
  return {};
}
void InputController::RenderFrameDeleted(content::RenderFrameHost* frame) {
  if (input_frame_.get() == frame)
    ReleaseKeyboard(false, false);
  if (pointer_frame_.get() == frame || owner_.touch_->touch_target_frame_.get() == frame)
    ReleasePointer(false);
}
void InputController::RenderFrameHostChanged(content::RenderFrameHost* old_frame,
                                             content::RenderFrameHost* new_frame) {
  // This notification is a document/RFH replacement, not an ordinary iframe
  // focus move. The old target may already have gone away: never use the new.
  if (input_frame_.get() == old_frame)
    ReleaseKeyboard(false, KeyboardTargetAlive());
  if (pointer_frame_.get() == old_frame || owner_.touch_->touch_target_frame_.get() == old_frame)
    ReleasePointer(false);
}
Status InputController::DispatchInput(const InputEvent& original, bool* admitted) {
  InputEvent input = original;
  if (auto* host = owner_.offscreen_host();
      host && host->page_viewport().height() < host->plane_size().height()) {
    const double bottom = host->page_viewport().height();
    const auto clip = [bottom](auto& point) {
      point.y = std::min(point.y, std::max(0.0, bottom - 0.001));
    };
    const bool outside = std::visit(
        [&](auto& value) {
          using T = std::decay_t<decltype(value)>;
          if constexpr (std::is_same_v<T, MouseInput>) {
            if (value.action == MouseInput::Action::down && value.y >= bottom)
              return true;
            clip(value);
          } else if constexpr (std::is_same_v<T, WheelInput>) {
            return value.y >= bottom;
          } else if constexpr (std::is_same_v<T, SelectionExtent>) {
            clip(value);
          } else if constexpr (std::is_same_v<T, GestureInput>) {
            if (value.action == GestureInput::Action::long_press && value.y >= bottom)
              return true;
            clip(value);
          } else if constexpr (std::is_same_v<T, TouchInput>) {
            if (value.action == TouchInput::Action::start &&
                std::ranges::any_of(value.points,
                                    [bottom](const auto& point) { return point.y >= bottom; }))
              return true;
            for (auto& point : value.points)
              clip(point);
            for (auto& sample : value.samples)
              for (auto& point : sample.points)
                clip(point);
            for (auto& gesture : value.gestures)
              clip(gesture);
          }
          return false;
        },
        input.payload);
    if (outside) {
      if (admitted)
        *admitted = false;
      return Fail(ErrorCode::kConflict, "input_in_occluded_band");
    }
  }
  if (admitted)
    *admitted = false;
  static_assert(kMouseButtonModifiers ==
                (blink::WebInputEvent::kLeftButtonDown | blink::WebInputEvent::kMiddleButtonDown |
                 blink::WebInputEvent::kRightButtonDown | blink::WebInputEvent::kBackButtonDown |
                 blink::WebInputEvent::kForwardButtonDown));
  if (IsDismissInput(input.payload)) {
    auto status = owner_.model_->AcceptInput(owner_.session_, input);
    if (!status)
      return status;
    if (admitted)
      *admitted = true;
    if (input.token != owner_.model_->Token(owner_.session_, owner_.view_).value)
      return {};
    if (const auto* dismiss = std::get_if<EditingDismiss>(&input.payload)) {
      if (!UpdateEditableTarget(text_input_observation_.GetSource()) ||
          dismiss->target != last_editable_target_id_)
        return {};
      ReleaseKeyboard(true, true);
      editable_target_.reset();
      owner_.contents()->ClearFocusedElement();
    } else if (const auto* command = std::get_if<SelectionCommand>(&input.payload)) {
      RemoteTouchSelectionMenuRunner::Get().Dismiss(owner_.session_, owner_.view_, command->menu);
    } else if (const auto* context = std::get_if<ContextCommand>(&input.payload)) {
      return RemoteContextMenu::Get().Execute(owner_.session_, owner_.view_, *context);
    }
    return {};
  }
  owner_.touch_->RefreshClientTouchOwner();
  const auto* client_gesture = std::get_if<GestureInput>(&input.payload);
  const bool expired_long_press =
      client_gesture && client_gesture->action == GestureInput::Action::long_press &&
      client_gesture->sequence_id != owner_.touch_->client_touch_sequence_;
  if (!expired_long_press && !owner_.touch_->StartsNewSequence(input) &&
      owner_.touch_->AdmissionPending())
    return Fail(ErrorCode::kBusy,
                "Resolving/draining touch; retry this input with the same sequence");
  if (!input_commit_navigations_.empty())
    return Fail(ErrorCode::kConflict, "Document commit is in progress");
  if (owner_.lifecycle_->lifecycle_uncertain_)
    return Fail(ErrorCode::kConflict, "Browser lifecycle state uncertain; unload required");
  if (input.token.view != owner_.view_ || input.token.session != owner_.session_)
    return Fail(ErrorCode::kConflict, "Input targets another WebView/session");
  const bool hover = IsHoverInput(input.payload);
  auto* root = RootWidget(owner_.contents());
  auto* host = hover ? root : FocusedWidget();
  auto* root_view = RootView(owner_.contents());
  if (!host || !root || !root_view)
    return Fail(ErrorCode::kUnavailable, "Renderer widget required");
  auto valid = ValidateInput(input.payload);
  if (!valid)
    return valid;
  if (hover &&
      (!owner_.execution_->visible_ || !InputFrameReady(owner_.contents()->GetPrimaryMainFrame())))
    return Fail(ErrorCode::kConflict, "Hover requires a visible live WebView");
  if (hover && !held_pointers_.empty()) {
    const auto* model = owner_.model_->FindWebView(owner_.session_, owner_.view_);
    if (!model || !model->focused)
      return Fail(ErrorCode::kConflict, "Mouse drag requires focus");
  }
  if (const auto* mouse = std::get_if<MouseInput>(&input.payload);
      mouse && mouse->pen && mouse->action == MouseInput::Action::down &&
      held_pointers_.size() >= 16 && !held_pointers_.contains(mouse->pen->id))
    return Fail(ErrorCode::kLimitExceeded, "Too many active pointers");
  const bool routed = std::holds_alternative<MouseInput>(input.payload) ||
                      std::holds_alternative<WheelInput>(input.payload) ||
                      std::holds_alternative<TouchInput>(input.payload) ||
                      std::holds_alternative<GestureInput>(input.payload);
  auto* router = root->GetInputEventRouter();
  if (routed && !router)
    return Fail(ErrorCode::kUnavailable, "Input routing unavailable");
  auto* wheel_phase_handler =
      std::holds_alternative<WheelInput>(input.payload)
          ? static_cast<content::RenderWidgetHostViewAura*>(root_view)->GetMouseWheelPhaseHandler()
          : nullptr;
  if (std::holds_alternative<WheelInput>(input.payload) && !wheel_phase_handler)
    return Fail(ErrorCode::kUnavailable, "Mouse wheel phase handling unavailable");
  if (const auto status = owner_.touch_->PrepareInput(input))
    return *status;
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
    return Fail(ErrorCode::kInvalidRequest, "Input exceeds Blink representation");
  if (input.editable_target && routed)
    return Fail(ErrorCode::kInvalidRequest, "Editable target requires keyboard or IME input");
  std::uint64_t actual_editable_target = 0;
  if (!routed && UpdateEditableTarget(text_input_observation_.GetSource()))
    actual_editable_target = last_editable_target_id_;
  if (input.editable_target && input.editable_target != actual_editable_target)
    return Fail(ErrorCode::kConflict, "Editable input target changed");
  auto accepted = owner_.model_->AcceptInput(owner_.session_, input);
  if (!accepted)
    return accepted;
  if (admitted)
    *admitted = true;
  if (routed)
    RememberPointerTarget();
  else {
    PrepareKeyboardTarget(host);
    keyboard_editable_target_id_ = actual_editable_target;
  }
  if (const auto* command = std::get_if<SelectionCommand>(&input.payload))
    return RemoteTouchSelectionMenuRunner::Get().Execute(owner_.session_, owner_.view_, *command);
  if (const auto* extent = std::get_if<SelectionExtent>(&input.payload))
    return DragSelectionHandle(root_view, *extent);
  if (const auto* command = std::get_if<ContextCommand>(&input.payload))
    return RemoteContextMenu::Get().Execute(owner_.session_, owner_.view_, *command);
  if (const auto* touch = std::get_if<TouchInput>(&input.payload)) {
    if (touch->action == TouchInput::Action::start)
      RemoteContextMenu::Get().CloseFor(owner_.contents());
    return owner_.touch_->DispatchTouches(*touch, input.token);
  }
  if (const auto* gesture = std::get_if<GestureInput>(&input.payload))
    return owner_.touch_->Momentum(*gesture);
  std::visit(
      [&](const auto& value) {
        using T = std::decay_t<decltype(value)>;
        const auto now = base::TimeTicks::Now();
        if constexpr (std::is_same_v<T, KeyInput>) {
          if (value.action == KeyInput::Action::down)
            HideTouchSelection(root_view);
          int modifiers = static_cast<int>(value.modifiers) | KeyLocationModifiers(value);
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
          if (value.action == MouseInput::Action::down) {
            RemoteContextMenu::Get().CloseFor(owner_.contents());
            HideTouchSelection(root_view);
          }
          Type type = value.action == MouseInput::Action::move    ? Type::kMouseMove
                      : value.action == MouseInput::Action::down  ? Type::kMouseDown
                      : value.action == MouseInput::Action::leave ? Type::kMouseLeave
                                                                  : Type::kMouseUp;
          blink::WebMouseEvent event(type, static_cast<int>(value.modifiers), now);
          SetPenProperties(event, value.pen);
          event.SetPositionInWidget(static_cast<float>(value.x), static_cast<float>(value.y));
          event.SetPositionInScreen(ViewportToScreen(root_view, event.PositionInWidget()));
          event.button = value.action == MouseInput::Action::move ? MouseMoveButton(value.modifiers)
                                                                  : Button(value.button);
          event.click_count = (value.action == MouseInput::Action::move ||
                               value.action == MouseInput::Action::leave)
                                  ? 0
                                  : value.click_count;
          const auto pointer = value.pen ? std::optional(value.pen->id) : std::nullopt;
          if (value.button && value.action == MouseInput::Action::down)
            held_pointers_[pointer].buttons.insert(value.button);
          auto held = held_pointers_.find(pointer);
          if (held != held_pointers_.end()) {
            held->second.last_event = value;
            if (value.action == MouseInput::Action::up) {
              held->second.buttons.erase(value.button);
              if (held->second.buttons.empty())
                held_pointers_.erase(held);
            }
          }
          router->RouteMouseEvent(root_view, &event, ui::LatencyInfo());
        } else if constexpr (std::is_same_v<T, WheelInput>) {
          RemoteContextMenu::Get().CloseFor(owner_.contents());
          HideTouchSelection(root_view);
          // Match Aura's OnMouseWheelEvent: zero deltas do not begin a sequence.
          if (value.delta_x == 0 && value.delta_y == 0)
            return;
          blink::WebMouseWheelEvent event(Type::kMouseWheel, static_cast<int>(value.modifiers),
                                          now);
          event.SetPositionInWidget(static_cast<float>(value.x), static_cast<float>(value.y));
          event.SetPositionInScreen(ViewportToScreen(root_view, event.PositionInWidget()));
          event.delta_x = static_cast<float>(value.delta_x);
          event.delta_y = static_cast<float>(value.delta_y);
          event.delta_units = ui::ScrollGranularity::kScrollByPixel;
          event.event_action =
              blink::WebMouseWheelEvent::GetPlatformSpecificDefaultEventAction(event);
          // The router hit-tests only begin phases. Reuse Aura's existing
          // latching and synthetic end timer before routing, as native input does.
          wheel_phase_handler->SendWheelEndForTouchpadScrollingIfNeeded(true);
          wheel_phase_handler->AddPhaseIfNeededAndScheduleEndEvent(
              event, /*should_route_event=*/true, /*is_fling_capable=*/false);
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
void InputController::ReadyToCommitNavigation(content::NavigationHandle* navigation) {
  if (navigation->IsSameDocument())
    return;
  if (!owner_.execution_->IsInPrimaryPage(navigation))
    return;
  // Catch keys pressed after DidStartNavigation but before the commit boundary.
  // Refuse further remote input until DidFinishNavigation: the browser's old
  // token must not enqueue input into a renderer already committing a new doc.
  input_commit_navigations_.insert(navigation->GetNavigationId());
  if (input_frame_ && NavigationAffectsFrame(navigation, input_frame_.get()))
    ReleaseKeyboard(false, true);
  ReleasePointer(true);
}
void InputController::DidStartNavigation(content::NavigationHandle* navigation,
                                         bool in_primary_page) {
  if (!navigation->IsSameDocument()) {
    auto* focused = owner_.contents() ? owner_.contents()->GetFocusedFrame() : nullptr;
    if (focused && NavigationAffectsFrame(navigation, focused))
      PrepareKeyboardTarget(FocusedWidget());
    if (input_frame_ && NavigationAffectsFrame(navigation, input_frame_.get()))
      ReleaseKeyboard(false, true);
    // Pointer targets are selected/latched by InputEventRouter (including
    // OOPIFs). End the sequence while the OLD frame tree is still current.
    if (in_primary_page)
      ReleasePointer(true);
  }
}
void InputController::DidFinishNavigation(content::NavigationHandle* navigation,
                                          bool discard_document) {
  input_commit_navigations_.erase(navigation->GetNavigationId());
  if (input_frame_ && !KeyboardTargetAlive())
    ReleaseKeyboard(false, false);
  if (!navigation->IsInPrimaryMainFrame() || discard_document)
    return;
  const bool committed = navigation->HasCommitted() && !navigation->IsSameDocument();
  if (committed) {
    // A same-RFH navigation may already expose its NEW document here. Never
    // dispatch cleanup events from DidFinishNavigation to that new document.
    ReleaseKeyboard(false, false);
    ReleasePointer(false);
  }
}
void InputController::PrimaryMainFrameRenderProcessGone() {
  input_commit_navigations_.clear();
  ReleaseKeyboard(false, false);
  ReleasePointer(false);
}
}  // namespace remotekit::browser
