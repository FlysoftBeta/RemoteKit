#pragma once
#include <cstdint>
#include <type_traits>
namespace remotekit {
struct RenderIdentity {
  std::uint64_t generation = 0;
  std::uint64_t value = 0;
  std::uint32_t slot = 0;
  std::uint32_t reserved = 0;
};
struct RenderBegin {
  RenderIdentity identity;
  std::uint32_t interval_us = 0;
  std::uint32_t force = 0;
};
enum class RenderRejectReason : std::uint32_t {
  kIdle = 1, kNotReady = 2, kStaleGeneration = 3, kStopped = 4,
};
// Fixed-size raw Mojo messages, no attached handles or pointers.
inline constexpr std::uint32_t kRenderWireMagic = 0x524B5243;
inline constexpr std::uint32_t kRenderWireVersion = 1;
enum class RenderWireType : std::uint32_t { kBegin = 1, kReject = 2, kStop = 3, kStopped = 4, kWake = 5 };
struct RenderWireMessage {
  std::uint32_t magic = kRenderWireMagic;
  std::uint32_t version = kRenderWireVersion;
  RenderWireType type = RenderWireType::kBegin;
  std::uint32_t reason = 0;
  RenderBegin begin;
};
inline constexpr bool ValidRenderIdentity(const RenderIdentity& identity) {
  return identity.generation && identity.value && identity.value != UINT64_MAX &&
         identity.slot < 4 && !identity.reserved;
}
inline constexpr bool ValidRenderBegin(const RenderBegin& begin) {
  return ValidRenderIdentity(begin.identity) && begin.interval_us &&
         begin.force <= 1;
}
// Generation controls carry no frame identity or timing payload.
inline constexpr bool ValidRenderGenerationControl(const RenderWireMessage& message) {
  return message.magic == kRenderWireMagic && message.version == kRenderWireVersion &&
         (message.type == RenderWireType::kStop || message.type == RenderWireType::kStopped) &&
         !message.reason && message.begin.identity.generation && !message.begin.identity.value &&
         !message.begin.identity.slot && !message.begin.identity.reserved &&
         !message.begin.interval_us && !message.begin.force;
}
inline constexpr bool ValidRenderWake(const RenderWireMessage& message) {
  return message.magic == kRenderWireMagic && message.version == kRenderWireVersion &&
         message.type == RenderWireType::kWake && !message.reason &&
         ValidRenderIdentity(message.begin.identity) && !message.begin.interval_us &&
         !message.begin.force;
}
enum class RenderWakeResult { kInvalid, kFirst, kDuplicate };
// A Wake references the latest Idle Reject, never a successful frame. It grants
// no completion/slot-reuse permission and does not mutate Begin bookkeeping.
class RenderWakeState {
 public:
  constexpr void RecordIdle(const RenderIdentity& identity) {
    idle_ = identity;
    delivered_ = false;
  }
  constexpr RenderWakeResult Observe(const RenderIdentity& identity) {
    if (!ValidRenderIdentity(identity) || identity.generation != idle_.generation ||
        identity.value != idle_.value || identity.slot != idle_.slot)
      return RenderWakeResult::kInvalid;
    if (delivered_) return RenderWakeResult::kDuplicate;
    delivered_ = true;
    return RenderWakeResult::kFirst;
  }
 private:
  RenderIdentity idle_;
  bool delivered_ = false;
};
// Local lifecycle bookkeeping, used under the SDK lock / Browser UI sequence.
// This state never represents GPU completion or texture reuse permission.
class RenderGenerationState {
 public:
  constexpr bool CanBegin(uint64_t generation) const {
    return generation && !stopping_ && (!generation_ || generation_ == generation);
  }
  constexpr bool RecordBegin(uint64_t generation) {
    if (!CanBegin(generation)) return false;
    generation_ = generation;
    return true;
  }
  constexpr bool CanStop(uint64_t generation) const {
    return generation && (!generation_ || generation_ == generation);
  }
  constexpr bool RecordStop(uint64_t generation) {
    if (!CanStop(generation) || stopping_) return false;
    generation_ = generation;
    stopping_ = true;
    return true;
  }
  constexpr bool RecordStopped(uint64_t generation) {
    if (!stopping_ || stopped_ || generation != generation_) return false;
    stopped_ = true;
    return true;
  }
  constexpr bool stopping() const { return stopping_; }
  constexpr bool stopped() const { return stopped_; }
 private:
  uint64_t generation_ = 0;
  bool stopping_ = false;
  bool stopped_ = false;
};
static_assert(sizeof(RenderIdentity) == 24);
static_assert(sizeof(RenderBegin) == 32);
static_assert(sizeof(RenderWireMessage) == 48);
static_assert(std::is_trivially_copyable_v<RenderWireMessage>);
} // namespace remotekit
