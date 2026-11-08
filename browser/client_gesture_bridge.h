#ifndef REMOTEKIT_BROWSER_CLIENT_GESTURE_BRIDGE_H_
#define REMOTEKIT_BROWSER_CLIENT_GESTURE_BRIDGE_H_

#include <optional>
#include <set>
#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/timer/timer.h"
#include "components/input/render_widget_host_input_event_router.h"
#include "remotekit/browser/view_model.h"
#include "browser/client_gesture_packet.h"
#include "browser/client_input_timing.h"
#include "third_party/blink/public/common/input/web_gesture_event.h"
#include "third_party/blink/public/common/input/web_touch_event.h"
#include "ui/events/gesture_detection/touch_disposition_gesture_filter.h"

namespace remotekit::browser {
enum class ClientTouchAckState { canonical, target_mismatch, timeout };
// UI sequence only. Owns arbitration, never recognition or a fling curve.
class ClientGestureBridge final : public ui::TouchDispositionGestureFilterClient,
                                  public base::RefCounted<ClientGestureBridge> {
 public:
  ClientGestureBridge(input::RenderWidgetHostInputEventRouter*,
                      input::RenderWidgetHostViewInput* root,
                      input::RenderWidgetHostViewInput* target,
                      std::string sequence,
                      base::TimeTicks origin,
                      base::RepeatingCallback<void(ClientTouchAckState, bool, bool)> processed);
  Status Dispatch(blink::WebTouchEvent event,
                  const std::vector<TouchInput::Gesture>&,
                  int64_t source_elapsed_us);
  base::TimeTicks NativeTimestamp(base::TimeTicks sampled);
  Status Momentum(const GestureInput&);
  bool has_routed_raw() const { return first_id_ != 0; }
  bool has_routed_terminal() const { return terminal_routed_; }
  bool awaiting_ack() const { return !pending_.empty(); }
  size_t pending_ack_count() const { return pending_.size(); }
  void StopMomentum();
  Status LongPress(const GestureInput&);
  void Cancel(bool deliver);
  void ForwardGestureEvent(const ui::GestureEventData&) override;

 private:
  friend class base::RefCounted<ClientGestureBridge>;
  ~ClientGestureBridge();
  void Ack(const blink::WebTouchEvent&,
           blink::mojom::InputEventResultState,
           input::RenderWidgetHostViewInput*);
  bool Route(blink::WebGestureEvent);
  void EndMomentum();
  void Timeout();
  base::WeakPtr<input::RenderWidgetHostInputEventRouter> router_;
  base::WeakPtr<input::RenderWidgetHostViewInput> root_, target_;
  const std::string sequence_;
  const base::TimeTicks origin_;
  base::RepeatingCallback<void(ClientTouchAckState, bool, bool)> processed_;
  ui::TouchDispositionGestureFilter filter_{this};
  ClientGestureCandidateState candidate_state_;
  std::set<uint32_t> pending_;
  uint32_t first_id_{};
  bool stopped_{}, bound_{}, scroll_{}, momentum_{}, fling_pending_{}, terminal_routed_{};
  bool momentum_allowed_{true};
  bool selection_owned_{}, selection_touch_down_{};
  size_t contact_count_{};
  int primary_pointer_id_{};
  std::optional<blink::WebTouchEvent> selection_touch_;
  std::optional<GestureInput> buffered_;
  double cumulative_x_{}, cumulative_y_{};
  ClientNativeInputClock<base::TimeTicks> native_clock_;
  ClientGestureSourceTime source_time_;
  base::TimeTicks momentum_deadline_;
  std::optional<blink::WebGestureEvent> last_gesture_;
  base::OneShotTimer timeout_;
  base::WeakPtrFactory<ClientGestureBridge> weak_factory_{this};
};
}  // namespace remotekit::browser
#endif
