#include "rtc/outbox.hpp"

namespace remotekit {
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
      pending_.push_back(message);
}
void ControlOutbox::Flush(Scope scope, const Send& send) {
  std::lock_guard lock(mutex_);
  if (!scope.peer || scope != scope_)
    return;
  for (auto* queue : {&pending_, &critical_}) {
    while (!queue->empty()) {
      if (send(queue->front()) != 0)
        return;
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
    critical_.push_back(bytes);
}
void ControlOutbox::Notice(Scope scope,
                           const std::string& bytes,
                           const std::function<void(const std::string&)>& send) {
  std::lock_guard lock(mutex_);
  if (scope.peer && scope == scope_ && pending_.empty() && critical_.empty())
    send(bytes);
}
}  // namespace remotekit
