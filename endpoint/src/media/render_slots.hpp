#pragma once
#include "gpu_device.hpp"
#include "sdk_loader.hpp"
#include "remotekit/shared_render_slots.h"
#include "server_trace.hpp"
#include <memory>
#include <optional>
#include <vector>
#include <mutex>
#include <atomic>
namespace remotekit::media {
class RenderSlots {
 public:
 RenderSlots();~RenderSlots();
 struct StatsSnapshot {
  bool idle=false;uint64_t wakes=0,idleEntries=0;
  uint64_t begins=0,rejectIdle=0,rejectNotReady=0,rejectStopped=0,readyObserved=0,consumedCompleted=0;
  uint64_t stopSent=0,stopConfirmed=0,occupied=0,retiredOccupied=0,peakOccupied=0,heldSlots=0,activeDepth=0;
  uint64_t retiredGenerations=0,retiredGenerationsCompleted=0,unknownGpuRetainedGenerations=0,unknownGpuRetentions=0;
 };
 StatsSnapshot Stats()const;
 enum class Result {idle,ready,reconfigure,error};
 void SetTrace(std::shared_ptr<ServerTrace> trace){trace_=std::move(trace);}
 void SetClock(const remotekit_rtc_clock_sample& sample){clock_=sample;}
 bool Open(remotekit_sdk_render_setup,Sdk&,std::string&);
 bool Begin(uint32_t interval_us,bool force,std::string&,bool* sent=nullptr);
 void Pressure(bool encoder_backlog);
 bool HasCapacity()const;
 // Borrowed by the owner thread until the next Open or Close.
 HANDLE EventHandle()const;
 Result Poll(remotekit_rtc_frame&,SharedAtlasFrame&,std::string&);
 SharedAtlasFrame LatestMetadata()const;
 ID3D11Device5* Device()const;
 bool Close(std::string&,bool producer_exited=false);
 int64_t MonotonicMicros()const;
 std::optional<double> capture_to_ready_ms()const;
 double clock_uncertainty_us()const;
 uint64_t copied_frames()const{return 0;}
 uint64_t delivered_frames()const{return delivered_.load();}
 uint64_t drops()const{return 0;}
 bool shared_input()const{return true;}
 double last_copy_ms()const{return 0;}
 bool ready_gate_enabled()const{return true;}
 uint64_t shared_borrows()const{return delivered_.load();}
 uint64_t shared_held_slots()const;
 private:
 struct State;std::shared_ptr<State> state_;std::vector<std::shared_ptr<State>> retired_;
 void Reap();
 void PublishStats();
 struct PublishGuard {RenderSlots& owner;~PublishGuard(){owner.PublishStats();}};
 StatsSnapshot counters_,published_;mutable std::mutex stats_mutex_;
 ComPtr<ID3D11Device5> device_;LUID adapter_{};
 remotekit_rtc_clock_sample clock_{};std::shared_ptr<ServerTrace> trace_;std::atomic<uint64_t> delivered_{0};
};
}
