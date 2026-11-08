#ifndef REMOTEKIT_BROWSER_CLIENT_GESTURE_PACKET_H_
#define REMOTEKIT_BROWSER_CLIENT_GESTURE_PACKET_H_
#include "base/functional/callback.h"
#include "remotekit/browser/view_model.h"
#include "ui/events/gesture_detection/gesture_event_data_packet.h"
#include "ui/events/velocity_tracker/motion_event.h"
namespace remotekit::browser {
// Pure production helper, shared by the bridge and the CPU probe.
ui::GestureEventDataPacket MakeClientGesturePacket(const ui::MotionEvent&,
                                                   const std::vector<TouchInput::Gesture>&,
                                                   uint32_t first_id);
// A rejected fling still completes the physical terminal ACK. Keep teardown
// and the completion in one operation so teardown cannot return past it.
void CompleteClientTouchAck(bool terminal,
                            bool fling_pending,
                            bool momentum,
                            base::OnceClosure end_momentum,
                            base::OnceClosure processed);
class ClientGestureCandidateState {
 public:
  bool Accept(const std::vector<TouchInput::Gesture>&,
              bool first_raw,
              bool last_up,
              size_t raw_pointer_count = 1);
  bool LongPress();
  bool moved() const { return moved_; }

 private:
  bool tap_{}, scroll_{}, pinch_{}, moved_{}, long_press_{};
};
}  // namespace remotekit::browser
#endif
