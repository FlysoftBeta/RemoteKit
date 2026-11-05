#pragma once

#include <atomic>
#include <cstdint>

namespace remotekit {

// The dispatcher and management-loss handler serialize transitions. Workers
// carry a stamp across queues and recheck it at their point of admission.
class ProductAuthorization {
 public:
  enum class Decision { reject, unchanged, change };
  void Bind(bool required) {
    required_ = required;
    epoch_ = 0;
    unlocked_ = false;
    Close();
    if (!required)
      Open();
  }
  Decision Check(uint64_t epoch, bool unlocked) const {
    if (!Required() || !epoch || epoch < Epoch())
      return Decision::reject;
    if (epoch > Epoch())
      return Decision::change;
    if (unlocked == unlocked_ && (!unlocked || Stamp()))
      return Decision::unchanged;
    return Decision::reject;
  }
  void Commit(uint64_t epoch, bool unlocked) {
    epoch_ = epoch;
    unlocked_ = unlocked;
  }
  uint64_t Epoch() const { return epoch_.load(); }
  bool Required() const { return required_.load(); }
  void Close() { stamp_ = 0; }
  void Open() { stamp_ = ++serial_; }
  uint64_t Stamp() const { return stamp_.load(); }
  bool Current(uint64_t stamp) const { return stamp && stamp == Stamp(); }

 private:
  bool unlocked_ = false;
  uint64_t serial_ = 0;
  std::atomic<bool> required_{false};
  std::atomic<uint64_t> epoch_{0};
  std::atomic<uint64_t> stamp_{0};
};
}  // namespace remotekit
