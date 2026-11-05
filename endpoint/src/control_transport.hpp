#pragma once
#include <cstdint>
#include <functional>
#include <memory>
#include <string>

namespace remotekit {
// A disconnected management link never owns or tears down browser/RTC state.
// Dispatcher operations carry their socket generation; replies cannot migrate.
class ControlTransport {
 public:
  ControlTransport(std::string url,
                   std::string node_id,
                   std::string token,
                   std::function<void(uint64_t)> disconnected = {});
  ~ControlTransport();
  bool Next(std::string& message, uint64_t& generation);
  bool Current(uint64_t generation);
  // Acceptance into the current bounded link queue, not Control admission.
  bool TrySend(std::string message, uint64_t generation = 0);
  void Send(std::string message, uint64_t generation = 0);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
}  // namespace remotekit
