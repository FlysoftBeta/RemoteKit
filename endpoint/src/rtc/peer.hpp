#pragma once
#include "util/common.hpp"
#include "rtc/event.hpp"
#include "media/sdk_loader.hpp"
#include "options.hpp"
#include <atomic>
#include <deque>
#include <functional>
#include <mutex>
namespace remotekit {
class PeerController {
 public:
  enum class State { kNone, kNegotiating, kConnected, kClosing };
  struct Hooks {
    std::function<void(uint64_t, uint64_t)> bind;
    std::function<Result<void>(uint64_t, const std::string&)> started;
    std::function<void()> stopping, drained;
    std::function<void(const RtcEvent&)> event;
    std::function<void(uint64_t, const Json&)> signal;
    std::function<int(uint64_t, uint64_t)> create_encoder;
    std::function<int(uint64_t, const remotekit_rtc_encoder_config*)> configure_encoder;
    std::function<int(uint64_t, const remotekit_rtc_frame*, int)> encode;
    std::function<void(uint64_t, uint32_t, uint32_t)> rates;
    std::function<void(uint64_t)> keyframe, destroy_encoder;
  };
  PeerController(media::Sdk& sdk, const RuntimeOptions& options, Hooks hooks)
      : sdk_(sdk), options_(options), hooks_(std::move(hooks)) {}
  ~PeerController();
  Result<Json> Offer(const Json& request,
                     uint64_t generation,
                     uint32_t fps,
                     uint32_t degradation,
                     bool audio,
                     bool av_sync);
  Result<Json> Ice(const Json&);
  Result<void> Policy(uint32_t fps, uint32_t degradation, bool audio);
  void Close();
  void FlushSignals();
  uint64_t Handle() const { return peer_.load(); }
  uint64_t ManagementGeneration() const { return management_generation_.load(); }
  std::string Connection() const {
    std::lock_guard lock(mutex_);
    return connection_;
  }
  State GetState() const { return state_.load(); }
  bool Connected() const { return GetState() == State::kConnected; }
  bool AvSync() const { return av_sync_.load(); }
  bool DataOpen() const { return data_open_.load(); }
  uint32_t ReceiveLevel() const { return receive_level_.load(); }
  void Failed() {
    if (Handle() && GetState() != State::kClosing)
      state_ = State::kNegotiating;
  }

 private:
  static void EventCallback(void*, uint64_t, uint32_t, const void*, size_t, const char*, int32_t);
  void OnEvent(uint64_t, uint32_t, const void*, size_t, const char*, int32_t);
  media::Sdk& sdk_;
  const RuntimeOptions& options_;
  Hooks hooks_;
  std::atomic<uint64_t> peer_{0}, management_generation_{0};
  std::atomic<State> state_{State::kNone};
  std::atomic<bool> data_open_{false}, av_sync_{false};
  std::atomic<uint32_t> receive_level_{0};
  mutable std::mutex mutex_;
  std::string connection_;
  std::string advertised_ip_;
  std::deque<RtcEvent> signals_;
  bool signal_overflow_ = false;
};
}  // namespace remotekit
