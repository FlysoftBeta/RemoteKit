#pragma once
#include "persistence/session_db.hpp"
#include "util/result_macros.hpp"
#include "util/retry_unit.hpp"
#include "util/wire_error.hpp"
#include <algorithm>
#include <functional>
#include <set>

namespace remotekit {
// A result is persisted before the Browser loses its only copy. Control sees it
// only after Browser cleanup, and its acknowledgement retires the journal row.
class DownloadImports {
  friend class NativeRetryOwnerProbe;

 public:
  using Import = std::function<Result<Json>(const Json&)>;
  using Rpc = std::function<Result<Json>(Json)>;
  struct Store {
    using Load = std::function<Result<Json>()>;
    using Save = std::function<Result<void>(const Json&)>;
    using SaveFailure = std::function<
        Result<void>(const Json&, const Json&, const std::string&, const std::string&)>;
    using Complete = std::function<Result<void>(const std::string&)>;
    Load load;
    Save save;
    SaveFailure save_failure;
    Complete complete;
    Store(Load load, Save save, SaveFailure save_failure, Complete complete)
        : load(std::move(load)),
          save(std::move(save)),
          save_failure(std::move(save_failure)),
          complete(std::move(complete)) {}
    Store(DownloadStore store)
        : Store([store]() mutable { return store.Load(); },
                [store](const Json& state) mutable { return store.Save(state); },
                [store](const Json& state,
                        const Json& failure,
                        const std::string& id,
                        const std::string& incarnation) mutable {
                  return store.SaveFailure(state, failure, id, incarnation);
                },
                [store](const std::string& id) mutable { return store.Complete(id); }) {}
  };
  explicit DownloadImports(Store store, std::string build = {})
      : store_(store), build_(std::move(build)) {}
  Result<void> Initialize() {
    RK_ASSIGN_OR_RETURN(state, store_.load());
    state_ = std::move(state);
    retries_.clear();
    for (const auto& row : state_["records"]) {
      auto& retry = retries_.try_emplace(row.at("eventId").get<std::string>(), "download.import")
                        .first->second;
      if (row.contains("retry"))
        RK_RETURN_IF_ERROR(retry.Restore(row.at("retry")));
      if (!row.contains("retry") || row.at("retry").at("buildId") != build_)
        retry.Input(row.at("eventId").get<std::string>() +
                    (row.contains("result") ? ":cleanup:" : ":import:") + build_ + ":" + input_);
    }
    return {};
  }
  void SetImport(Import import) { import_ = std::move(import); }
  void SetInput(std::string input) { input_ = std::move(input); }
  size_t Pending() const { return state_["records"].size(); }
  Result<void> Observe(const std::string& incarnation,
                       const Json& events,
                       const std::string& session,
                       const Rpc& rpc) {
    persistence_retry_.Input(build_ + ":" + input_);
    if (!persistence_retry_.Ready())
      return *persistence_retry_.Failure();
    for (const auto& event : events) {
      if (event.value("type", std::string()) != "download.completed")
        continue;
      const auto guid = event.at("guid").get<std::string>();
      const bool known =
          std::any_of(state_["records"].begin(), state_["records"].end(), [&](const Json& row) {
            return row.at("incarnation") == incarnation && row.at("download").at("guid") == guid;
          });
      if (!known) {
        auto next = state_;
        next["records"].push_back({{"incarnation", incarnation},
                                   {"download", event},
                                   {"eventId", "download-" + incarnation + "-" + guid}});
        RK_RETURN_IF_ERROR(Save(std::move(next)));
      }
    }
    std::optional<Error> failure;
    for (size_t index = 0; index < state_["records"].size();) {
      auto row = state_["records"][index];
      const auto& download = row.at("download");
      const auto identity = row.at("eventId").get<std::string>();
      auto& retry = retries_.try_emplace(identity, "download.import").first->second;
      if (!input_.empty() || retry.Identity().empty())
        retry.Input(identity + (row.contains("result") ? ":cleanup:" : ":import:") + build_ + ":" +
                    input_);
      const auto report_fault = [&]() -> Result<void> {
        if (row.contains("retry") && row["retry"].value("reported", false) &&
            row["retry"].at("input") == retry.Identity())
          return {};
        auto& handoff =
            failure_handoffs_.try_emplace(identity, "download.failure_handoff").first->second;
        handoff.Input(retry.Identity());
        if (!handoff.Ready())
          return *handoff.Failure();
        row["retry"] = retry.Save();
        row["retry"]["buildId"] = build_;
        row["retry"]["reported"] = true;
        row["error"] = WireError(*retry.Failure());
        Json result{{"type", "download.failed"},
                    {"eventId", identity},
                    {"name", download.at("name")},
                    {"origin", download.at("origin")},
                    {"error", row.at("error")}};
        auto next = state_;
        next["records"][index] = row;
        const auto event_id = "download-failure-" +
                              std::to_string(std::hash<std::string>{}(identity + retry.Identity()));
        auto saved = store_.save_failure(next, result, event_id, row.at("incarnation"));
        if (!saved) {
          handoff.Fail(saved.error());
          return saved.error();
        }
        handoff.Success();
        state_ = std::move(next);
        return {};
      };
      if (retry.Status() == RetryUnit::State::kFaulted) {
        auto reported = report_fault();
        if (!reported)
          failure = reported.error();
        ++index;
        continue;
      }
      if (!retry.Ready()) {
        ++index;
        continue;
      }
      if (!row.contains("result")) {
        const auto imported =
            import_ ? import_(download)
                    : Result<Json>{Error{ErrorCode::kUnavailable, "download_import_unavailable"}};
        Json result = {{"eventId", row.at("eventId")},
                       {"name", download.at("name")},
                       {"origin", download.at("origin")}};
        if (imported) {
          retry.Success();
          result.update({{"type", "download.imported"},
                         {"assetId", imported.value().at("assetId")},
                         {"mimeType", imported.value().at("type")},
                         {"size", download.at("size")}});
        } else {
          const auto& error = imported.error();
          retry.Fail(error);
          if (retry.Status() == RetryUnit::State::kFaulted) {
            auto reported = report_fault();
            if (!reported)
              failure = reported.error();
            ++index;
            continue;
          }
          row["attempt"] = retry.Attempt();
          row["error"] = WireError(*retry.Failure());
          row["retry"] = retry.Save();
          row["retry"]["buildId"] = build_;
          row["retryAt"] = row["retry"]["retryAt"];
          auto next = state_;
          next["records"][index] = row;
          RK_RETURN_IF_ERROR(Save(std::move(next)));
          if (retry.Status() == RetryUnit::State::kWaiting) {
            ++index;
            continue;
          }
          result.update({{"type", "download.failed"}, {"error", WireError(error)}});
        }
        row["result"] = std::move(result);
        auto next = state_;
        next["records"][index] = row;
        RK_RETURN_IF_ERROR(Save(std::move(next)));
      }
      retry.Input(identity + ":cleanup:" + build_ + ":" + input_);
      auto cleanup = rpc({{"method", "profile.downloads"},
                          {"session", session},
                          {"command", {{"action", "remove"}, {"guid", download.at("guid")}}}});
      // A replaced Browser cannot hold an event from the retired incarnation.
      if (cleanup && row.at("incarnation") == incarnation)
        cleanup = rpc({{"method", "view.closed.ack"},
                       {"session", session},
                       {"browserIncarnation", incarnation},
                       {"views", Json::array()},
                       {"eventIds", Json::array({download.at("eventId")})}});
      Result<void> completed =
          cleanup ? store_.complete(row.at("eventId")) : Result<void>{cleanup.error()};
      if (!completed) {
        retry.Fail(completed.error());
        failure = *retry.Failure();
        row["retry"] = retry.Save();
        row["retry"]["buildId"] = build_;
        auto next = state_;
        next["records"][index] = row;
        RK_RETURN_IF_ERROR(Save(std::move(next)));
        ++index;
        continue;
      }
      retry.Success();
      state_["records"].erase(state_["records"].begin() + index);
      retries_.erase(identity);
    }
    if (failure)
      return *failure;
    return {};
  }

 private:
  Result<void> Save(Json next) {
    auto saved = store_.save(next);
    if (!saved) {
      persistence_retry_.Fail(saved.error());
      return saved.error();
    }
    persistence_retry_.Success();
    state_ = std::move(next);
    return {};
  }
  Store store_;
  Import import_;
  std::string build_, input_;
  std::map<std::string, RetryUnit> retries_;
  std::map<std::string, RetryUnit> failure_handoffs_;
  RetryUnit persistence_retry_{"download.persistence"};
  Json state_ = {{"records", Json::array()}};
};
}  // namespace remotekit
