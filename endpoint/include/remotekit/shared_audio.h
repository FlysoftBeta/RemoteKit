#pragma once
#include <windows.h>
#include <cstdint>
#include <cstddef>
#include <cstring>

namespace remotekit {
inline constexpr uint32_t kAudioMagic = 0x524b4131;
inline constexpr uint32_t kAudioSlots = 8, kAudioFrames = 480, kAudioChannels = 2;
struct AudioPacket {
  uint64_t sequence, sample_index;
  int64_t first_sample_qpc;
  uint32_t discontinuity, reserved;
  int16_t pcm[kAudioFrames * kAudioChannels];
};
struct alignas(64) AudioSlot {
  volatile LONG64 lock;
  AudioPacket packet;
};
struct alignas(64) SharedAudio {
  uint32_t magic, version, size, sample_rate;
  uint64_t generation, session_id;
  volatile LONG64 published;
  // Same-machine QueryPerformanceCounter ticks, shared by Browser/Endpoint.
  // Never serialize a process-local TimeTicks epoch into this mapping.
  int64_t qpc_frequency;
  AudioSlot slots[kAudioSlots];
};
static_assert(sizeof(AudioPacket) == 1952);
static_assert(sizeof(AudioSlot) == 1984);
static_assert(offsetof(SharedAudio, slots) == 64);
static_assert(sizeof(SharedAudio) == 15936);
static_assert(alignof(SharedAudio) >= 8 && alignof(AudioSlot) >= 8);
static_assert(offsetof(SharedAudio, published) % 8 == 0);
static_assert(offsetof(AudioSlot, lock) % 8 == 0);
inline uint64_t AudioPublished(SharedAudio* ring) {
  return static_cast<uint64_t>(InterlockedCompareExchange64(&ring->published, 0, 0));
}
inline void PublishAudio(SharedAudio* ring, const AudioPacket& packet) {
  auto& slot = ring->slots[(packet.sequence - 1) % kAudioSlots];
  InterlockedIncrement64(&slot.lock);
  slot.packet = packet;
  InterlockedIncrement64(&slot.lock);
  InterlockedExchange64(&ring->published, static_cast<LONG64>(packet.sequence));
}
inline bool ReadAudio(SharedAudio* ring, uint64_t sequence, AudioPacket& packet) {
  if (!sequence) return false;
  auto& slot = ring->slots[(sequence - 1) % kAudioSlots];
  const auto before = InterlockedCompareExchange64(&slot.lock, 0, 0);
  if (before & 1) return false;
  packet = slot.packet;
  MemoryBarrier();
  return before == InterlockedCompareExchange64(&slot.lock, 0, 0) && packet.sequence == sequence;
}
}  // namespace remotekit
