#include "rtc/outbox.hpp"
#include "util/sdk_error.hpp"

namespace remotekit {
std::optional<Error> ControlOutbox::Failure(Scope scope) const {
  std::lock_guard lock(mutex_);
  if (scope != scope_)
    return {};
  for (const auto* queue : {&pending_, &critical_})
    if (!queue->empty() && queue->front().retry.Failure())
      return queue->front().retry.Failure();
  return {};
}
void ControlOutbox::Bind(Scope scope) {
  std::lock_guard lock(mutex_);
  scope_ = scope;
  mode_.clear();
  pending_.clear();
  critical_.clear();
  transaction_ = {};
}
void ControlOutbox::Replace(Scope scope,
                            std::string mode,
                            std::string layout,
                            std::string prepare) {
  std::lock_guard lock(mutex_);
  if (!scope.peer || scope != scope_)
    return;
  if (!mode.empty())
    mode_ = std::move(mode);
  const std::array<std::string, 3> transaction{mode_, layout, prepare};
  if (transaction == transaction_)
    return;
  transaction_ = transaction;
  pending_.clear();
  for (const auto& message : transaction)
    if (!message.empty())
      pending_.emplace_back(message);
}
void ControlOutbox::Flush(Scope scope, const Send& send, RetryUnit::Clock::time_point now) {
  std::lock_guard lock(mutex_);
  if (!scope.peer || scope != scope_)
    return;
  for (auto* queue : {&pending_, &critical_}) {
    while (!queue->empty()) {
      auto& message = queue->front();
      if (!message.retry.Ready(now))
        break;
      const auto status = send(message.bytes);
      if (status) {
        message.retry.Fail({SdkErrorCode(status), "control data send failed"}, now);
        break;
      } else {
        message.retry.Success();
      }
      queue->pop_front();
    }
  }
}
void ControlOutbox::Transient(Scope scope,
                              const std::string& bytes,
                              const Send& send,
                              bool low_priority) {
  std::lock_guard lock(mutex_);
  if (!scope.peer || scope != scope_)
    return;
  if (pending_.empty() && critical_.empty()) {
    if (send(bytes) == 0)
      return;
  }
  if (!low_priority)
    critical_.emplace_back(bytes);
}
void ControlOutbox::Notice(Scope scope,
                           const std::string& bytes,
                           const std::function<void(const std::string&)>& send) {
  std::lock_guard lock(mutex_);
  if (scope.peer && scope == scope_ && pending_.empty() && critical_.empty())
    send(bytes);
}
}  // namespace remotekit
