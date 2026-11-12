#pragma once
#include "util/common.hpp"
#include "util/error.hpp"
#include <mutex>
#include <functional>
#include <memory>
#include <optional>
#include <span>
#include <chrono>
namespace remotekit {
class DeliveryState {
 public:
  template <class Send>
  std::optional<bool> Dispatch(Send send) {
    std::lock_guard lock(mutex_);
    if (canceled_)
      return std::nullopt;
    written_ = send();
    return written_;
  }
  bool CancelAndWasWritten() {
    std::lock_guard lock(mutex_);
    canceled_ = !written_;
    return written_;
  }
  void MarkWritten() {
    std::lock_guard lock(mutex_);
    written_ = true;
  }

 private:
  std::mutex mutex_;
  bool canceled_ = false, written_ = false;
};
using DeliveryFlag = std::shared_ptr<DeliveryState>;
class ManagementLink {
 public:
  using Disconnect = std::function<void(uint64_t)>;
  virtual ~ManagementLink() = default;
  virtual bool Next(std::string& bytes, uint64_t& generation, bool& eof) = 0;
  virtual bool Current(uint64_t generation) = 0;
  virtual bool SendReply(uint64_t generation, const Json& reply) = 0;
  virtual bool SendEvent(const Json& event, uint64_t generation, DeliveryFlag delivery = {}) = 0;
  virtual void OnDisconnect(Disconnect callback) = 0;
  using Peers = std::function<Result<void>(const Json&)>;
  virtual void OnPeers(Peers) {}
  using Binary = std::function<void(const Json&, std::span<const uint8_t>)>;
  virtual void OnBinary(Binary) {}
  virtual Result<Json> Request(const std::string& name, Json fields) = 0;
  virtual Result<Json> RequestUntil(const std::string& name,
                                    Json fields,
                                    std::chrono::steady_clock::time_point) {
    return Request(name, std::move(fields));
  }
  struct ReadyState {
    uint64_t generation;
    Json sessions;
    Json object_keys;
  };
  virtual std::optional<ReadyState> ReadySessions() { return {}; }
};
}  // namespace remotekit
