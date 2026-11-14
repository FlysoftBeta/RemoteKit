#pragma once
#include "util/common.hpp"
#include "rtc/event.hpp"
#include "rtc/authorization.hpp"
#include "media/server_trace.hpp"
#include "session/control_reliability.hpp"
#include "input/input_sequence.hpp"
#include <atomic>
#include <condition_variable>
#include <deque>
#include <functional>
#include <thread>
namespace remotekit {
class InputController {
 public:
  using Event = RtcEvent;
  struct Hooks {
    std::function<uint64_t()> control, input_stamp, epoch;
    std::function<bool(const Event&)> admitted;
    std::function<AuthorizationController::AdmissionToken()> admission;
    std::function<bool(const AuthorizationController::AdmissionToken&)> revalidate;
    std::function<bool(const std::string&, uint64_t)> allows;
    std::function<Result<Json>(Json, uint64_t, uint32_t, bool, const std::function<bool()>&)> rpc;
    std::function<void(const Json&, uint64_t)> send;
    std::function<void()> failed;
    std::function<std::shared_ptr<media::ServerTrace>()> trace;
    Json log_fields = Json::object();
  };
  InputController(std::string session, Hooks hooks);
  ~InputController();
  void Start(uint64_t peer);
  void Stop();
  void Clear();
  void QueueInput(const Event& event);
  Json Snapshot() const;

 private:
  std::string session_id_;
  Hooks hooks_;
  std::mutex lifecycle_mutex_;
  void StopLocked();
  mutable std::mutex input_mutex;
  std::condition_variable input_wake;
  std::deque<Event> input_queue;
  remotekit::InputSequence input_sequence;
  std::thread input_thread;
  std::atomic<bool> stop_input{false};
  std::atomic<uint64_t> input_rejected{0}, input_coalesced{0};
  std::atomic<uint64_t> input_busy_retries{0}, input_busy_exhausted{0};
  void ReplyInput(Json reply, const Json& request, uint64_t stamp);
  void RejectInput(ErrorCode code, const char* error, const Json& request, const Event& event);
  void HandleData(const Event& event);
  void InputLoop();
};
}  // namespace remotekit
