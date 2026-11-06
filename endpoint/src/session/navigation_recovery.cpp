#include "session/navigation_recovery.hpp"
#include "util/file_io.hpp"
#include "diagnostics/timing.hpp"
#include "session/views.hpp"
namespace remotekit {
using ConnectionPhase = ConnectionTiming::ConnectionPhase;

const char* NavigationRecovery::Recovery::PhaseName() const {
  switch (phase) {
    case Phase::kLoad:
      return "load";
    case Phase::kSettling:
      return "settling";
    case Phase::kUnload:
      return "unload";
    case Phase::kBegin:
      return "begin";
    case Phase::kChunks:
      return "chunks";
    case Phase::kCommit:
      return "commit";
    case Phase::kRestore:
      return "restore";
    case Phase::kWaiting:
      return "waiting";
    case Phase::kVisible:
      return "visible";
    case Phase::kComplete:
      return "complete";
    case Phase::kFallback:
      return "fallback";
    case Phase::kFallbackStarted:
      return "fallback_started";
    case Phase::kFailed:
      return "failed";
  }
  return "failed";
}

void NavigationRecovery::FailRecovery(const std::string& view, Recovery& task, const Error& error) {
  fprintf(stderr, "session %s view %s navigation recovery: %s\n", id.c_str(), view.c_str(),
          error.message.c_str());
  task.error = error.message;
  task.saved = nullptr;
  task.buffer_bytes = 0;
  task.phase = task.phase == Recovery::Phase::kFallback ? Recovery::Phase::kFailed
                                                        : Recovery::Phase::kFallback;
}

bool NavigationRecovery::Recovering(const std::string& view) const {
  const auto found = recoveries.find(view);
  return found != recoveries.end() && found->second.Pending();
}

Json NavigationRecovery::RecoveryStatus(const Recovery& recovery) const {
  return {
      {"pending", recovery.Pending()}, {"phase", recovery.PhaseName()}, {"error", recovery.error}};
}

Json NavigationRecovery::RecoverySnapshot() const {
  Json views = Json::object();
  bool pending = false;
  for (const auto& [view, recovery] : recoveries) {
    views[view] = RecoveryStatus(recovery);
    pending |= recovery.Pending();
  }
  return {{"pending", pending},
          {"views", std::move(views)},
          {"exportPending", navigation_export.Pending()}};
}

bool NavigationRecovery::CancelRecovery(const std::string& view) {
  auto found = recoveries.find(view);
  if (found == recoveries.end())
    return false;
  const bool pending = found->second.Pending();
  const auto transfer = found->second.transfer;
  recoveries.erase(found);
  recovery_revisions.erase(view);
  if (!transfer.empty() && browser.Rpc().Control()) {
    {
      {
        auto navigation_transfer_cancel_result =
            browser.Rpc().Request({{"method", "navigation.transfer.cancel"},
                                   {"session", id},
                                   {"view", view},
                                   {"transfer", transfer}});
        if (!navigation_transfer_cancel_result) {
          const Error error = navigation_transfer_cancel_result.error();
          fprintf(stderr, "recovery transfer cancel: %s\n", error.message.c_str());
        }
      }
    }
  }
  return pending;
}

void NavigationRecovery::MaintainRecovery() {
  if (browser.Initialized() && browser.Alive() && !browser.Stopping() &&
      scavenged_incarnation != browser.Incarnation() &&
      std::all_of(recoveries.begin(), recoveries.end(),
                  [](const auto& item) { return !item.second.Pending(); })) {
    auto scavenged = browser.Rpc().Request({{"method", "storage.scavenge"}});
    if (scavenged)
      scavenged_incarnation = browser.Incarnation();
  }
  // Alternate with restore/reconciliation so neither bulk direction starves
  // another Session or the normal JSONL dispatcher.
  export_turn = !export_turn;
  if (export_turn && navigation_export.Pending() && browser.Alive() && browser.Rpc().Control() &&
      !browser.Stopping()) {
    MaintainNavigationExport();
    return;
  }
  if (views.ReconciliationDue() && browser.Alive() && browser.Rpc().Control() &&
      !browser.Stopping()) {
    {
      {
        auto reconcile_output_result_2 = views.ReconcileOutput();
        if (!reconcile_output_result_2) {
          const Error error = reconcile_output_result_2.error();
          fprintf(stderr, "session %s reconciliation: %s\n", id.c_str(), error.message.c_str());
          return;
        }
      }
    }

    return;
  }
  if (recoveries.empty() || !browser.Alive() || !browser.Rpc().Control() || browser.Stopping())
    return;
  auto selected = recoveries.upper_bound(recovery_cursor);
  const auto now = QpcNow();
  for (size_t count = 0; count < recoveries.size(); ++count) {
    if (selected == recoveries.end())
      selected = recoveries.begin();
    if (selected->second.Pending() && selected->second.next_poll <= now)
      break;
    ++selected;
  }
  if (selected == recoveries.end() || !selected->second.Pending() ||
      selected->second.next_poll > now)
    return;
  const auto view = selected->first;
  recovery_cursor = view;
  auto& task = selected->second;
  if (!views.Contains(view)) {
    CancelRecovery(view);
    return;
  }
  {
    if (task.phase == Recovery::Phase::kLoad) {
      const auto path = directory / fs::path("recovery") / (view + ".json");
      auto size_result = FileSize(path);
      if (!size_result) {
        FailRecovery(view, task, size_result.error());
        return;
      }
      const auto file_bytes = size_result.value();
      if (file_bytes > 96 * 1024 * 1024) {
        Error error{ErrorCode::kRejected, "navigation recovery file exceeds bound"};
        FailRecovery(view, task, error);
        return;
      };
      uint64_t buffered = 0;
      for (const auto& [key, recovery] : recoveries)
        buffered += recovery.buffer_bytes;
      if (buffered + file_bytes > 96 * 1024 * 1024) {
        task.next_poll = now + QpcFrequency() / 20;
        return;
      }
      task.saved = store.Load(path);
      const auto size = std::stoull(task.saved.at("size").get<std::string>());
      if (!size || size > 64 * 1024 * 1024 || !task.saved.at("chunks").is_array() ||
          task.saved["chunks"].size() > 256) {
        Error error{ErrorCode::kRejected, "invalid navigation recovery size/chunks"};
        FailRecovery(view, task, error);
        return;
      };
      task.buffer_bytes = file_bytes;
      task.phase = Recovery::Phase::kSettling;
      task.deadline = now + QpcFrequency();
    } else if (task.phase == Recovery::Phase::kSettling ||
               task.phase == Recovery::Phase::kWaiting) {
      auto browser_snapshot_result = browser.Snapshot();
      if (!browser_snapshot_result) {
        const Error error = browser_snapshot_result.error();
        FailRecovery(view, task, error);
        return;
      }
      const auto snapshot = std::move(browser_snapshot_result).value();
      const Json* current = nullptr;
      for (const auto& session : snapshot.at("sessions"))
        for (const auto& candidate : session.at("views"))
          if (candidate.value("view", std::string()) == view)
            current = &candidate;
      if (!current || current->value("close_state", std::string()) == "closed") {
        CancelRecovery(view);
        return;
      }
      if (task.phase == Recovery::Phase::kSettling) {
        if (!current->value("loading", false) || now >= task.deadline)
          task.phase = Recovery::Phase::kUnload;
      } else if (!current->value("pending", true)) {
        const auto last = current->value("last_lifecycle", Json::object());
        if (current->value("actual", -1) != 0 || !last.value("succeeded", false)) {
          Error error{ErrorCode::kRejected,
                      last.value("detail", std::string("navigation recovery failed"))};
          FailRecovery(view, task, error);
          return;
        };
        task.phase = Recovery::Phase::kVisible;
      } else if (now >= task.deadline) {
        Error error{ErrorCode::kRejected, "navigation recovery did not finish"};
        FailRecovery(view, task, error);
        return;
      };
      task.next_poll = now + QpcFrequency() / 20;
    } else if (task.phase == Recovery::Phase::kUnload) {
      {
        auto lifecycle_result = browser.Rpc().Request(
            {{"method", "lifecycle"}, {"session", id}, {"view", view}, {"action", "unload"}});
        if (!lifecycle_result) {
          const Error error = lifecycle_result.error();
          FailRecovery(view, task, error);
          return;
        }
      }
      task.phase = Recovery::Phase::kBegin;
    } else if (task.phase == Recovery::Phase::kBegin) {
      auto navigation_import_begin_result =
          browser.Rpc().Request({{"method", "navigation.import.begin"},
                                 {"session", id},
                                 {"view", view},
                                 {"size", task.saved.at("size")}});
      if (!navigation_import_begin_result) {
        const Error error = navigation_import_begin_result.error();
        FailRecovery(view, task, error);
        return;
      }
      auto reply = std::move(navigation_import_begin_result).value();
      task.transfer = reply.at("transfer");
      task.phase = Recovery::Phase::kChunks;
    } else if (task.phase == Recovery::Phase::kChunks) {
      if (task.chunk == task.saved.at("chunks").size()) {
        task.phase = Recovery::Phase::kCommit;
        return;
      }
      const auto& chunk = task.saved["chunks"][task.chunk];
      const auto bytes = chunk.at("bytes").get<uint64_t>();
      if (!bytes || bytes > 256 * 1024 ||
          DecodedSize(chunk.at("data").get<std::string>()) != bytes) {
        Error error{ErrorCode::kRejected, "invalid navigation recovery chunk"};
        FailRecovery(view, task, error);
        return;
      };
      {
        auto navigation_import_chunk_result =
            browser.Rpc().Request({{"method", "navigation.import.chunk"},
                                   {"session", id},
                                   {"view", view},
                                   {"transfer", task.transfer},
                                   {"offset", std::to_string(task.offset)},
                                   {"data", chunk.at("data")}});
        if (!navigation_import_chunk_result) {
          const Error error = navigation_import_chunk_result.error();
          FailRecovery(view, task, error);
          return;
        }
      }
      task.offset += bytes;
      ++task.chunk;
    } else if (task.phase == Recovery::Phase::kCommit) {
      {
        auto navigation_import_commit_result =
            browser.Rpc().Request({{"method", "navigation.import.commit"},
                                   {"session", id},
                                   {"view", view},
                                   {"transfer", task.transfer}});
        if (!navigation_import_commit_result) {
          const Error error = navigation_import_commit_result.error();
          FailRecovery(view, task, error);
          return;
        }
      }
      task.transfer.clear();
      task.saved = nullptr;
      task.buffer_bytes = 0;
      task.phase = Recovery::Phase::kRestore;
    } else if (task.phase == Recovery::Phase::kRestore) {
      {
        auto lifecycle_result_2 = browser.Rpc().Request(
            {{"method", "lifecycle"}, {"session", id}, {"view", view}, {"action", "restore"}});
        if (!lifecycle_result_2) {
          const Error error = lifecycle_result_2.error();
          FailRecovery(view, task, error);
          return;
        }
      }
      task.phase = Recovery::Phase::kWaiting;
      task.deadline = now + QpcFrequency() * 11;
    } else if (task.phase == Recovery::Phase::kVisible) {
      task.phase = Recovery::Phase::kComplete;
      {
        {
          auto reconcile_output_result_3 = views.ReconcileOutput();
          if (!reconcile_output_result_3) {
            const Error error = reconcile_output_result_3.error();
            task.error = error.message.c_str();
            return;
          }
        }
      }

    } else if (task.phase == Recovery::Phase::kFallback) {
      // Fresh GET of the product URL, never automatic replay of imported POST.
      {
        auto view_recreate_result = browser.Rpc().Request(
            {{"method", "view.recreate"},
             {"session", id},
             {"view", view},
             {"url", views.Desired(view).value("url", std::string("about:blank"))}});
        if (!view_recreate_result) {
          const Error error = view_recreate_result.error();
          FailRecovery(view, task, error);
          return;
        }
      }
      task.saved = nullptr;
      task.buffer_bytes = 0;
      task.transfer.clear();
      task.phase = Recovery::Phase::kFallbackStarted;
      {
        {
          auto reconcile_output_result_4 = views.ReconcileOutput();
          if (!reconcile_output_result_4) {
            const Error error = reconcile_output_result_4.error();
            task.error += "; output reconciliation: " + std::string(error.message.c_str());
            return;
          }
        }
      }
    }
  }
}

void NavigationRecovery::CaptureNavigation(const Json& browser_view) {
  const auto view = browser_view.at("view").get<std::string>();
  const auto revision = browser_view.value("navigationRevision", std::string());
  const auto saved = recovery_revisions.find(view);
  navigation_export.Observe(browser_view, browser.Incarnation(),
                            views.Contains(view) && !Recovering(view) &&
                                (saved == recovery_revisions.end() || saved->second != revision));
}

void NavigationRecovery::MaintainNavigationExport() {
  auto saved = ExportTick();
  if (!saved)
    fprintf(stderr, "navigation save: %s\n", saved.error().message.c_str());
}
Result<void> NavigationRecovery::ExportTick(uint32_t timeout_ms) {
  return navigation_export.Tick(
      browser.Incarnation(),
      [&](const std::string& view) -> Result<Json> {
        auto snapshot = browser.Rpc().Request({{"method", "snapshot"}}, 0, timeout_ms);
        if (!snapshot)
          return snapshot.error();
        for (const auto& session : snapshot.value().at("sessions"))
          for (const auto& item : session.at("views"))
            if (item.value("view", std::string()) == view && views.Contains(view) &&
                !Recovering(view))
              return item;
        return Json(nullptr);
      },
      [&](Json command) {
        command["session"] = id;
        return browser.Rpc().Request(std::move(command), 0, timeout_ms);
      },
      [](const std::string& data) { return DecodedSize(data); },
      [&](const std::string& view, const Json& saved) -> Result<void> {
        auto committed = store.Save(fs::path("recovery") / (view + ".json"), saved);
        if (!committed)
          return committed.error();
        recovery_revisions[view] = saved.at("navigationRevision").get<std::string>();
        return {};
      });
}
Result<void> NavigationRecovery::FinalExport() {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(20);
  auto snapshot = browser.Rpc().Request({{"method", "snapshot"}}, 0, 1000);
  if (!snapshot)
    return snapshot.error();
  for (const auto& session : snapshot.value().at("sessions"))
    for (const auto& view : session.at("views")) {
      const auto name = view.at("view").get<std::string>();
      if (!views.Contains(name))
        continue;
      if (Recovering(name) || view.value("loading", false) || view.value("pending", false) ||
          view.value("lifecycle_uncertain", false))
        return Error{ErrorCode::kUnavailable, "navigation state is unsettled at shutdown"};
      CaptureNavigation(view);
    }
  while (navigation_export.Pending()) {
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
                               deadline - std::chrono::steady_clock::now())
                               .count();
    if (remaining <= 0)
      return Error{ErrorCode::kUnavailable, "final navigation export exceeded 20 seconds"};
    auto saved = ExportTick(static_cast<uint32_t>(std::min<int64_t>(remaining / 3 + 1, 1000)));
    if (!saved)
      return saved.error();
  }
  return {};
}
}  // namespace remotekit

namespace remotekit {

void NavigationRecovery::Reset() {
  navigation_export.Clear();
  recoveries.clear();
  recovery_cursor.clear();
  recovery_revisions.clear();
  scavenged_incarnation.clear();
}
void NavigationRecovery::Begin(const std::string& view) {
  recoveries[view] = Recovery{};
}
void NavigationRecovery::Forget(const std::string& view) {
  navigation_export.Forget(view);
  recoveries.erase(view);
  recovery_revisions.erase(view);
}
void NavigationRecovery::EraseRevision(const std::string& view) {
  recovery_revisions.erase(view);
}
Json NavigationRecovery::ViewStatus(const std::string& view) const {
  return RecoveryStatus(recoveries.at(view));
}
void NavigationRecovery::Annotate(const std::string& view, Json& item) const {
  const auto found = recoveries.find(view);
  if (found == recoveries.end())
    return;
  item["recovery"] = RecoveryStatus(found->second);
  item["browserPending"] = item.value("pending", false);
  item["pending"] = item.value("pending", false) || found->second.Pending();
  if (found->second.Pending()) {
    item["browserDesired"] = item["desired"];
    item["desired"] = 0;
  }
}

}  // namespace remotekit
