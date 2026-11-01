#pragma once
#include "hardware_encoder.hpp"
#include "gpu_device.hpp"
#include "sdk_loader.hpp"
#include <json.hpp>
#include <mutex>
#include <condition_variable>
#include <thread>
#include <deque>
#include <atomic>
#include <map>
#include <functional>
namespace remotekit::media {
struct EncoderStats {
 std::atomic<uint64_t> submitted{0},completed{0},bytes{0},dropped{0};
 std::atomic<double> last_encode_ms{0};
 std::atomic<uint64_t> rate_updates{0},keyframe_requests{0},keyframes_submitted{0},keyframes_encoded{0};
 std::atomic<uint64_t> pending{0},inflight{0},pending_replaced{0},hardware_busy{0};
 std::atomic<uint64_t> paused_drops{0},error_drops{0},inactive_drops{0},cancelled_drops{0};
 std::atomic<uint64_t> queue_wait_us{0},queue_wait_samples{0};
 std::mutex mutex;std::string backend,error;
 nlohmann::json sender_rtc_stats;
 std::optional<QsvLowPowerInfo> qsv_low_power;
 uint32_t requested_bitrate=0,requested_fps=0,applied_bitrate=0,applied_fps=0,actual_level=0;
 nlohmann::json Snapshot();
};
class EncoderWorker {
 public:
  EncoderWorker(Sdk&,uint64_t encoder,ID3D11Device*,std::string mode,EncoderSettings defaults,
                std::shared_ptr<EncoderStats> stats,
                std::function<void(uint32_t,uint64_t,size_t,bool)> completed,
                std::shared_ptr<ServerTrace> trace={},uint64_t peer=0);
  ~EncoderWorker();
  bool Configure(const remotekit_rtc_encoder_config&);
  bool Enqueue(const remotekit_rtc_frame&,bool keyframe);
  void Rates(uint32_t bitrate,uint32_t fps);
  void Keyframe();
  void Stop();
 private:
  struct Job {remotekit_rtc_frame frame{};bool key=false;uint64_t cookie=0;int64_t enqueued_qpc=0,submitted_qpc=0;uint32_t surface=0;};
  void Run();
  void Complete(AccessUnit&);
  void Error(const std::string&);
  Sdk& sdk_;uint64_t encoder_;
 uint32_t nominal_fps_=0;bool fixed_rate_fps_=false;
  ComPtr<ID3D11Device> device_;std::string mode_;EncoderSettings settings_;
  std::shared_ptr<EncoderStats> stats_;
  std::function<void(uint32_t,uint64_t,size_t,bool)> completed_;
  std::shared_ptr<ServerTrace> trace_;uint64_t trace_peer_=0;
  std::unique_ptr<HardwareEncoder> hardware_;
  Nv12Converter converter_;
  std::vector<ComPtr<ID3D11Texture2D>> surfaces_;
  std::deque<uint32_t> free_;
  std::deque<Job> queue_;
  std::map<uint64_t,Job> inflight_;
  uint64_t cookie_=0;
  std::mutex mutex_;std::condition_variable wake_;
  std::thread thread_;bool stopping_=false,configured_=false;std::atomic<bool> failed_{false};
  std::atomic<bool> keyframe_{true},paused_{false};
  std::atomic<uint32_t> bitrate_{0},fps_{0},applied_bitrate_{0},applied_fps_{0};
};
}
