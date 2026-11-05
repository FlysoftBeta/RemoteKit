#pragma once
#include "remotekit/browser/osr/plane_pool.h"
#include "base/timer/timer.h"
namespace remotekit::browser::osr {
class Generation;
extern bool gpu_fault_sealed;
struct Retirement {
  explicit Retirement(Generation& owner) : owner_(owner) {}
  bool ProducerRetired(const Plane& plane) const;
  void Fatal(std::string error);
  void Stop();
  void Poll();
  std::vector<std::shared_ptr<Plane>> retired_planes_;
  base::RepeatingTimer timer_;
  std::shared_ptr<Generation> keepalive_;
  bool stopping_ = false;
  bool stop_barrier_seen_ = false, stopped_sent_ = false, channel_disconnected_ = false;

 private:
  Generation& owner_;
};
}  // namespace remotekit::browser::osr
