#pragma once

#include "management/coordination.hpp"
#include "util/retry_unit.hpp"
#include <deque>
#include <future>
#include <memory>
#include <mutex>

namespace remotekit {
class RpcResults {
  friend class NativeRetryOwnerProbe;
  static bool MayReadmit(const RetryUnit& retry) {
    if (!retry.Failure())
      return false;
    const auto code = retry.Failure()->code;
    return code == ErrorCode::kBusy || code == ErrorCode::kRateLimited ||
           code == ErrorCode::kUnavailable;
  }

 public:
  template <class Action>
  Result<Json> Execute(const Json& request, Action action) {
    if (!request.contains("opId") || !request["opId"].is_string() || !request.contains("replay") ||
        !request["replay"].is_boolean())
      return Error{ErrorCode::kInvalidRequest, "opId and replay are required"};
    const auto id = request["opId"].get<std::string>();
    if (id.empty() || id.size() > 64 ||
        !std::all_of(id.begin(), id.end(), [](unsigned char c) { return c >= 33 && c <= 126; }))
      return Error{ErrorCode::kInvalidRequest, "invalid opId"};
    auto payload = request;
    payload.erase("id");
    payload.erase("replay");
    payload.erase("connectionEpoch");
    const auto fingerprint = payload.dump();
    std::shared_ptr<Entry> entry;
    bool fresh = false;
    {
      std::lock_guard lock(mutex_);
      const auto found = entries_.find(id);
      if (found != entries_.end()) {
        entry = found->second;
        if (entry->fingerprint != fingerprint)
          return Error{ErrorCode::kConflict, "opId payload conflicts"};
        if (entry->result.wait_for(std::chrono::seconds(0)) == std::future_status::ready &&
            entry->retry->Status() == RetryUnit::State::kWaiting && entry->retry->Ready() &&
            MayReadmit(*entry->retry)) {
          auto next = std::make_shared<Entry>(fingerprint);
          next->retry = entry->retry;
          entry = std::move(next);
          found->second = entry;
          fresh = true;
        }
      } else {
        if (request["replay"].get<bool>())
          return Error{ErrorCode::kOutcomeUnknown, "RPC result is not retained"};
        entry = std::make_shared<Entry>(fingerprint);
        entry->retry->Input(id);
        entries_.emplace(id, entry);
        fresh = true;
      }
    }
    if (fresh) {
      Result<Json> result =
          Error{ErrorCode::kOutcomeUnknown, "RPC execution did not return a result"};
      try {
        result = action();
      } catch (...) {
        result = Error{ErrorCode::kOutcomeUnknown, "RPC execution did not return a result"};
      }
      std::lock_guard lock(mutex_);
      if (result)
        entry->retry->Success();
      else {
        entry->retry->Fail(result.error());
        result = *entry->retry->Failure();
      }
      entry->completion.set_value(std::move(result));
      std::erase(completed_, id);
      completed_.push_back(id);
      while (completed_.size() > coordination::kMaxResults) {
        entries_.erase(completed_.front());
        completed_.pop_front();
      }
    }
    return entry->result.get();
  }

 private:
  struct Entry {
    explicit Entry(std::string value)
        : fingerprint(std::move(value)), result(completion.get_future().share()) {}
    std::string fingerprint;
    std::promise<Result<Json>> completion;
    std::shared_future<Result<Json>> result;
    std::shared_ptr<RetryUnit> retry = std::make_shared<RetryUnit>("rpc.admission");
  };
  mutable std::mutex mutex_;
  std::map<std::string, std::shared_ptr<Entry>> entries_;
  std::deque<std::string> completed_;
};
}  // namespace remotekit
