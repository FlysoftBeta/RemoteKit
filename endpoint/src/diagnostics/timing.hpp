#pragma once
#include <array>
#include "session/context.hpp"
namespace remotekit {

class ConnectionTiming : private ControllerContext {
 public:
  ConnectionTiming(ControllerContext context) : ControllerContext(context) {}
  enum class ConnectionPhase : size_t {
    answer,
    first_candidate,
    gather_complete,
    connected,
    data_open,
    output_open_start,
    output_open_end,
    source_frame,
    submit,
    encoder_configure_start,
    encoder_configure_end,
    encoded,
    count
  };
  void Reset();
  void MarkConnection(ConnectionPhase phase);
  Json ConnectionTimings() const;

 private:
  std::atomic<int64_t> connection_started_qpc{0};
  std::array<std::atomic<int64_t>, static_cast<size_t>(ConnectionPhase::count)> connection_phases{};
};
}  // namespace remotekit
