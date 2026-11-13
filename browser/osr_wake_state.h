#pragma once
#include "protocol/render_slots.h"
namespace remotekit::browser {
// Local admission proof, independent of GPU completion/slot ownership. Begin
// may have been sent before Comp observed an Idle Reject, so neither a normal
// nor forced Begin acknowledges that Comp resumed demand.
class OsrWakeProof {
 public:
  constexpr void RecordIdle(const RenderIdentity& identity) {
    if (!stopped_)
      idle_ = identity;
  }
  constexpr const RenderIdentity* pending() const {
    return ValidRenderIdentity(idle_) ? &idle_ : nullptr;
  }
  constexpr void RequestRebindWake() { rebind_ |= pending() != nullptr; }
  constexpr bool rebind_requested() const { return rebind_; }
  constexpr bool Delivered(const RenderIdentity& identity) {
    if (!pending() || identity.generation != idle_.generation || identity.value != idle_.value ||
        identity.slot != idle_.slot || identity.reserved != idle_.reserved)
      return false;
    idle_ = {};
    rebind_ = false;
    return true;
  }
  constexpr void Stop() {
    stopped_ = true;
    idle_ = {};
    rebind_ = false;
  }

 private:
  RenderIdentity idle_;
  bool rebind_ = false, stopped_ = false;
};
}  // namespace remotekit::browser
