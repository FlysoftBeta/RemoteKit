#pragma once
#include <array>
#include <cstdint>
#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include "util/retry_unit.hpp"

namespace remotekit {
class ControlOutbox {
 public:
  struct Scope {
    uint64_t peer = 0, authorization = 0;
    bool operator==(const Scope&) const = default;
  };
  using Send = std::function<int(const std::string&)>;
  std::optional<Error> Failure(Scope scope) const;
  void Bind(Scope scope);
  void Replace(Scope scope, std::string mode, std::string layout, std::string prepare);
  void Flush(Scope scope,
             const Send& send,
             RetryUnit::Clock::time_point now = RetryUnit::Clock::now());
  void Transient(Scope scope, const std::string& bytes, const Send& send, bool low_priority = true);
  void Notice(Scope scope,
              const std::string& bytes,
              const std::function<void(const std::string&)>& send);

 private:
  friend class NativeRetryOwnerProbe;
  mutable std::mutex mutex_;
  Scope scope_;
  std::string mode_;
  struct Message {
    std::string bytes;
    RetryUnit retry{"control.delivery"};
    explicit Message(std::string value) : bytes(std::move(value)) { retry.Input(bytes); }
  };
  std::deque<Message> pending_, critical_;
  std::array<std::string, 3> transaction_;
};
}  // namespace remotekit
