#pragma once
#include "util/error.hpp"
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
    std::chrono::steady_clock::time_point deadline =
        std::chrono::steady_clock::now() + std::chrono::seconds(60);
  };
  std::map<std::string, Identity> candidates_;
  std::optional<Task> task_;
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
    task_.reset();
    cursor_.clear();
  }
  void Forget(const std::string& view) { candidates_.erase(view); }
  bool Pending() const { return task_.has_value() || !candidates_.empty(); }
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
  }
  // ReadCurrent returns a fresh view (or null), including Browser incarnation
  // captured by the caller. Browser requests serialize with input via Rpc.
  template <class ReadCurrent, class Rpc, class Decode, class Save>
  Result<void> Tick(const std::string& incarnation,
                    ReadCurrent read_current,
                    Rpc rpc,
                    Decode decoded_size,
                    Save save) {
    if (!task_) {
      if (candidates_.empty())
        return {};
      auto selected = candidates_.upper_bound(cursor_);
      if (selected == candidates_.end())
        selected = candidates_.begin();
      cursor_ = selected->first;
      task_ = Task{selected->first, {}, selected->second};
    }
    auto& task = *task_;
    const auto command = [&](const char* method) {
      Json request = {{"method", method}, {"view", task.view}};
      if (!task.transfer.empty())
        request["transfer"] = task.transfer;
      return request;
    };
    const auto cancel = [&] {
      if (!task.transfer.empty())
        rpc(command("navigation.transfer.cancel"));
    };
    const auto fail = [&](Error error) -> Result<void> {
      cancel();
      candidates_.erase(task.view);
      task_.reset();
      return error;
    };

    if (std::chrono::steady_clock::now() >= task.deadline)
      return fail(Error{ErrorCode::kUnavailable, "navigation export deadline exceeded"});
    Result<Json> observed = read_current(task.view);
    if (!observed)
      return fail(observed.error());
    const auto current = std::move(observed).value();
    const auto identity = current.is_object() ? Identify(current, incarnation) : std::nullopt;
    const auto candidate = candidates_.find(task.view);
    if (candidate == candidates_.end() || !identity || *identity != task.identity ||
        candidate->second != task.identity) {
      cancel();
      // Keep a newly observed revision for a later turn.
      if (candidate != candidates_.end() && candidate->second == task.identity)
        candidates_.erase(candidate);
      task_.reset();
      return {};
    }
    if (task.transfer.empty()) {
      Result<Json> response = rpc(command("navigation.export.begin"));
      if (!response)
        return fail(response.error());
      auto begin = std::move(response).value();
      task.transfer = begin.at("transfer").template get<std::string>();
      const auto size = begin.at("size").template get<std::string>();
      const auto [end, error] = std::from_chars(size.data(), size.data() + size.size(), task.size);
      if (error != std::errc{} || end != size.data() + size.size())
        return fail(Error{ErrorCode::kInternal, "invalid navigation export size"});
      if (!task.size || task.size > 64 * 1024 * 1024)
        return fail(Error{ErrorCode::kInternal, "Invalid navigation export size"});
      if (begin.at("navigationRevision") != task.identity.revision)
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
    cancel();
    task.transfer.clear();
    auto saved = save(task.view, Json{{"size", std::to_string(task.size)},
                                      {"chunks", std::move(task.chunks)},
                                      {"navigationRevision", task.identity.revision}});
    if (!saved)
      return fail(saved.error());
    candidates_.erase(task.view);
    task_.reset();
    return {};
  }
};
}  // namespace remotekit
