#pragma once
#include "persistence/session_store.hpp"
#include "util/result_macros.hpp"
#include <algorithm>
#include <functional>
#include <set>

namespace remotekit {
// A result is persisted before the Browser loses its only copy. Control sees it
// only after Browser cleanup, and its acknowledgement retires the journal row.
class DownloadImports {
 public:
  using Import = std::function<Result<Json>(const Json&)>;
  using Rpc = std::function<Result<Json>(Json)>;
  explicit DownloadImports(SessionStore& store) : store_(store) {}
  void Initialize() {
    state_ = store_.Load("download-imports.json", {{"records", Json::array()}});
  }
  void SetImport(Import import) { import_ = std::move(import); }
  size_t Pending() const {
    return std::count_if(state_["records"].begin(), state_["records"].end(),
                         [](const Json& row) { return !row.value("browserAck", false); });
  }
  Json Events() const {
    Json events = Json::array();
    for (const auto& row : state_["records"])
      if (row.value("browserAck", false))
        events.push_back(row.at("result"));
    return events;
  }
  Result<void> Acknowledge(const std::set<std::string>& ids) {
    auto next = state_;
    auto& records = next["records"];
    records.erase(
        std::remove_if(records.begin(), records.end(),
                       [&](const Json& row) {
                         return row.value("browserAck", false) &&
                                ids.contains(row.at("result").at("eventId").get<std::string>());
                       }),
        records.end());
    return Save(std::move(next));
  }
  Result<void> Observe(const std::string& incarnation,
                       const Json& events,
                       const std::string& session,
                       const Rpc& rpc) {
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
                                   {"eventId", "download-" + incarnation + "-" + guid},
                                   {"browserAck", false}});
        RK_RETURN_IF_ERROR(Save(std::move(next)));
      }
    }
    for (size_t index = 0; index < state_["records"].size(); ++index) {
      auto row = state_["records"][index];
      if (row.value("browserAck", false))
        continue;
      const auto& download = row.at("download");
      if (!row.contains("result")) {
        if (!import_)
          return Error{ErrorCode::kUnavailable, "download_import_unavailable"};
        const auto imported = import_(download);
        Json result = {{"eventId", row.at("eventId")},
                       {"name", download.at("name")},
                       {"origin", download.at("origin")}};
        if (imported) {
          result.update({{"type", "download.imported"},
                         {"assetId", imported.value().at("assetId")},
                         {"mimeType", imported.value().at("type")},
                         {"size", download.at("size")}});
        } else {
          const auto& error = imported.error();
          std::string reason = "io_error";
          if (error.code == ErrorCode::kNotFound)
            reason = "file_missing";
          else if (error.code == ErrorCode::kLimitExceeded)
            reason = error.message == "file_too_large" ? "file_too_large" : "quota_exceeded";
          else if (error.code == ErrorCode::kInvalidRequest)
            reason = "invalid_download";
          else if (error.code == ErrorCode::kConflict)
            reason = "conflict";
          result.update({{"type", "download.failed"}, {"reason", reason}});
        }
        row["result"] = std::move(result);
        auto next = state_;
        next["records"][index] = row;
        RK_RETURN_IF_ERROR(Save(std::move(next)));
      }
      RK_RETURN_IF_ERROR(rpc({{"method", "profile.downloads"},
                              {"session", session},
                              {"command", {{"action", "remove"}, {"guid", download.at("guid")}}}}));
      // A replaced Browser cannot hold an event from the retired incarnation.
      if (row.at("incarnation") == incarnation)
        RK_RETURN_IF_ERROR(rpc({{"method", "view.closed.ack"},
                                {"session", session},
                                {"browserIncarnation", incarnation},
                                {"views", Json::array()},
                                {"eventIds", Json::array({download.at("eventId")})}}));
      row["browserAck"] = true;
      auto next = state_;
      next["records"][index] = std::move(row);
      RK_RETURN_IF_ERROR(Save(std::move(next)));
    }
    return {};
  }

 private:
  Result<void> Save(Json next) {
    RK_RETURN_IF_ERROR(store_.Save("download-imports.json", next));
    state_ = std::move(next);
    return {};
  }
  SessionStore& store_;
  Import import_;
  Json state_ = {{"records", Json::array()}};
};
}  // namespace remotekit
