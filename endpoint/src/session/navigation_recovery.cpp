#include "util/log.hpp"
#include "session/navigation_recovery.hpp"
#include "util/file_io.hpp"
#include "diagnostics/timing.hpp"
#include "session/views.hpp"
#include "util/error_policy.hpp"
#include "util/wire_error.hpp"
#include "persistence/phase_timing.hpp"
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
    case Phase::kReplacementUnknown:
      return "replacement_unknown";
    case Phase::kFailed:
      return "failed";
  }
  return "failed";
}

void NavigationRecovery::FailRecovery(const std::string& view, Recovery& task, const Error& error) {
  task.retry.Input(browser.Incarnation() + ":" + view);
  task.retry.Fail(error);
  task.error = error;
  if (task.retry.Status() == RetryUnit::State::kWaiting) {
    task.reconcile = task.retry.Reconcile() || task.retry.Refresh();
    return;
  }
  task.phase = Recovery::Phase::kFailed;
}

bool NavigationRecovery::Recovering(const std::string& view) const {
  const auto found = recoveries.find(view);
  return found != recoveries.end() && found->second.Pending();
}
bool NavigationRecovery::NeedsReplacement(const std::string& view) const {
  const auto found = recoveries.find(view);
  return found != recoveries.end() && found->second.phase != Recovery::Phase::kComplete;
}

Json NavigationRecovery::RecoveryStatus(const Recovery& recovery) const {
  return {{"pending", recovery.Pending()},
          {"phase", recovery.PhaseName()},
          {"error", recovery.error ? WireError(*recovery.error) : Json(nullptr)}};
}

Json NavigationRecovery::RecoverySnapshot() const {
  Json views = navigation_export.Failures();
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
  navigation_export.RetireTransfer(browser.Incarnation(), view, transfer);
  return pending;
}

void NavigationRecovery::MaintainRecovery() {
  scavenge_retry_.Input(browser.Incarnation());
  if (browser.Initialized() && browser.Alive() && !browser.Stopping() &&
      scavenged_incarnation != browser.Incarnation() && scavenge_retry_.Ready() &&
      std::all_of(recoveries.begin(), recoveries.end(),
                  [](const auto& item) { return !item.second.Pending(); })) {
    auto scavenged = browser.Rpc().Request({{"method", "storage.scavenge"}});
    if (scavenged) {
      scavenged_incarnation = browser.Incarnation();
      scavenge_retry_.Success();
    } else {
      scavenge_retry_.Fail(scavenged.error());
    }
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
          LogError(LogLevel::kWarn, "session.reconcile_failed", error, {{"sessionId", id}});
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
    if (selected->second.Pending() && selected->second.retry.Ready() &&
        selected->second.next_poll <= now)
      break;
    ++selected;
  }
  if (selected == recoveries.end() || !selected->second.Pending() ||
      !selected->second.retry.Ready() || selected->second.next_poll > now)
    return;
  const auto view = selected->first;
  recovery_cursor = view;
  auto& task = selected->second;
  if (!views.Contains(view)) {
    CancelRecovery(view);
    return;
  }
  try {
    if (task.reconcile) {
      const bool transfer_stage = task.phase == Recovery::Phase::kBegin ||
                                  task.phase == Recovery::Phase::kChunks ||
                                  task.phase == Recovery::Phase::kCommit;
      if (transfer_stage) {
        auto status = browser.Rpc().Request(
            {{"method", "navigation.transfer.status"}, {"session", id}, {"view", view}});
        if (!status) {
          FailRecovery(view, task, status.error());
          return;
        }
        const auto& result = status.value();
        if (!result.value("importing", false) || result.at("size") != task.saved.at("size")) {
          FailRecovery(view, task, {ErrorCode::kNotFound, "navigation import identity changed"});
          return;
        }
        const auto received = std::stoull(result.at("received").get<std::string>());
        task.transfer = result.at("transfer");
        if (task.phase == Recovery::Phase::kBegin) {
          task.phase = Recovery::Phase::kChunks;
        } else if (task.phase == Recovery::Phase::kChunks) {
          const auto bytes = task.saved.at("chunks").at(task.chunk).at("bytes").get<uint64_t>();
          if (received == task.offset + bytes) {
            task.offset += bytes;
            ++task.chunk;
          } else if (received != task.offset) {
            FailRecovery(view, task,
                         {ErrorCode::kInternal, "navigation import offset is inconsistent"});
            return;
          } else {
            task.reconcile = false;
            return;
          }
        } else if (result.value("committed", false)) {
          task.phase = Recovery::Phase::kRestore;
          task.saved = nullptr;
          task.buffer_bytes = 0;
        } else {
          task.reconcile = false;
          return;
        }
      } else if (task.phase == Recovery::Phase::kUnload ||
                 task.phase == Recovery::Phase::kRestore ||
                 task.phase == Recovery::Phase::kWaiting ||
                 task.phase == Recovery::Phase::kReplacementUnknown) {
        auto snapshot = browser.Snapshot();
        if (!snapshot) {
          FailRecovery(view, task, snapshot.error());
          return;
        }
        const Json* current = nullptr;
        for (const auto& session : snapshot.value().at("sessions"))
          for (const auto& candidate : session.at("views"))
            if (candidate.value("view", std::string()) == view)
              current = &candidate;
        if (!current) {
          FailRecovery(view, task, {ErrorCode::kNotFound, "navigation recovery view disappeared"});
          return;
        }
        if (current->value("pending", false) || current->value("lifecycle_uncertain", false)) {
          task.next_poll = now + QpcFrequency() / 4;
          return;
        }
        if (task.phase == Recovery::Phase::kUnload && current->value("actual", -1) == 3)
          task.phase = Recovery::Phase::kBegin;
        else if (task.phase == Recovery::Phase::kRestore && current->value("actual", -1) == 0) {
          task.phase = Recovery::Phase::kWaiting;
          task.deadline = now + QpcFrequency() * 11;
        } else if (task.phase == Recovery::Phase::kWaiting && current->value("actual", -1) == 0) {
          const auto last = current->value("last_lifecycle", Json::object());
          if (!last.value("succeeded", false)) {
            FailRecovery(view, task, ParseWireError(last.value("error", Json())));
            return;
          }
          task.phase = Recovery::Phase::kVisible;
        } else if (task.phase == Recovery::Phase::kReplacementUnknown &&
                   current->value("actual", -1) == 0)
          task.phase = Recovery::Phase::kComplete;
        else {
          if (task.retry.Refresh())
            task.reconcile = false;
          else
            FailRecovery(
                view, task,
                {ErrorCode::kOutcomeUnknown, "navigation lifecycle completion is unknown"});
          return;
        }
      }
      task.reconcile = false;
      task.retry.Success();
      return;
    }
    if (task.phase == Recovery::Phase::kLoad) {
      auto saved = recovery_store.Load(view);
      if (!saved) {
        FailRecovery(view, task, saved.error());
        return;
      }
      const auto file_bytes = saved.value().dump().size();
      uint64_t buffered = 0;
      for (const auto& [key, recovery] : recoveries)
        buffered += recovery.buffer_bytes;
      if (buffered + file_bytes > 96 * 1024 * 1024) {
        task.next_poll = now + QpcFrequency() / 20;
        return;
      }
      task.saved = std::move(saved).value();
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
          Error error = ParseWireError(last.value("error", Json()));
          FailRecovery(view, task, error);
          return;
        };
        task.phase = Recovery::Phase::kVisible;
      } else if (now >= task.deadline) {
        Error error{ErrorCode::kOutcomeUnknown, "navigation recovery did not finish"};
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
        Error error{ErrorCode::kInternal, "invalid navigation recovery chunk"};
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
      {
        {
          auto reconcile_output_result_3 = views.ReconcileOutput();
          if (!reconcile_output_result_3) {
            const Error error = reconcile_output_result_3.error();
            task.error = error;
            FailRecovery(view, task, error);
            return;
          }
        }
      }

      task.phase = Recovery::Phase::kComplete;
    }
    task.retry.Success();
    task.error.reset();
  } catch (const std::exception& error) {
    FailRecovery(view, task,
                 CorruptState(std::string("invalid navigation recovery: ") + error.what()));
  }
}

Result<void> NavigationRecovery::CaptureNavigation(const Json& browser_view) try {
  const auto view = browser_view.at("view").get<std::string>();
  const auto revision = browser_view.value("navigationRevision", std::string());
  const auto saved = recovery_revisions.find(view);
  navigation_export.Observe(browser_view, browser.Incarnation(),
                            views.Contains(view) && !Recovering(view) &&
                                (saved == recovery_revisions.end() || saved->second != revision));
  return {};
} catch (const std::exception& error) {
  return CorruptState(std::string("invalid navigation snapshot: ") + error.what());
}

void NavigationRecovery::MaintainNavigationExport() {
  auto saved = ExportTick();
  if (!saved)
    return;
}
Result<void> NavigationRecovery::ExportTick(uint32_t timeout_ms) try {
  const auto start = PhaseClock::now();
  const auto selected_view = navigation_export.NextView();
  auto result = navigation_export.Tick(
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
        auto committed = recovery_store.Save(view, saved);
        if (!committed)
          return committed.error();
        recovery_revisions[view] = saved.at("navigationRevision").get<std::string>();
        return {};
      });
  if (final_exporting_ && !selected_view.empty()) {
    auto& view = final_export_timing_["views"][selected_view];
    if (!view.is_object())
      view = Json::object();
    view["ms"] = view.value("ms", 0.0) + PhaseMs(start);
    view["requests"] = view.value("requests", 0) + 1;
  }
  return result;
} catch (const std::exception& error) {
  return CorruptState(std::string("invalid navigation export: ") + error.what());
}
Result<void> NavigationRecovery::FinalExport() try {
  final_export_timing_ = {{"views", Json::object()}, {"count", 0}};
  final_exporting_ = true;
  struct Finish {
    bool& active;
    ~Finish() { active = false; }
  } finish{final_exporting_};
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
      final_export_timing_["views"][name] = {{"ms", 0.0}, {"requests", 0}};
      final_export_timing_["count"] = final_export_timing_["count"].get<size_t>() + 1;
      RK_RETURN_IF_ERROR(CaptureNavigation(view));
    }
  while (navigation_export.Pending()) {
    if (const auto error = navigation_export.TerminalFailure())
      return *error;
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
                               deadline - std::chrono::steady_clock::now())
                               .count();
    if (remaining <= 0)
      return Error{ErrorCode::kUnavailable, "final navigation export exceeded 20 seconds"};
    auto saved = ExportTick(static_cast<uint32_t>(std::min<int64_t>(remaining / 3 + 1, 1000)));
    if (!saved)
      return saved.error();
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  if (const auto error = navigation_export.TerminalFailure())
    return *error;
  return {};
} catch (const std::exception& error) {
  return CorruptState(std::string("invalid final navigation export: ") + error.what());
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
void NavigationRecovery::ReplacementUnknown(const std::string& view) {
  const auto found = recoveries.find(view);
  if (found == recoveries.end())
    return;
  auto& task = found->second;
  task.phase = Recovery::Phase::kReplacementUnknown;
  FailRecovery(view, task, {ErrorCode::kOutcomeUnknown, "view replacement completion is unknown"});
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
