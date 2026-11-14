#pragma once
#include "util/retry_unit.hpp"
#include <json.hpp>
#include <map>
#include <optional>
#include <string>
#include <algorithm>
#include <charconv>
#include <chrono>

namespace remotekit {
// Dispatcher-owned. One bounded transfer for the Session, one chunk per tick.
// Snapshot only updates candidates; it never drains a PageState transfer.
class NavigationExport {
  friend class NativeRetryOwnerProbe;
  using Json = nlohmann::json;
  struct Identity {
    std::string incarnation, instance, document, revision;
    bool operator==(const Identity&) const = default;
  };
  struct Task {
    std::string view, transfer;
    Identity identity;
    uint64_t size = 0, offset = 0;
    Json chunks = Json::array();
    bool saved = false, begin_unknown = false;
  };
  std::map<std::string, Identity> candidates_;
  std::map<std::string, RetryUnit> retries_;
  std::optional<Task> task_;
  struct Cleanup {
    std::string incarnation, view, transfer;
    RetryUnit retry{"navigation.transfer_cleanup"};
  };
  std::vector<Cleanup> cleanup_;
  std::string cursor_;
  static std::optional<Identity> Identify(const Json& view, const std::string& incarnation) {
    if (!view.contains("navigationRevision") || view.value("loading", false) ||
        view.value("pending", false) || view.value("lifecycle_uncertain", false) ||
        view.value("close_state", std::string()) == "closed" ||
        view.value("close_state", std::string()) == "closing")
      return {};
    return Identity{incarnation, view.value("instance", std::string()),
                    view.value("document", std::string()), view.at("navigationRevision")};
  }

 public:
  void Clear() {
    candidates_.clear();
    retries_.clear();
    task_.reset();
    cleanup_.clear();
    cursor_.clear();
  }
  void Forget(const std::string& view) {
    candidates_.erase(view);
    if (const auto found = retries_.find(view); found != retries_.end())
      found->second.Input("retired:" + view);
  }
  void RetireTransfer(const std::string& incarnation,
                      const std::string& view,
                      const std::string& transfer) {
    if (transfer.empty())
      return;
    cleanup_.push_back({incarnation, view, transfer});
    cleanup_.back().retry.Input(view + ":" + transfer);
  }
  bool Pending() const {
    return task_.has_value() || !cleanup_.empty() ||
           std::any_of(candidates_.begin(), candidates_.end(), [&](const auto& item) {
             const auto& retry = retries_.at(item.first);
             return retry.Status() == RetryUnit::State::kIdle ||
                    retry.Status() == RetryUnit::State::kWaiting;
           });
  }
  Json Failures() const {
    Json result = Json::object();
    for (const auto& [view, retry] : retries_)
      if (retry.Failure())
        result[view] = {{"pending", retry.Status() == RetryUnit::State::kWaiting},
                        {"phase", retry.Reconcile() ? "export_unknown" : "export_failed"},
                        {"error", WireError(*retry.Failure())}};
    for (const auto& cleanup : cleanup_)
      if (cleanup.retry.Failure())
        result[cleanup.view] = {{"pending", cleanup.retry.Status() == RetryUnit::State::kWaiting},
                                {"phase", "transfer_cleanup"},
                                {"error", WireError(*cleanup.retry.Failure())}};
    return result;
  }
  std::optional<Error> TerminalFailure() const {
    for (const auto& [view, retry] : retries_)
      if (retry.Status() == RetryUnit::State::kFaulted)
        return retry.Failure();
    for (const auto& cleanup : cleanup_)
      if (cleanup.retry.Status() == RetryUnit::State::kFaulted)
        return cleanup.retry.Failure();
    return {};
  }
  std::string NextView() const {
    if (task_)
      return task_->view;
    if (candidates_.empty())
      return {};
    const auto next = candidates_.upper_bound(cursor_);
    return (next == candidates_.end() ? candidates_.begin() : next)->first;
  }
  void Observe(const Json& view, const std::string& incarnation, bool needed) {
    const auto id = view.at("view").get<std::string>();
    const auto identity = Identify(view, incarnation);
    if (!needed || !identity) {
      candidates_.erase(id);
      return;
    }
    if (candidates_.contains(id) || candidates_.size() < 256)
      candidates_[id] = *identity;
    auto& retry = retries_.try_emplace(id, "navigation.export").first->second;
    retry.Input(identity->incarnation + ":" + identity->instance + ":" + identity->document + ":" +
                identity->revision);
  }
  // ReadCurrent returns a fresh view (or null), including Browser incarnation
  // captured by the caller. Browser requests serialize with input via Rpc.
  template <class ReadCurrent, class Rpc, class Decode, class Save>
  Result<void> Tick(const std::string& incarnation,
                    ReadCurrent read_current,
                    Rpc rpc,
                    Decode decoded_size,
                    Save save,
                    RetryUnit::Clock::time_point now = RetryUnit::Clock::now()) {
    for (auto cleanup = cleanup_.begin(); cleanup != cleanup_.end();) {
      if (cleanup->incarnation != incarnation) {
        cleanup = cleanup_.erase(cleanup);
        continue;
      }
      if (cleanup->retry.Ready(now)) {
        Result<Json> result = rpc({{"method", "navigation.transfer.cancel"},
                                   {"view", cleanup->view},
                                   {"transfer", cleanup->transfer}});
        if (result || result.error().code == ErrorCode::kNotFound) {
          cleanup->retry.Success();
          cleanup_.erase(cleanup);
        } else {
          cleanup->retry.Fail(result.error(), now);
        }
        return {};
      }
      ++cleanup;
    }
    if (!task_) {
      if (candidates_.empty())
        return {};
      auto selected = candidates_.upper_bound(cursor_);
      for (size_t i = 0; i < candidates_.size(); ++i) {
        if (selected == candidates_.end())
          selected = candidates_.begin();
        if (retries_.at(selected->first).Ready(now))
          break;
        ++selected;
      }
      if (selected == candidates_.end() || !retries_.at(selected->first).Ready(now))
        return {};
      cursor_ = selected->first;
      task_ = Task{selected->first, {}, selected->second};
    }
    auto& task = *task_;
    auto& retry = retries_.at(task.view);
    if (!retry.Ready(now))
      return retry.Status() == RetryUnit::State::kWaiting ? Result<void>{}
                                                          : Result<void>{*retry.Failure()};
    const auto command = [&](const char* method) {
      Json request = {{"method", method}, {"view", task.view}};
      if (!task.transfer.empty())
        request["transfer"] = task.transfer;
      return request;
    };
    const auto cancel = [&]() -> Result<void> {
      if (!task.transfer.empty()) {
        Result<Json> canceled = rpc(command("navigation.transfer.cancel"));
        if (!canceled && canceled.error().code != ErrorCode::kNotFound)
          return canceled.error();
        task.transfer.clear();
      }
      return {};
    };
    const auto fail = [&](Error error) -> Result<void> {
      retry.Fail(error, now);
      if (retry.Status() == RetryUnit::State::kFaulted ||
          retry.Status() == RetryUnit::State::kDropped) {
        if (!task.transfer.empty()) {
          RetireTransfer(task.identity.incarnation, task.view, task.transfer);
        }
        candidates_.erase(task.view);
        task_.reset();
      }
      return error;
    };
    Result<Json> observed = read_current(task.view);
    if (!observed)
      return fail(observed.error());
    const auto current = std::move(observed).value();
    const auto identity = current.is_object() ? Identify(current, incarnation) : std::nullopt;
    const auto candidate = candidates_.find(task.view);
    if (candidate == candidates_.end() || !identity || *identity != task.identity ||
        candidate->second != task.identity) {
      auto canceled = cancel();
      if (!canceled)
        return fail(canceled.error());
      // Keep a newly observed revision for a later turn.
      if (candidate != candidates_.end() && candidate->second == task.identity)
        candidates_.erase(candidate);
      task_.reset();
      return {};
    }
    if (task.transfer.empty()) {
      Result<Json> response = rpc(
          command(task.begin_unknown ? "navigation.transfer.status" : "navigation.export.begin"));
      if (!response) {
        if (response.error().code == ErrorCode::kOutcomeUnknown)
          task.begin_unknown = true;
        return fail(response.error());
      }
      auto begin = std::move(response).value();
      task.transfer = begin.at("transfer").template get<std::string>();
      const auto size = begin.at("size").template get<std::string>();
      const auto [end, error] = std::from_chars(size.data(), size.data() + size.size(), task.size);
      if (error != std::errc{} || end != size.data() + size.size())
        return fail(Error{ErrorCode::kInternal, "invalid navigation export size"});
      if (!task.size || task.size > 64 * 1024 * 1024)
        return fail(Error{ErrorCode::kInternal, "Invalid navigation export size"});
      if (begin.contains("navigationRevision") &&
          begin.at("navigationRevision") != task.identity.revision)
        return fail(Error{ErrorCode::kConflict, "Navigation export revision changed"});
      return {};
    }
    if (task.offset < task.size) {
      const auto count = std::min<uint64_t>(task.size - task.offset, 256 * 1024);
      auto request = command("navigation.export.chunk");
      request["offset"] = std::to_string(task.offset);
      request["length"] = count;
      Result<Json> response = rpc(request);
      if (!response)
        return fail(response.error());
      auto chunk = std::move(response).value();
      const auto data = chunk.at("data").template get<std::string>();
      if (decoded_size(data) != count)
        return fail(Error{ErrorCode::kInternal, "navigation export chunk length mismatch"});
      task.chunks.push_back({{"data", data}, {"bytes", count}});
      task.offset += count;
      return {};
    }
    // This turn freshly revalidated identity after the final chunk. Publish only
    // a complete snapshot; cancellation and failures preserve the previous file.
    if (!task.saved) {
      auto saved = save(task.view, Json{{"size", std::to_string(task.size)},
                                        {"chunks", task.chunks},
                                        {"navigationRevision", task.identity.revision}});
      if (!saved)
        return fail(saved.error());
      task.saved = true;
    }
    auto canceled = cancel();
    if (!canceled)
      return fail(canceled.error());
    retry.Success();
    candidates_.erase(task.view);
    task_.reset();
    return {};
  }
};
}  // namespace remotekit
