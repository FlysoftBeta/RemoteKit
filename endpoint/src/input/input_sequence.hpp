#pragma once
#include <charconv>
#include <cstdint>
#include <limits>
#include <optional>
#include <string_view>

namespace remotekit {
// Queue admission owns the peer-local counter; the input worker owns the
// Browser counter. Bind only after the previous workers have joined.
class InputSequence {
 public:
  void Bind(uint64_t peer) {
    peer_ = peer;
    client_ = 0;
  }
  bool Admit(uint64_t peer, std::string_view sequence) {
    uint64_t value = 0;
    const auto parsed = std::from_chars(sequence.data(), sequence.data() + sequence.size(), value);
    if (!peer || peer != peer_ || parsed.ec != std::errc{} ||
        parsed.ptr != sequence.data() + sequence.size() || value <= client_)
      return false;
    client_ = value;
    return true;
  }
  std::optional<uint64_t> NextBrowser() {
    if (browser_ == std::numeric_limits<uint64_t>::max())
      return std::nullopt;
    return ++browser_;
  }

 private:
  uint64_t peer_ = 0, client_ = 0, browser_ = 0;
};
}  // namespace remotekit
