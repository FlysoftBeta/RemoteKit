#include "protocol/render_slots.h"
#include "browser/osr_wake_state.h"
namespace {
constexpr bool StopLifecycle() {
  remotekit::RenderGenerationState state;
  if (state.RecordStopped(9) || state.RecordStop(0))
    return false;
  if (!state.RecordBegin(9) || state.CanBegin(10) || state.CanStop(10))
    return false;
  if (!state.RecordStop(9) || !state.CanStop(9) || state.RecordStop(9))
    return false;
  if (!state.stopping() || state.CanBegin(9) || state.RecordBegin(9))
    return false;
  if (state.RecordStopped(10) || !state.RecordStopped(9))
    return false;
  return state.phase() == remotekit::RenderGenerationState::Phase::kStopped && state.stopped() &&
         !state.RecordStopped(9) && !state.CanStop(10);
}
constexpr bool EmptyGenerationStop() {
  remotekit::RenderGenerationState state;
  return state.RecordStop(42) && !state.CanBegin(42) && state.RecordStopped(42);
}
constexpr bool ControlPayloadBounds() {
  remotekit::RenderWireMessage message;
  message.type = remotekit::RenderWireType::kStop;
  if (remotekit::ValidRenderGenerationControl(message))
    return false;
  message.begin.identity.generation = 9;
  if (!remotekit::ValidRenderGenerationControl(message))
    return false;
  message.type = remotekit::RenderWireType::kStopped;
  if (!remotekit::ValidRenderGenerationControl(message))
    return false;
  message.begin.identity.value = 1;
  if (remotekit::ValidRenderGenerationControl(message))
    return false;
  message.begin.identity.value = 0;
  message.begin.identity.slot = 1;
  if (remotekit::ValidRenderGenerationControl(message))
    return false;
  message.begin.identity.slot = 0;
  message.begin.interval_us = 16667;
  return !remotekit::ValidRenderGenerationControl(message);
}
constexpr bool WakeLifecycle() {
  remotekit::RenderWakeState wake;
  remotekit::RenderIdentity idle{7, 11, 2, 0};
  if (wake.Observe(idle) != remotekit::RenderWakeResult::kInvalid)
    return false;
  wake.RecordIdle(idle);
  auto wrong = idle;
  ++wrong.generation;
  if (wake.Observe(wrong) != remotekit::RenderWakeResult::kInvalid)
    return false;
  wrong = idle;
  ++wrong.value;
  if (wake.Observe(wrong) != remotekit::RenderWakeResult::kInvalid)
    return false;
  wrong = idle;
  ++wrong.slot;
  if (wake.Observe(wrong) != remotekit::RenderWakeResult::kInvalid)
    return false;
  if (wake.Observe(idle) != remotekit::RenderWakeResult::kFirst ||
      wake.Observe(idle) != remotekit::RenderWakeResult::kDuplicate)
    return false;
  auto newer = idle;
  ++newer.value;
  wake.RecordIdle(newer);
  if (wake.Observe(idle) != remotekit::RenderWakeResult::kInvalid)
    return false;
  return wake.Observe(newer) == remotekit::RenderWakeResult::kFirst;
}
constexpr bool WakePayloadBounds() {
  remotekit::RenderWireMessage message;
  message.type = remotekit::RenderWireType::kWake;
  message.begin.identity = {7, 11, 2, 0};
  if (!remotekit::ValidRenderWake(message))
    return false;
  message.reason = 1;
  if (remotekit::ValidRenderWake(message))
    return false;
  message.reason = 0;
  message.begin.force = 1;
  return !remotekit::ValidRenderWake(message);
}
constexpr bool LateBeginPreservesWakeProof() {
  remotekit::browser::OsrWakeProof proof;
  const remotekit::RenderIdentity idle{7, 11, 2, 0};
  proof.RecordIdle(idle);
  proof.RequestRebindWake();
  // B2 was sent before Comp received B1's Idle Reject. Its later arrival at
  // Rend cannot prove that Comp received a Wake or resumed regular demand.
  if (!proof.pending() || proof.pending()->value != idle.value || !proof.rebind_requested())
    return false;
  if (!proof.pending() || !proof.rebind_requested())
    return false;
  if (proof.Delivered({7, 12, 3, 0}) || !proof.pending())
    return false;
  if (!proof.Delivered(idle) || proof.pending() || proof.rebind_requested() ||
      proof.Delivered(idle))
    return false;
  proof.RecordIdle({7, 14, 1, 0});
  if (proof.Delivered(idle) || !proof.pending())
    return false;
  proof.Stop();
  proof.RecordIdle({7, 15, 2, 0});
  proof.RequestRebindWake();
  return !proof.pending() && !proof.rebind_requested();
}
static_assert(LateBeginPreservesWakeProof());
static_assert(WakeLifecycle());
static_assert(WakePayloadBounds());
static_assert(StopLifecycle());
static_assert(EmptyGenerationStop());
static_assert(ControlPayloadBounds());
}  // namespace
