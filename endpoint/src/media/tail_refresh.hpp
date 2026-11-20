#pragma once
#include "media/idle_idr.hpp"
#include "remotekit_rtc.h"
#include <memory>

namespace remotekit {
// Endpoint-local tag carried through the existing SDK lease callbacks. Every
// reference forwards the original pool cookie; the SDK ABI and GPU lifetime
// boundary stay unchanged. A dropped tag cannot turn into source activity.
class TailRefreshLease {
 public:
  static remotekit_rtc_frame Wrap(const remotekit_rtc_frame& source,
                                  std::shared_ptr<TailIdrAttempt> attempt,
                                  bool require_keyframe = true) {
    auto* lease = new TailRefreshLease(source, std::move(attempt), require_keyframe);
    source.retain(source.release_context, source.frame_id);
    auto tagged = source;
    tagged.release_context = lease;
    tagged.retain = Retain;
    tagged.release = Release;
    return tagged;
  }
  static TailRefreshLease* From(const remotekit_rtc_frame& frame) {
    return frame.release == Release ? static_cast<TailRefreshLease*>(frame.release_context)
                                    : nullptr;
  }
  const remotekit_rtc_frame& Source() const { return source_; }
  static bool BeginEncoding(const remotekit_rtc_frame& frame) {
    auto* lease = From(frame);
    return !lease || lease->attempt_->BeginEncoding();
  }
  static bool RequiresKeyframe(const remotekit_rtc_frame& frame) {
    const auto* lease = From(frame);
    return lease && lease->require_keyframe_;
  }
  static void Finish(const remotekit_rtc_frame& frame, bool delivered, bool keyframe = true) {
    if (auto* lease = From(frame))
      lease->attempt_->Finish(delivered && (!lease->require_keyframe_ || keyframe));
  }

 private:
  TailRefreshLease(const remotekit_rtc_frame& source,
                   std::shared_ptr<TailIdrAttempt> attempt,
                   bool require_keyframe)
      : source_(source), attempt_(std::move(attempt)), require_keyframe_(require_keyframe) {}
  static void Retain(void* context, uint64_t) {
    auto* lease = static_cast<TailRefreshLease*>(context);
    lease->refs_.fetch_add(1);
    lease->source_.retain(lease->source_.release_context, lease->source_.frame_id);
  }
  static void Release(void* context, uint64_t) {
    auto* lease = static_cast<TailRefreshLease*>(context);
    lease->source_.release(lease->source_.release_context, lease->source_.frame_id);
    if (lease->refs_.fetch_sub(1) == 1) {
      lease->attempt_->Finish(false);
      delete lease;
    }
  }
  remotekit_rtc_frame source_;
  std::shared_ptr<TailIdrAttempt> attempt_;
  bool require_keyframe_;
  std::atomic<uint32_t> refs_{1};
};
}  // namespace remotekit
