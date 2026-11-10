#pragma once

#include <cstdint>

namespace remotekit {
class CompRecoverySampling {
 public:
  enum class State { kContent, kSampling, kRestoring };

  void Update(bool balanced, uint64_t native_pixels, uint32_t target_pixels) {
    if (!balanced || !native_pixels) {
      state_ = State::kContent;
    } else if (target_pixels && target_pixels < native_pixels) {
      state_ = State::kSampling;
    } else if (state_ == State::kSampling) {
      // Admit one frame at the lifted restriction before returning to Idle.
      state_ = State::kRestoring;
    }
  }

  void Submitted() {
    if (state_ == State::kRestoring)
      state_ = State::kContent;
  }

  bool active() const { return state_ != State::kContent; }
  State state() const { return state_; }

 private:
  State state_ = State::kContent;
};
}  // namespace remotekit
