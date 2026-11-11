#pragma once
#include "util/common.hpp"
#include "rtc/event.hpp"
#include "util/error.hpp"
#include <deque>
#include <functional>
#include <mutex>
#include <optional>

namespace remotekit {
class DataRouter {
 public:
  enum class Kind {
    kProduct,
    kPresentation,
    kInput,
    kFiles,
    kClock,
    kFeedback,
    kRefresh,
    kDataState
  };
  struct Hooks {
    std::function<uint64_t()> peer, stamp, epoch;
    std::function<bool(const RtcEvent&)> current;
    std::function<void(const RtcEvent&)> product, presentation, input, files, feedback, refresh,
        data_state;
    std::function<void(const RtcEvent&)> received;
    std::function<void(const Json&, uint64_t)> send;
  };
  explicit DataRouter(Hooks hooks, Json log_fields = Json::object())
      : hooks_(std::move(hooks)), log_fields_(std::move(log_fields)) {}
  static Result<Kind> Classify(const Json& message);
  static bool Number(const Json& message, const char* field, uint64_t& result);
  static Result<void> Boundary(const std::function<Result<void>()>& fn);
  Result<void> Receive(RtcEvent event);
  void DataState(const RtcEvent& event);
  void Drain();
  void Clear();

 private:
  struct Message {
    Kind kind;
    RtcEvent event;
    std::optional<Error> error;
  };
  void Dispatch(const Message& message);
  Hooks hooks_;
  const Json log_fields_;
  std::mutex mutex_;
  std::deque<Message> pending_;
};
}  // namespace remotekit
