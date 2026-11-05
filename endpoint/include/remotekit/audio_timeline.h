#pragma once
#include <cstdint>
namespace remotekit {
enum class AudioStep {
  reject,
  start,
  continuous,
  pad,
  restart_gap,
  restart_epoch,
  restart_discontinuity
};
struct AudioAdvance {
  AudioStep step = AudioStep::reject;
  uint32_t silence_blocks = 0;
};
// Fixed 48kHz/480-frame source clock. Planning does not mutate state, so a
// failed sender restart cannot consume a source epoch or sample position.
class AudioTimeline {
 public:
  AudioAdvance Plan(uint64_t generation,
                    uint64_t sequence,
                    uint64_t sample,
                    int64_t qpc,
                    bool discontinuity) const {
    if (!generation || !sequence || sample % 480 || qpc <= 0)
      return {};
    if (!generation_)
      return {AudioStep::start, 0};
    if (qpc <= qpc_)
      return {};
    if (generation != generation_)
      return {generation > generation_ ? AudioStep::restart_epoch : AudioStep::reject, 0};
    if (sequence <= sequence_ || sample <= sample_)
      return {};
    const auto missing = (sample - sample_) / 480 - 1;
    if (missing > 8)
      return {AudioStep::restart_gap, 0};
    if (missing)
      return {AudioStep::pad, static_cast<uint32_t>(missing)};
    return {discontinuity ? AudioStep::restart_discontinuity : AudioStep::continuous, 0};
  }
  void Commit(uint64_t generation, uint64_t sequence, uint64_t sample, int64_t qpc) {
    generation_ = generation;
    sequence_ = sequence;
    sample_ = sample;
    qpc_ = qpc;
  }

 private:
  uint64_t generation_ = 0, sequence_ = 0, sample_ = 0;
  int64_t qpc_ = 0;
};
}  // namespace remotekit
