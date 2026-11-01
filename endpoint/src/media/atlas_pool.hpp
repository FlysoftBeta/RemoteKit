#pragma once
#include "gpu_device.hpp"
#include "remotekit/shared_atlas.h"
#include "remotekit_rtc.h"
#include <memory>
#include <atomic>
#include <vector>
#include <optional>
#include "server_trace.hpp"
namespace remotekit::media {
class AtlasPool {
 public:
  AtlasPool();~AtlasPool();
  void SetTrace(std::shared_ptr<ServerTrace> trace){trace_=std::move(trace);}
  void SetClock(const remotekit_rtc_clock_sample& sample);
  std::optional<double> capture_to_ready_ms() const;
  double clock_uncertainty_us() const;
  bool Open(remotekit_sdk_atlas_setup setup,uint32_t pool_size,std::string& error);
  // Owns all setup handles, including failed Open. One polling owner thread.
  // ready returns one lease; caller releases it or transfers it to RTC submit.
  enum class Result {idle,ready,error};
  Result Poll(remotekit_rtc_frame&,SharedAtlasFrame&,std::string& error);
  ID3D11Device5* Device() const;
  SharedAtlasFrame LatestMetadata() const;
  uint64_t copied_frames() const;
  bool Close(std::string& error);
  uint64_t drops() const;
  double last_copy_ms() const;
  bool ready_gate_enabled() const {return ready_gate_;}
  uint64_t ready_gate_deferred_polls() const {return gate_polls_.load();}
  uint64_t ready_gate_deferred_frames() const {return gate_frames_.load();}
 private:
  void ReapRetired();
  struct State;std::shared_ptr<State> state_;
  std::vector<std::shared_ptr<State>> retired_;
  ComPtr<ID3D11Device5> device_;
  LUID adapter_{};
  remotekit_rtc_clock_sample clock_{};
  std::shared_ptr<ServerTrace> trace_;
  bool ready_gate_=false;
  std::atomic<uint64_t> gate_polls_{0},gate_frames_{0};
};
}
