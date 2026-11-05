#pragma once
#include "util/common.hpp"
#include <cstdint>
namespace remotekit {
struct RtcEvent {
  uint32_t type;
  std::string bytes, auxiliary;
  int32_t value;
  uint64_t peer;
  uint64_t authorization = 0;
  uint64_t trace_input_sequence = 0;
  uint64_t management_generation = 0;
  Json message;
  int64_t received_qpc = 0;
  bool connection_changed = false;
};
}  // namespace remotekit
