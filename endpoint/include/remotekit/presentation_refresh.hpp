#pragma once
#include "remotekit/idle_idr.hpp"
#include "remotekit/presentation_barrier.hpp"
#include <algorithm>
#include <memory>
#include <optional>

namespace remotekit {
// Comp owns the request. Only its tagged SDK frame can complete it.
class PresentationRefresh {
 public:
  struct Scope {
    uint64_t peer, authorization;
    PresentationBarrier::Key layout;
    bool operator==(const Scope&) const = default;
  };
  struct Stats {
    bool pending = false;
    uint64_t attempts = 0, forced_begins = 0, successes = 0;
  };

  ~PresentationRefresh() { SetScope(std::nullopt); }

  void SetScope(std::optional<Scope> scope) {
    if (scope_ == scope) return;
    if (attempt_) attempt_->CancelWaiting();
    attempt_.reset();
    scope_ = scope;
    pending_ = scope_.has_value();
    next_attempt_ms_ = 0;
  }

  void Update(bool requested, double now_ms) {
    if (!scope_) return;
    if (attempt_) {
      if (now_ms >= source_deadline_ms_) attempt_->CancelWaiting();
      using State = TailIdrAttempt::State;
      const auto state = attempt_->state();
      if (state != State::source_wait && state != State::encoding) {
        attempt_.reset();
        if (state == State::succeeded) {
          pending_ = false;
          ++successes_;
        }
      }
    }
    // An in-flight request absorbs duplicates. A consumer that requests a
    // refresh after publication still needs its own frame.
    pending_ |= requested;
  }

  bool CanForce(double now_ms) const {
    return Due(now_ms) && now_ms >= next_force_ms_;
  }

  void Forced(double now_ms) {
    next_force_ms_ = now_ms + kRetryMs;
    ++forced_begins_;
  }

  bool Pending() const { return pending_; }
  Stats Snapshot() const { return {pending_, attempts_, forced_begins_, successes_}; }

  std::shared_ptr<TailIdrAttempt> TryStart(double now_ms, double interval_ms) {
    if (!Due(now_ms)) return {};
    next_attempt_ms_ = now_ms + kRetryMs;
    source_deadline_ms_ = now_ms + std::max(kRetryMs, 2 * interval_ms);
    attempt_ = std::make_shared<TailIdrAttempt>();
    ++attempts_;
    return attempt_;
  }

 private:
  static constexpr double kRetryMs = 1000;

  bool Due(double now_ms) const {
    return pending_ && !attempt_ && now_ms >= next_attempt_ms_;
  }

  std::optional<Scope> scope_;
  std::shared_ptr<TailIdrAttempt> attempt_;
  bool pending_ = false;
  uint64_t attempts_ = 0, forced_begins_ = 0, successes_ = 0;
  double next_attempt_ms_ = 0;
  double next_force_ms_ = 0;
  double source_deadline_ms_ = 0;
};
} // namespace remotekit
