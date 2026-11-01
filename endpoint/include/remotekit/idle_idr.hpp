#pragma once
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
namespace remotekit {
// A single asynchronous tail attempt. Only the source-wait phase may time out;
// once claimed by EncoderWorker, its actual completion/drop decides the result.
class TailIdrAttempt {
 public:
  enum class State {source_wait,encoding,succeeded,failed,canceled};
  State state() const {return state_.load();}
  bool BeginEncoding() {
    auto before=State::source_wait;return state_.compare_exchange_strong(before,State::encoding);
  }
  bool CancelWaiting() {
    auto before=State::source_wait;return state_.compare_exchange_strong(before,State::canceled);
  }
  void Finish(bool keyframe_delivered) {
    auto before=State::encoding;
    if(state_.compare_exchange_strong(before,keyframe_delivered?State::succeeded:State::failed))return;
    // SDK rejection/source release can finish an attempt before Encode.
    if(!keyframe_delivered) {
      before=State::source_wait;state_.compare_exchange_strong(before,State::failed);
    }
  }
 private:
  std::atomic<State> state_{State::source_wait};
};
// A tail refresh must not mistake a slow animation's normal spacing for idle.
class IdleIdrPolicy {
 public:
  explicit IdleIdrPolicy(uint32_t minimum_ms):minimum_ms_(minimum_ms) {}
  bool Observe(uint64_t generation,uint64_t frame,int64_t capture_us,double arrival_ms) {
    if(generation!=generation_) {generation_=generation;have_source_=false;mean_ms_=0;}
    const bool fresh=!have_source_ || (capture_us>0 ? capture_us!=capture_us_ : frame!=frame_);
    if(!fresh)return false;
    if(have_source_) {
      const double interval=arrival_ms-last_arrival_ms_;
      if(interval<=0 || interval>2000)mean_ms_=0;
      else mean_ms_=mean_ms_>0 ? mean_ms_*.8+interval*.2 : interval;
    }
    have_source_=true;tail_sent_=false;capture_us_=capture_us;frame_=frame;last_arrival_ms_=arrival_ms;
    return true;
  }
  uint32_t delay_ms() const {
    return minimum_ms_ ? static_cast<uint32_t>(std::ceil(std::min(1000.0,std::max(double(minimum_ms_),mean_ms_*3)))) : 0;
  }
  double interval_ms() const {return mean_ms_;}
  double age_ms(double now_ms) const {return now_ms-last_arrival_ms_;}
  bool TailDue(double now_ms) const {
    return have_source_ && !tail_sent_ && delay_ms() && age_ms(now_ms)>=delay_ms();
  }
  // Only a confirmed encoded keyframe at/after the deadline consumes the tail.
  // Independent recovery refreshes before the deadline do not suppress it.
  bool CompleteRefresh(double now_ms,bool accepted) {
    if(!accepted || !TailDue(now_ms))return false;
    tail_sent_=true;return true;
  }
 private:
  uint32_t minimum_ms_;
  uint64_t generation_=0,frame_=0;
  int64_t capture_us_=0;
  bool have_source_=false,tail_sent_=false;
  double mean_ms_=0,last_arrival_ms_=0;
};
} // namespace remotekit
