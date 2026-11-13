#pragma once
#include "browser/webview.h"
#include "content/public/browser/focused_node_details.h"

namespace remotekit::browser {
class InputController {
 public:
  using Completion = WebView::Completion;
  explicit InputController(WebView& owner);
  ~InputController();
  void InvalidateLayoutInput(bool remains_visible);
  content::RenderWidgetHostImpl* FocusedWidget() const;
  bool KeyboardTargetAlive() const;
  bool PointerTargetAlive() const;
  void ReleaseKeyboard(bool finish_composition, bool deliver);
  void ReleaseHeldKeys(bool deliver);
  void PrepareKeyboardTarget(content::RenderWidgetHostImpl* widget);
  void RememberPointerTarget();
  void ReleasePointer(bool deliver);
  const ui::mojom::TextInputState* UpdateEditableTarget(content::TextInputManager* manager);
  void OnUpdateTextInputStateCalled(content::TextInputManager* manager,
                                    content::RenderWidgetHostViewBase*,
                                    bool);
  SharedAtlasTextInput TextInputState();
  Status CanFocus(bool focused) const;
  Status Focus(bool focused);
  void RenderFrameDeleted(content::RenderFrameHost* frame);
  void RenderFrameHostChanged(content::RenderFrameHost* old_frame,
                              content::RenderFrameHost* new_frame);
  Status DispatchInput(const InputEvent& input, bool* admitted);
  void DidStartNavigation(content::NavigationHandle*, bool in_primary_page);
  void DidFinishNavigation(content::NavigationHandle*, bool discard_document);
  void PrimaryMainFrameRenderProcessGone();
  void ReadyToCommitNavigation(content::NavigationHandle* navigation);
  void OnFocusChangedInPage(const content::FocusedNodeDetails& details);

 private:
  friend class WebView;
  friend class WebViewExecution;
  friend class DeviceConfiguration;
  friend class NavigationCoordinator;
  friend class TouchController;
  friend class LifecycleCoordinator;
  WebView& owner_;
  class FocusObserver final : public content::WebContentsObserver {
   public:
    explicit FocusObserver(InputController& input) : input_(input) {}
    void Attach(content::WebContents* contents) { Observe(contents); }

   private:
    void OnFocusChangedInPage(const content::FocusedNodeDetails& details) override {
      input_.OnFocusChangedInPage(details);
    }
    InputController& input_;
  };
  FocusObserver focus_observer_{*this};
  base::WeakPtr<content::RenderWidgetHostImpl> input_widget_;
  base::WeakPtr<content::RenderFrameHostImpl> input_frame_;
  std::optional<blink::DocumentToken> input_document_;
  struct EditableTarget {
    base::WeakPtr<content::RenderWidgetHostImpl> widget;
    base::WeakPtr<content::RenderFrameHostImpl> frame;
    blink::DocumentToken document;
    std::int32_t node_id;
  };
  std::optional<EditableTarget> editable_target_;
  std::uint64_t last_editable_target_id_{};
  std::uint64_t keyboard_editable_target_id_{};
  content::WeakDocumentPtr focused_document_;
  std::int32_t focused_node_id_{};
  std::uint32_t focus_source_{};
  std::uint64_t focus_observation_{};
  base::ScopedObservation<content::TextInputManager, content::TextInputManager::Observer>
      text_input_observation_{&owner_};
  std::map<std::uint32_t, KeyInput> pressed_keys_;
  base::WeakPtr<content::RenderWidgetHostImpl> pointer_root_widget_;
  base::WeakPtr<content::RenderWidgetHostViewBase> pointer_root_view_;
  base::WeakPtr<content::RenderFrameHostImpl> pointer_frame_;
  std::optional<blink::DocumentToken> pointer_document_;
  struct HeldPointer {
    MouseInput last_event;
    std::set<std::uint8_t> buttons;
  };
  std::map<std::optional<std::uint32_t>, HeldPointer> held_pointers_;
  std::set<std::int64_t> input_commit_navigations_;
};
}  // namespace remotekit::browser
