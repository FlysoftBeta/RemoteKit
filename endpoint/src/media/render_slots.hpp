#pragma once
#include "gpu_device.hpp"
#include "sdk_loader.hpp"
#include "protocol/shared_render_slots.h"
#include "server_trace.hpp"
#include <memory>
#include <optional>
#include <vector>
#include <mutex>
#include <atomic>
namespace remotekit::media {
class RenderSlots {
 public:
  RenderSlots();
  ~RenderSlots();
  enum class Phase { kClosed, kRunning, kStopping, kFailed };
  struct StatsSnapshot {
    Phase phase = Phase::kClosed;
    bool idle = false;
    uint64_t wakes = 0, idleEntries = 0;
    uint64_t begins = 0, rejectIdle = 0, rejectNotReady = 0, rejectStopped = 0, readyObserved = 0,
             consumedCompleted = 0;
    uint64_t stopSent = 0, stopConfirmed = 0, occupied = 0, retiredOccupied = 0, peakOccupied = 0,
             heldSlots = 0, activeDepth = 0;
    uint64_t retiredGenerations = 0, retiredGenerationsCompleted = 0,
             unknownGpuRetainedGenerations = 0, unknownGpuRetentions = 0;
  };
  StatsSnapshot Stats() const;
  enum class Result { idle, ready, error };
  void SetTrace(std::shared_ptr<ServerTrace> trace) { trace_ = std::move(trace); }
  void SetClock(const remotekit_rtc_clock_sample& sample) { clock_ = sample; }
  bool Open(remotekit_sdk_render_setup,
            uint32_t producer_pid,
            Sdk&,
            LUID,
            ID3D11Device5*,
            ID3D11DeviceContext4*,
            std::string&);
  bool Begin(uint32_t interval_us, bool force, std::string&, bool* sent = nullptr);
  void Pressure(bool encoder_backlog);
  bool HasCapacity() const;
  // Borrowed by the owner thread until the next Open or Close.
  HANDLE EventHandle() const;
  Result Poll(remotekit_rtc_frame&, SharedAtlasFrame&, std::string&);
  SharedAtlasFrame LatestMetadata() const;
  static SharedAtlasFrame Metadata(const remotekit_rtc_frame& frame);
  uint64_t Generation() const;
  std::optional<uint64_t> ClipboardSequence() const;
  bool Close(std::string&);
  int64_t MonotonicMicros() const;
  std::optional<double> capture_to_ready_ms() const;
  double clock_uncertainty_us() const;
  uint64_t delivered_frames() const { return delivered_.load(); }
  uint64_t shared_borrows() const { return delivered_.load(); }
  uint64_t shared_held_slots() const;

 private:
  struct State;
  std::shared_ptr<State> state_;
  std::atomic<std::shared_ptr<State>> clipboard_state_;
  std::vector<std::shared_ptr<State>> retired_;
  void Reap();
  void PublishStats();
  struct PublishGuard {
    RenderSlots& owner;
    ~PublishGuard() { owner.PublishStats(); }
  };
  StatsSnapshot counters_, published_;
  mutable std::mutex stats_mutex_;
  remotekit_rtc_clock_sample clock_{};
  std::shared_ptr<ServerTrace> trace_;
  std::atomic<uint64_t> delivered_{0};
  // Media source identity remains unique across render generations.
  uint64_t next_cookie_ = 0;
};
}  // namespace remotekit::media
