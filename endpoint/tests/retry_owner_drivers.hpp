#pragma once
#include "native_retry_clock.hpp"
#include "session/navigation_export.hpp"
#include "files/download_imports.hpp"
#include "documents/object_documents.hpp"
#include "objects/service.hpp"
#include "rtc/dc_services.hpp"
#include "rtc/outbox.hpp"
#include "util/retry_clock.hpp"
#include "session/session.hpp"
#include "runtime_config_fixture.hpp"
#include "management/cluster_link.hpp"
#include "diagnostics/node_metrics.hpp"
#include "session/coordinator.hpp"
#include "service.hpp"
#include "coordination_fixture.hpp"
#include <fstream>
#include <cstring>
#include <atomic>
#include <functional>

namespace remotekit {
class NativeRetryOwnerProbe {
 public:
  static const RetryUnit& Export(const NavigationExport& owner, bool cleanup) {
    return cleanup ? owner.cleanup_.front().retry : owner.retries_.at("1");
  }
  static const RetryUnit& Download(const DownloadImports& owner) {
    return owner.retries_.begin()->second;
  }
  static const RetryUnit& DownloadPersistence(const DownloadImports& owner, bool handoff) {
    return handoff ? owner.failure_handoffs_.begin()->second : owner.persistence_retry_;
  }
  static auto Submit(documents::ObjectDocuments& owner) {
    return owner.Submit(std::string(64, 'a'), "tenant", {}, "text/plain");
  }
  static const RetryUnit& Document(const documents::ObjectDocuments& owner) {
    return owner.jobs_.begin()->second.retry;
  }
  static const RetryUnit& DocumentPersistence(const documents::ObjectDocuments& owner) {
    return owner.jobs_.begin()->second.persistence;
  }
  static const RetryUnit& Menu(const DirectServices& owner) { return owner.context_menu_retry_; }
  static void Maintain(DcFileServices& owner, const DcFileServices::Sweep& sweep, uint64_t epoch) {
    owner.Maintain(sweep, epoch);
  }
  static const RetryUnit& Maintenance(const DcFileServices& owner) {
    return owner.maintenance_retry_;
  }
  static const RetryUnit& Control(const ControlOutbox& owner) {
    return owner.pending_.front().retry;
  }
  static bool ControlRetired(const ControlOutbox& owner) { return owner.pending_.empty(); }
  static const RetryUnit& FileDelivery(const DcFileServices& owner) {
    return owner.outbox_.front().retry;
  }
  static bool FileRetired(const DcFileServices& owner) { return owner.outbox_.empty(); }
  static const RetryUnit& Surface(const DirectServices& owner) {
    return owner.delivery_retries_.begin()->second;
  }
  static void CacheSeed(CheckpointCache& owner, const fs::path& directory, bool claims) {
    owner.directory_ = LongPath(directory);
    if (claims) {
      const auto identity = CheckpointIdentity(directory / "file");
      if (!identity)
        throw std::runtime_error(identity.error().message);
      owner.staged_["file"] = {identity.value(),
                               {{std::string(64, 'a'), 1, 1, std::string(64, 'a')}}};
    } else {
      owner.next_refresh_ = PhaseClock::time_point::max();
      owner.watcher_.Prune(PhaseClock::now());
      DirectoryChanges changes;
      changes.paths["file"] = PhaseClock::now() - std::chrono::seconds(11);
      owner.watcher_.Merge(changes);
    }
  }
  static void CacheWait(CheckpointCache& owner) {
    if (owner.staging_.valid())
      owner.CompleteStaging(owner.staging_.get());
  }
  static void PreStageIdle(const objects::ObjectService& owner) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
    while (owner.staging_busy_.load()) {
      if (std::chrono::steady_clock::now() >= deadline)
        throw std::runtime_error("pre-stage queue did not release its worker");
      std::this_thread::yield();
    }
  }
  static void CacheJournal(CheckpointCache& owner,
                           const fs::path& directory,
                           const std::function<Result<void>()>& flush) {
    owner.directory_ = directory;
    owner.JournalTick(flush);
  }
  static void CacheQueue(CheckpointCache& owner,
                         const std::string& input,
                         const std::function<Result<void>()>& queue) {
    if (owner.QueueStaging(input, queue))
      owner.CompleteStaging({});
  }
  static Result<Json> ColdSweep(Service& owner,
                                uint64_t generation,
                                const std::function<Result<Json>()>& sweep) {
    return owner.SweepCold(generation, sweep);
  }
  static Result<Json> ColdDelete(Service& owner,
                                 uint64_t generation,
                                 const std::function<Result<bool>(const std::string&)>& remove) {
    owner.fenced_generation_ = generation;
    return owner.DeleteCold(false, remove);
  }
  static RetryUnit::Snapshot ColdState(const Service& owner, bool items) {
    return items ? RetryUnit::Snapshot(owner.cold_delete_retries_.begin()->second)
                 : RetryUnit::Snapshot(owner.cold_retry_);
  }
  static void Attach(SessionExecution& owner, std::shared_ptr<Session> session) {
    owner.runtime_.store(std::move(session));
  }
  static Result<void> ExecutionSample(SessionExecution& owner,
                                      const std::function<Result<Json>()>& sample) {
    return owner.Sample(sample);
  }
  static Result<void> ExecutionEvents(SessionExecution& owner,
                                      const std::function<Result<void>()>& deliver) {
    return owner.DeliverEvents(deliver);
  }
  static const RetryUnit& Cache(const CheckpointCache& owner, bool claims) {
    return claims ? owner.claims_retry_ : owner.staging_retries_.at("file");
  }
  static RetryUnit::Snapshot Source(const objects::ObjectService& owner) {
    return owner.source_retries_.begin()->second;
  }
  static std::optional<RetryUnit::Snapshot> Commit(const objects::ObjectService& owner) {
    std::shared_ptr<objects::ObjectService::CommitRetry> entry;
    {
      std::lock_guard lock(owner.commits_mutex_);
      if (owner.commit_retries_.empty())
        return {};
      entry = owner.commit_retries_.begin()->second;
    }
    std::lock_guard lock(entry->mutex);
    return entry->retry;
  }
  static Result<std::unique_ptr<cluster::Carrier>> Accept(
      objects::PeerServer& owner,
      const std::string& input,
      const std::function<Result<std::unique_ptr<cluster::Carrier>>()>& accept) {
    return owner.AcceptOne(input, accept);
  }
  static void Metrics(NodeMetrics& owner,
                      const std::string& input,
                      const std::function<Result<void>(Json)>& publish) {
    owner.Publish(input, [] { return Json{{"sessions", 0}}; }, publish);
  }
  static void Clipboard(Session& owner) { owner.pipeline.PollClipboard(); }
  static Result<void> FinalExport(Session& owner) { return owner.navigation.FinalExport(); }
  static const RetryUnit& FinalExportState(const Session& owner) {
    return owner.navigation.navigation_export.retries_.at("1");
  }
  static RetryUnit::Snapshot CoordinatorState(SessionCoordinator& owner, const std::string& loop) {
    std::optional<RetryUnit::Snapshot> result;
    const auto read = owner.Execute([&]() -> Result<Json> {
      if (loop == "session.convergence")
        result = owner.convergence_retry_;
      else if (loop == "session.maintenance")
        result = owner.maintenance_retry_;
      else if (loop == "session.observation")
        result = owner.observation_retry_;
      else
        result = owner.signals_retry_;
      return Json::object();
    });
    if (!read)
      throw std::runtime_error(read.error().message);
    return *result;
  }
  static std::string CoordinatorInput(const SessionCoordinator& owner, const std::string& loop) {
    if (loop == "session.convergence")
      return owner.convergence_retry_.Identity();
    if (loop == "session.maintenance")
      return owner.maintenance_retry_.Identity();
    if (loop == "session.observation")
      return owner.observation_retry_.Identity();
    return owner.signals_retry_.Identity();
  }
  static RetryUnit::Snapshot RpcReceipt(const RpcResults& owner, const std::string& id) {
    std::lock_guard lock(owner.mutex_);
    return *owner.entries_.at(id)->retry;
  }
  static std::optional<RetryUnit::Snapshot> FileReceipt(const DcFileServices& owner,
                                                        const std::string& id) {
    std::lock_guard lock(owner.mutex_);
    const auto found = owner.receipts_.find(id);
    if (found == owner.receipts_.end() || found->second.reply.is_null())
      return {};
    return found->second.retry;
  }
  static void CoordinatorSignal(SessionCoordinator& owner) {
    const auto flushed = owner.Execute([&]() -> Result<Json> {
      owner.FlushSignals(owner.desired_.dump() + ":" + std::to_string(owner.scope_.generation));
      return Json::object();
    });
    if (!flushed)
      throw std::runtime_error(flushed.error().message);
  }
  static void SeedCamera(FaceController& owner) {
    owner.raw_camera.Bind(1);
    owner.raw_camera.State(1, true);
    const std::string challenge = "12345678-1234-1234-1234-123456789abc";
    owner.raw_camera.Begin(1, 1, challenge, 60000);
    const auto ready = Json{{"type", "auth.camera.ready"},
                            {"version", 1},
                            {"authEpoch", 1},
                            {"challengeId", challenge},
                            {"format", "rgb24"},
                            {"maxFps", 5},
                            {"width", 64},
                            {"height", 64}}
                           .dump();
    owner.raw_camera.Receive(
        1, false, ready.data(), ready.size(), 0, [](uint64_t, std::string_view) { return true; },
        [](int, int, const uint8_t*, int) {});
  }
  static void Camera(FaceController& owner) {
    owner.DeliverCamera([](uint64_t, std::string_view) { return true; }, 0);
  }
  static void Launch(BrowserRuntime& owner) {
    wchar_t executable[32768]{};
    GetModuleFileNameW(nullptr, executable, 32768);
    auto launched = owner.process_.Launch(
        executable, BrowserProcess::Quote(executable) + L" --hold", owner.profile_key_);
    if (!launched)
      throw std::runtime_error(launched.error().message);
    owner.incarnation_ = owner.process_incarnation_ = "browser";
    owner.shutdown_phase_ = BrowserRuntime::ShutdownPhase::kRunning;
  }
  static void Seed(Session& owner, const std::string& loop) {
    owner.views.desired["1"] = {{"signIn", "provider"}};
    if (loop == "navigation.recovery") {
      owner.navigation.Begin("1");
      auto& task = owner.navigation.recoveries.at("1");
      task.phase = NavigationRecovery::Recovery::Phase::kBegin;
      task.saved = {{"size", "1"}, {"chunks", Json::array({{{"data", "YQ=="}, {"bytes", 1}}})}};
    }
    owner.browser.initialized_ = loop == "storage.scavenge";
    if (loop == "signin.handoff")
      owner.views.desired["1"]["signIn"] = "xinjiaoyu";
    if (loop == "browser.connection")
      owner.browser.control_channel_ = "fake";
    if (loop == "output.reconcile" || loop == "navigation.final_export") {
      owner.views.desired["1"] = TestView();
      owner.views.desired["1"]["visible"] = false;
    }
  }
  static void SignIn(
      Session& owner,
      const std::function<Result<Json>(const Json&, const std::string&, const std::string&)>&
          append) {
    owner.views.PollSignIn(append);
  }
  static void ChangeSignIn(Session& owner) {
    owner.views.desired["1"]["url"] = "https://changed.example/";
  }
  static const RetryUnit& SignInState(const Session& owner) {
    return owner.views.sign_in_handoff_.begin()->second;
  }
  static bool SignInRetired(const Session& owner) {
    return owner.views.sign_in_pending_.empty() && !owner.views.sign_in_handoff_.empty() &&
           owner.views.sign_in_handoff_.begin()->second.Status() == RetryUnit::State::kDropped;
  }
  static bool SignInSurfaced(const Session& owner) { return !owner.views.SignInFailures().empty(); }
  static void Change(Session& owner, const std::string& loop) {
    owner.browser.incarnation_ = owner.browser.process_incarnation_ = "browser-changed";
    owner.views.desired["1"]["url"] = "https://changed.example/";
    Seed(owner, loop);
  }
  static const RetryUnit& SessionState(const Session& owner, const std::string& loop) {
    if (loop == "navigation.recovery")
      return owner.navigation.recoveries.at("1").retry;
    if (loop == "storage.scavenge")
      return owner.navigation.scavenge_retry_;
    if (loop == "signin.fetch")
      return owner.views.sign_in_fetch_;
    if (loop == "output.reconcile")
      return owner.views.output_retry_;
    if (loop == "browser.connection")
      return owner.browser.connection_retry_;
    return owner.browser.health_retry_;
  }
  static void HealthProbeDue(Session& owner) { owner.browser.next_health_check_ = 0; }
  static Result<void> Health(Session& owner) { return owner.browser.HealthCheck(); }
  static Result<void> ExitCleanup(Session& owner,
                                  const std::function<Result<void>(const std::string&)>& cleanup) {
    return owner.CleanupExitedBrowser(cleanup);
  }
  static void Exited(Session& owner, std::string incarnation) {
    owner.pending_exit_cleanup_ = std::move(incarnation);
  }
  static const RetryUnit& ExitState(const Session& owner) { return owner.exit_cleanup_retry_; }
  static FileUploadStore& Uploads(Session& owner) { return owner.files.Library().file_uploads; }
  static FileLibrary& Library(Session& owner) { return owner.files.Library().file_library; }
  static fs::path StagingPath(const FileLibrary& owner) {
    return owner.root_ / "staging" / "stale";
  }
  static void RemoveUploads(FileUploadStore& owner,
                            std::function<Result<void>(const fs::path&)> remove) {
    owner.remove_tree_ = std::move(remove);
  }
  static void RemoveLibrary(FileLibrary& owner,
                            std::function<Result<void>(const fs::path&)> remove) {
    owner.remove_file_ = std::move(remove);
  }
  static const RetryUnit& UploadState(const FileUploadStore& owner, const std::string& id) {
    return owner.cleanup_retries_.at(id);
  }
  static bool UploadRetired(const FileUploadStore& owner, const std::string& id) {
    return !owner.batches_.contains(id);
  }
  static const RetryUnit& LibraryState(const FileLibrary& owner, const std::string& id) {
    return owner.cleanup_retries_.at(id);
  }
  static Result<void> Staging(FileLibrary& owner, const fs::path& path) {
    return owner.RetireStaging(fs::directory_entry(path));
  }
  static void Selection(Session& owner, uint64_t control) {
    auto& library = owner.files.Library();
    if (library.selection_watches.empty()) {
      LibrarySelection selection;
      selection.id = std::string(32, 'b');
      selection.binding = {"browser", "1", "1", "1", "1"};
      library.selection_watches.push_back({selection, control, INT64_MAX});
    } else {
      library.selection_watches.front().selection.id = std::string(32, char('a' + control));
    }
  }
  static Result<std::string> Watch(Session& owner) {
    auto& library = owner.files.Library();
    return library.WatchSelection(library.selection_watches.front());
  }
  static const RetryUnit& WatchState(const Session& owner) {
    return const_cast<Session&>(owner).files.Library().selection_watches.front().retry;
  }
  static Result<void> Placement(Service& owner,
                                uint64_t generation,
                                const std::function<Result<void>()>& prepare) {
    return owner.PreparePlacement({{"sessionId", std::string(32, 'a')}, {"placementEpoch", 1}}, "1",
                                  generation, prepare);
  }
  static Result<Json> Schedule(Service& owner,
                               uint64_t epoch,
                               const std::function<Result<Json>()>& ready) {
    return owner.ScheduleVersion(std::string(32, 'a'), epoch, ready);
  }
  static Result<Json> TakeSnapshot(Service& owner, SnapshotClient& client) {
    return owner.TakeSnapshot(client, {"sessions/" + std::string(32, 'a')});
  }
  static Result<void> SnapshotWork(Service& owner, const std::function<Result<void>()>& work) {
    return owner.SnapshotWork(work);
  }
  static void ServiceGeneration(Service& owner, uint64_t generation) {
    owner.metrics_generation_ = generation;
  }
  static const RetryUnit& ServiceState(const Service& owner, const std::string& loop) {
    if (loop == "placement.reconcile")
      return owner.placement_retries_.begin()->second;
    if (loop == "snapshot.schedule")
      return owner.version_retries_.begin()->second;
    if (loop == "snapshot.take")
      return owner.snapshot_retry_;
    return owner.snapshot_worker_retry_;
  }
};
namespace retry_test {
struct Attempt {
  RetryClock::time_point at;
  Json identity;
};
struct Boundary {
  mutable std::mutex mutex;
  std::optional<Error> error;
  std::vector<Attempt> attempts;
  void Inject(std::optional<Error> failure) {
    std::lock_guard lock(mutex);
    error = std::move(failure);
  }
  std::vector<Attempt> Attempts() const {
    std::lock_guard lock(mutex);
    return attempts;
  }
  Result<Json> Call(Json identity, Json success = Json::object()) {
    std::lock_guard lock(mutex);
    attempts.push_back({RetryClock::now(), std::move(identity)});
    return error ? Result<Json>{*error} : Result<Json>{std::move(success)};
  }
};
struct OwnerDriver {
  std::shared_ptr<void> owner;
  std::shared_ptr<Boundary> boundary;
  std::function<void()> tick, change;
  std::function<RetryUnit::Snapshot()> state;
  std::function<bool()> surfaced;
  std::function<bool()> retired = [] { return false; };
};
template <class T>
T Take(Result<T> result) {
  if (!result)
    throw std::runtime_error(result.error().message);
  return std::move(result).value();
}
inline void Take(Result<void> result) {
  if (!result)
    throw std::runtime_error(result.error().message);
}
inline OwnerDriver ExportDriver(bool cleanup) {
  struct Fixture {
    NavigationExport owner;
    Json view{{"view", "1"}, {"instance", "1"}, {"document", "1"}, {"navigationRevision", "1"}};
    Boundary boundary;
    std::optional<Error> failure;
    void Tick() {
      auto result = owner.Tick(
          "browser", [&](const std::string&) -> Result<Json> { return view; },
          [&](const Json& request) -> Result<Json> {
            const auto method = request.at("method").get<std::string>();
            if (method == "navigation.export.chunk")
              return Json{{"data", "YQ=="}};
            if (method == "navigation.transfer.cancel" && !cleanup_mode)
              return Json::object();
            return boundary.Call(request, {{"transfer", "transfer"}, {"size", "1"}});
          },
          [](const std::string&) { return 1u; },
          [](const std::string&, const Json&) -> Result<void> { return {}; });
      if (!result)
        failure = result.error();
    }
    bool cleanup_mode = false;
  };
  auto f = std::make_shared<Fixture>();
  f->cleanup_mode = cleanup;
  const auto setup = [f, cleanup] {
    if (cleanup)
      f->owner.RetireTransfer("browser", "1", f->view.at("navigationRevision"));
    else
      f->owner.Observe(f->view, "browser", true);
  };
  setup();
  return {f,
          std::shared_ptr<Boundary>(f, &f->boundary),
          [f] { f->Tick(); },
          [f, setup, cleanup] {
            if (cleanup)
              f->owner.Clear();
            f->view["navigationRevision"] = "2";
            setup();
          },
          [f, cleanup]() -> const RetryUnit& {
            return NativeRetryOwnerProbe::Export(f->owner, cleanup);
          },
          [f] { return !f->owner.Failures().empty() || f->failure.has_value(); },
          [f, cleanup] { return cleanup && !f->owner.Pending(); }};
}
inline OwnerDriver DownloadDriver(const fs::path& path, bool cleanup) {
  struct Fixture {
    SessionDb db;
    DownloadImports owner;
    Boundary boundary;
    bool cleanup;
    bool completed = false;
    explicit Fixture(const fs::path& path, bool cleaning)
        : db(path), owner(db.Downloads(), "build"), cleanup(cleaning) {
      Take(db.Open());
      Take(owner.Initialize());
      owner.SetImport([this](const Json& download) -> Result<Json> {
        const Json success{{"assetId", std::string(64, 'a')}, {"type", "text/plain"}};
        return cleanup ? Result<Json>{success} : boundary.Call(download, success);
      });
    }
    void Tick() {
      const Json event{{"type", "download.completed"},   {"guid", "guid"}, {"eventId", "event"},
                       {"fileReference", "downloads/a"}, {"name", "a"},    {"size", "1"},
                       {"mimeType", "text/plain"},       {"origin", ""}};
      owner.Observe("browser", completed ? Json::array() : Json::array({event}), "session",
                    [&](Json request) -> Result<Json> {
                      auto result = cleanup ? boundary.Call(request) : Result<Json>{Json::object()};
                      if (result && request.at("method") == "view.closed.ack")
                        completed = true;
                      return result;
                    });
    }
  };
  auto f = std::make_shared<Fixture>(path, cleanup);
  return {f,
          std::shared_ptr<Boundary>(f, &f->boundary),
          [f] { f->Tick(); },
          [f] { f->owner.SetInput("changed"); },
          [f]() -> const RetryUnit& { return NativeRetryOwnerProbe::Download(f->owner); },
          [f] {
            const auto rows = Take(f->db.Downloads().Load()).at("records");
            return !rows.empty() && rows.at(0).contains("retry");
          },
          [f] { return f->owner.Pending() == 0; }};
}
inline OwnerDriver DownloadPersistenceDriver(bool handoff) {
  struct Fixture {
    Boundary boundary;
    Json persisted{{"records", Json::array()}};
    bool handoff, completed = false;
    std::optional<Error> failure;
    DownloadImports owner;
    explicit Fixture(bool report)
        : handoff(report),
          owner(DownloadImports::Store{[&]() -> Result<Json> { return persisted; },
                                       [&](const Json& next) -> Result<void> {
                                         auto result = handoff ? Result<Json>{Json::object()}
                                                               : boundary.Call(next);
                                         if (!result)
                                           return result.error();
                                         persisted = next;
                                         return {};
                                       },
                                       [&](const Json& next,
                                           const Json& event,
                                           const std::string& id,
                                           const std::string& incarnation) -> Result<void> {
                                         auto result =
                                             boundary.Call({{"state", next},
                                                            {"event", event},
                                                            {"id", id},
                                                            {"incarnation", incarnation}});
                                         if (!result)
                                           return result.error();
                                         persisted = next;
                                         return {};
                                       },
                                       [&](const std::string&) -> Result<void> {
                                         persisted["records"] = Json::array();
                                         return {};
                                       }},
                "build") {
      Take(owner.Initialize());
      owner.SetImport([&](const Json&) -> Result<Json> {
        if (handoff)
          return Error{ErrorCode::kRejected, "injected import rejection"};
        return Json{{"assetId", std::string(64, 'a')}, {"type", "text/plain"}};
      });
    }
    void Tick() {
      const Json event{{"type", "download.completed"},   {"guid", "guid"}, {"eventId", "event"},
                       {"fileReference", "downloads/a"}, {"name", "a"},    {"size", "1"},
                       {"mimeType", "text/plain"},       {"origin", ""}};
      auto result = owner.Observe("browser", completed ? Json::array() : Json::array({event}),
                                  "session", [&](Json request) -> Result<Json> {
                                    if (request.at("method") == "view.closed.ack")
                                      completed = true;
                                    return Json::object();
                                  });
      if (!result)
        failure = result.error();
    }
  };
  auto f = std::make_shared<Fixture>(handoff);
  return {f,
          std::shared_ptr<Boundary>(f, &f->boundary),
          [f] { f->Tick(); },
          [f] { f->owner.SetInput("changed"); },
          [f]() -> const RetryUnit& {
            return NativeRetryOwnerProbe::DownloadPersistence(f->owner, f->handoff);
          },
          [f] { return f->failure.has_value(); }};
}
class ObjectLink final : public ManagementLink {
 public:
  Boundary boundary;
  std::string epoch = "first";
  bool Next(std::string&, uint64_t&, bool&) override { return false; }
  bool Current(uint64_t) override { return true; }
  bool SendReply(uint64_t, const Json&) override { return true; }
  bool SendEvent(const Json&, uint64_t, DeliveryFlag = {}) override { return true; }
  void OnDisconnect(Disconnect) override {}
  std::optional<ReadyState> ReadyConfiguration() override {
    return ReadyState{1, Json::object(), epoch};
  }
  Result<Json> Request(const std::string& name, Json fields) override {
    return boundary.Call(
        {{"name", name}, {"fields", fields}},
        name == "object.committed.batch" ? Json{{"ok", true}} : Json{{"id", std::string(64, 'b')}});
  }
};
inline OwnerDriver DocumentDriver(const fs::path& path) {
  struct Fixture {
    ObjectLink link;
    objects::ObjectService objects;
    documents::ObjectDocuments owner;
    std::optional<Error> result;
    explicit Fixture(const fs::path& path)
        : objects(path / "objects", link, {}, "node", "build"), owner(objects, path, "build") {}
  };
  auto f = std::make_shared<Fixture>(path);
  return {f,
          std::shared_ptr<Boundary>(f, &f->link.boundary),
          [f] {
            auto result = NativeRetryOwnerProbe::Submit(f->owner).get();
            if (!result)
              f->result = result.error();
          },
          [f] { f->link.epoch = "changed"; },
          [f]() -> const RetryUnit& { return NativeRetryOwnerProbe::Document(f->owner); },
          [f] { return f->result.has_value(); }};
}
inline OwnerDriver CommitDriver(const fs::path& root) {
  struct Fixture {
    ObjectLink link;
    objects::ObjectService owner;
    std::optional<Error> failure;
    explicit Fixture(const fs::path& root) : owner(root, link, {}, "node", "build") {
      owner.CommitDeadline(std::chrono::steady_clock::now());
    }
    void Tick() {
      auto result =
          owner.CommittedBatch({{std::string(64, 'a'), 1, 1, std::string(64, 'b')}}, "tenant");
      if (!result)
        failure = result.error();
    }
  };
  auto f = std::make_shared<Fixture>(root);
  return {f,
          std::shared_ptr<Boundary>(f, &f->link.boundary),
          [f] { f->Tick(); },
          [f] { f->link.epoch = "changed"; },
          [f] { return *NativeRetryOwnerProbe::Commit(f->owner); },
          [f] { return f->failure.has_value(); },
          [f] { return !NativeRetryOwnerProbe::Commit(f->owner).has_value(); }};
}
inline OwnerDriver DocumentPersistenceDriver(const fs::path& path) {
  struct Fixture {
    Boundary boundary;
    ObjectLink link;
    objects::ObjectService objects;
    documents::ObjectDocuments owner;
    std::optional<Error> failure;
    Fixture(const fs::path& path)
        : objects(path / "objects", link, {}, "node", "build"),
          owner(objects,
                path,
                "build",
                [&](const fs::path& file, const Json& record) -> Result<void> {
                  auto result =
                      boundary.Call({{"path", file.generic_string()}, {"record", record}});
                  return result ? Result<void>{} : Result<void>{result.error()};
                }) {}
    void Tick() {
      auto result = NativeRetryOwnerProbe::Submit(owner).get();
      if (!result)
        failure = result.error();
    }
  };
  auto f = std::make_shared<Fixture>(path);
  return {
      f,
      std::shared_ptr<Boundary>(f, &f->boundary),
      [f] { f->Tick(); },
      [f] { f->link.epoch = "changed"; },
      [f]() -> const RetryUnit& { return NativeRetryOwnerProbe::DocumentPersistence(f->owner); },
      [f] { return f->failure.has_value(); }};
}
inline OwnerDriver CacheDriver(const fs::path& root, bool claims) {
  struct Fixture {
    ObjectLink link;
    objects::ObjectService objects;
    CheckpointCache owner;
    fs::path directory;
    std::string tenant = "tenant";
    bool claims;
    Fixture(const fs::path& root, bool refresh)
        : objects(root / "objects", link, {}, "node", "build"),
          directory(root / "cache"),
          claims(refresh) {
      fs::create_directories(directory);
      std::ofstream(directory / "file") << "data";
      Take(objects.Configure({{"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
                              {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}));
      objects.CommitDeadline(std::chrono::steady_clock::now());
      NativeRetryOwnerProbe::CacheSeed(owner, directory, claims);
    }
    void Tick() {
      owner.MaybeStage(objects, tenant);
      NativeRetryOwnerProbe::CacheWait(owner);
      NativeRetryOwnerProbe::PreStageIdle(objects);
    }
    void Change() {
      tenant = "changed";
      NativeRetryOwnerProbe::CacheSeed(owner, directory, claims);
    }
  };
  auto f = std::make_shared<Fixture>(root, claims);
  return {f,
          std::shared_ptr<Boundary>(f, &f->link.boundary),
          [f] { f->Tick(); },
          [f] { f->Change(); },
          [f]() -> const RetryUnit& { return NativeRetryOwnerProbe::Cache(f->owner, f->claims); },
          [f] { return NativeRetryOwnerProbe::Cache(f->owner, f->claims).Failure().has_value(); }};
}
inline OwnerDriver CacheWorkerDriver(const fs::path& root, bool journal) {
  struct Fixture {
    CheckpointCache owner;
    Boundary boundary;
    fs::path directory;
    bool journal;
    Fixture(const fs::path& root, bool flush) : directory(root), journal(flush) {}
    void Tick() {
      const auto operation = [&]() -> Result<void> {
        auto result = boundary.Call({{"directory", directory.generic_string()}});
        return result ? Result<void>{} : Result<void>{result.error()};
      };
      if (journal)
        NativeRetryOwnerProbe::CacheJournal(owner, directory, operation);
      else
        NativeRetryOwnerProbe::CacheQueue(owner, directory.generic_string(), operation);
    }
  };
  auto f = std::make_shared<Fixture>(root, journal);
  return {
      f,
      std::shared_ptr<Boundary>(f, &f->boundary),
      [f] { f->Tick(); },
      [f] { f->directory /= "changed"; },
      [f] { return f->journal ? f->owner.JournalRetryStatus() : f->owner.StagingRetryStatus(); },
      [f] {
        return (f->journal ? f->owner.JournalRetryStatus() : f->owner.StagingRetryStatus())
            .Failure()
            .has_value();
      }};
}
inline OwnerDriver MenuDriver() {
  struct Fixture {
    DirectServices owner;
    SharedAtlasFrame frame{};
    Boundary boundary;
    Fixture() {
      owner.Bind(1);
      frame.generation = 1;
      frame.status = SharedAtlasStatus::kRunning;
      frame.view_count = 1;
      frame.views[0].session_id = 1;
      frame.views[0].webview_id = 1;
      frame.views[0].context_menu.menu_id = 1;
    }
    void Tick() {
      owner.ContextMenu(
          1, frame, false, [&](const Json& request) { return boundary.Call(request); },
          [&] { return DirectServices::ContextMenuIdentity(frame, false); });
    }
  };
  auto f = std::make_shared<Fixture>();
  return {f,
          std::shared_ptr<Boundary>(f, &f->boundary),
          [f] { f->Tick(); },
          [f] { ++f->frame.views[0].context_menu.menu_id; },
          [f]() -> const RetryUnit& { return NativeRetryOwnerProbe::Menu(f->owner); },
          [f] { return NativeRetryOwnerProbe::Menu(f->owner).Failure().has_value(); }};
}
inline OwnerDriver MaintenanceDriver() {
  struct Fixture {
    DcFileServices owner;
    Boundary boundary;
    uint64_t epoch = 1;
    void Tick() {
      NativeRetryOwnerProbe::Maintain(
          owner,
          [&]() -> Result<void> {
            auto result = boundary.Call({{"epoch", epoch}});
            return result ? Result<void>{} : Result<void>{result.error()};
          },
          epoch);
    }
  };
  auto f = std::make_shared<Fixture>();
  return {f,
          std::shared_ptr<Boundary>(f, &f->boundary),
          [f] { f->Tick(); },
          [f] { ++f->epoch; },
          [f]() -> const RetryUnit& { return NativeRetryOwnerProbe::Maintenance(f->owner); },
          [f] { return f->owner.MaintenanceFailure().has_value(); }};
}
inline int SdkStatus(ErrorCode code) {
  switch (code) {
    case ErrorCode::kBusy:
      return REMOTEKIT_SDK_BUSY;
    case ErrorCode::kUnavailable:
      return REMOTEKIT_SDK_CHANNEL_CLOSED;
    case ErrorCode::kOutcomeUnknown:
      return REMOTEKIT_SDK_TIMEOUT;
    case ErrorCode::kInternal:
      return REMOTEKIT_SDK_INVALID_ARGUMENT;
    default:
      throw std::runtime_error("error code cannot be returned by SDK send boundary");
  }
}
inline bool SdkSendCode(ErrorCode code) {
  return code == ErrorCode::kBusy || code == ErrorCode::kUnavailable ||
         code == ErrorCode::kOutcomeUnknown || code == ErrorCode::kInternal;
}
inline OwnerDriver DeliveryDriver(std::string loop) {
  struct Fixture {
    std::string loop;
    ControlOutbox control;
    DcFileServices files;
    DirectServices surface;
    Boundary boundary;
    SharedAtlasFrame frame{};
    uint64_t revision = 0;
    void Change() {
      ++revision;
      control.Bind({1, revision});
      control.Replace({1, revision}, std::to_string(revision), {}, {});
      files.Bind(1, "connection");
      files.Admit(1, {{"requestId", std::to_string(revision)},
                      {"method", "asset.begin"},
                      {"params", {{"requestId", "library"}}}});
      surface.Bind(1);
      frame.generation = revision;
      frame.view_count = 1;
      frame.views[0].webview_id = 1;
      surface.Viewports(1, frame);
    }
    void Tick() {
      const auto send = [&](const std::string& wire) -> int {
        auto result = boundary.Call(wire);
        return result ? 0 : SdkStatus(result.error().code);
      };
      if (loop == "control.delivery")
        control.Flush({1, revision}, send);
      else if (loop == "files.delivery")
        files.Flush(1, send);
      else
        surface.Flush(1, send);
    }
    const RetryUnit& State() const {
      if (loop == "control.delivery")
        return NativeRetryOwnerProbe::Control(control);
      if (loop == "files.delivery")
        return NativeRetryOwnerProbe::FileDelivery(files);
      return NativeRetryOwnerProbe::Surface(surface);
    }
    bool Retired() const {
      if (loop == "control.delivery")
        return NativeRetryOwnerProbe::ControlRetired(control);
      if (loop == "files.delivery")
        return NativeRetryOwnerProbe::FileRetired(files);
      return false;
    }
    bool Surfaced() const {
      if (loop == "control.delivery")
        return control.Failure({1, revision}).has_value();
      if (loop == "files.delivery")
        return files.DeliveryFailure().has_value();
      return !surface.DeliveryFailures().empty();
    }
  };
  auto f = std::make_shared<Fixture>();
  f->loop = std::move(loop);
  f->Change();
  return {f,
          std::shared_ptr<Boundary>(f, &f->boundary),
          [f] { f->Tick(); },
          [f] { f->Change(); },
          [f]() -> const RetryUnit& { return f->State(); },
          [f] { return f->Surfaced(); },
          [f] { return f->Retired(); }};
}
inline std::function<Result<Json>(Json)> browser_dispatch;
inline std::function<int(const char*)> connect_dispatch = [](const char*) { return 0; };
inline media::Sdk BrowserSdk() {
  media::Sdk sdk;
  sdk.remotekit_sdk_control_connect = [](const char* channel, uint64_t* handle) {
    const auto status = connect_dispatch(channel);
    *handle = status ? 0 : 1;
    return status;
  };
  sdk.remotekit_sdk_control_close = [](uint64_t) { return 0; };
  sdk.remotekit_sdk_control_request = [](uint64_t, const void* bytes, size_t size, void* output,
                                         size_t capacity, size_t* count, uint32_t) {
    auto result = browser_dispatch(
        Json::parse(static_cast<const char*>(bytes), static_cast<const char*>(bytes) + size));
    auto reply = result ? result.value() : Json{{"error", WireError(result.error())}};
    reply["ok"] = bool(result);
    const auto encoded = reply.dump();
    if (encoded.size() > capacity)
      return int(REMOTEKIT_SDK_BUFFER_TOO_SMALL);
    std::memcpy(output, encoded.data(), encoded.size());
    *count = encoded.size();
    return 0;
  };
  return sdk;
}
class SessionFixture {
 public:
  Boundary boundary;
  ObjectLink link;
  media::Sdk sdk = BrowserSdk();
  RuntimeOptions options;
  objects::ObjectService objects;
  media::FrameAdmission admission;
  Session owner;
  std::string loop;
  std::optional<Error> failure;
  SessionFixture(const fs::path& root, std::string name)
      : options(Take(RuntimeOptions::FromConfig(TestConfig(), root, "dev", "test"))),
        objects(options.data, link, {}, "test", "dev"),
        owner(sdk, options, "tenant", std::string(32, 'a'), 1, {}, link, objects, admission),
        loop(std::move(name)) {
    Take(owner.Initialize());
    NativeRetryOwnerProbe::Launch(owner.browser);
    connect_dispatch = [](const char*) { return 0; };
    if (loop != "browser.connection")
      Take(owner.browser.Rpc().Connect("fake"));
    NativeRetryOwnerProbe::Seed(owner, loop);
    if (loop == "clipboard.sync")
      owner.output.SetClipboardPoll([&](bool) -> Result<void> {
        auto result = boundary.Call({{"browser", owner.BrowserIncarnation()}});
        return result ? Result<void>{} : Result<void>{result.error()};
      });
  }
  ~SessionFixture() { owner.browser.Stop(); }
  bool Surfaced() const {
    if (loop == "navigation.recovery")
      return !owner.navigation.ViewStatus("1").at("error").is_null();
    return failure.has_value() || Status().Failure().has_value();
  }
  RetryUnit::Snapshot Status() const {
    if (loop == "clipboard.sync")
      return owner.pipeline.ClipboardRetryStatus();
    return NativeRetryOwnerProbe::SessionState(owner, loop);
  }
  void Tick() {
    connect_dispatch = [&](const char* channel) -> int {
      if (loop != "browser.connection")
        return 0;
      auto result = boundary.Call({{"channel", channel}});
      return result ? 0 : SdkStatus(result.error().code);
    };
    browser_dispatch = [&](Json request) -> Result<Json> {
      request.erase("id");
      const auto method = request.at("method");
      if (loop == "browser.connection")
        return Json::object();
      if (loop == "output.reconcile" && method != "output.configure")
        return Json::object();
      Json success = Json::object();
      if (method == "navigation.import.begin")
        success = {{"transfer", "transfer"}};
      if (method == "navigation.transfer.status")
        success = {{"transfer", "transfer"}, {"importing", true}, {"size", "1"}, {"received", "0"}};
      if (method == "snapshot")
        success = {{"sessions", Json::array({{{"views", Json::array({{{"view", "1"}}})}}})}};
      if (method == "view.signIn.events")
        success = {{"events", Json::array()}};
      const Json identity =
          loop == "navigation.recovery"
              ? Json{{"view", "1"}, {"size", "1"}, {"browser", owner.browser.Incarnation()}}
              : request;
      return boundary.Call(identity, success);
    };
    if (loop == "signin.fetch")
      owner.views.PollSignIn();
    else if (loop == "clipboard.sync")
      NativeRetryOwnerProbe::Clipboard(owner);
    else if (loop == "output.reconcile") {
      auto result = owner.views.ReconcileOutput();
      if (!result)
        failure = result.error();
    } else if (loop == "browser.health" || loop == "browser.connection") {
      auto result = owner.browser.HealthCheck();
      if (!result)
        failure = result.error();
    } else
      owner.navigation.MaintainRecovery();
  }
};
inline OwnerDriver SessionDriver(const fs::path& root, std::string loop) {
  auto f = std::make_shared<SessionFixture>(root, std::move(loop));
  return {f,
          std::shared_ptr<Boundary>(f, &f->boundary),
          [f] { f->Tick(); },
          [f] { NativeRetryOwnerProbe::Change(f->owner, f->loop); },
          [f] { return f->Status(); },
          [f] { return f->Surfaced(); }};
}
class IdleChannel final : public cluster::Channel {
 public:
  Result<void> Send(const Json&) override { return {}; }
  Result<void> SendBinary(const Json&, std::span<const uint8_t>) override { return {}; }
  Result<cluster::Message> Receive(std::chrono::milliseconds timeout) override {
    std::unique_lock lock(mutex_);
    if (wake_.wait_for(lock, timeout, [&] { return closed_; }))
      return Error{ErrorCode::kUnavailable, "fake transport closed"};
    return Error{ErrorCode::kBusy, "fake receive timeout"};
  }
  void Close() override {
    std::lock_guard lock(mutex_);
    closed_ = true;
    wake_.notify_all();
  }

 private:
  std::mutex mutex_;
  std::condition_variable wake_;
  bool closed_ = false;
};
inline OwnerDriver ReconnectDriver() {
  struct Fixture {
    Boundary boundary;
    std::unique_ptr<ClusterLink> owner;
    std::string build = "build";
    Json Ready() const {
      const auto config = TestConfig();
      const auto encoded = Json{{"peer", config.at("peer")}, {"rtc", config.at("rtc")}}.dump();
      return {
          {"type", "node.ready"},
          {"buildId", build},
          {"config", config},
          {"connectionEpoch", "12345678-1234-1234-1234-123456789abc"},
          {"configHash", cluster::Hex(cluster::Sha256(
                             {reinterpret_cast<const uint8_t*>(encoded.data()), encoded.size()}))},
          {"objectKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
          {"objectIdKey", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},
          {"peers", Json::array()}};
    }
    void Tick() {
      if (!owner)
        owner = std::make_unique<ClusterLink>(
            [&]() -> Result<cluster::Established> {
              auto result = boundary.Call({{"build", build}}, Ready());
              if (!result)
                return result.error();
              return cluster::Established{std::make_unique<IdleChannel>(), result.value()};
            },
            false, build, "endpoint", [](const Json&) -> Result<void> { return {}; });
      const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
      for (;;) {
        const auto status = owner->RetryStatus();
        if (owner->ReadyConfiguration()) {
          if (!status.Attempt())
            return;
        } else if (status.Attempt() && (status.Status() != RetryUnit::State::kWaiting ||
                                        status.Until() > RetryClock::now()))
          return;
        if (std::chrono::steady_clock::now() >= deadline)
          throw std::runtime_error("reconnect owner failed to finish its attempt");
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
      }
    }
  };
  auto f = std::make_shared<Fixture>();
  return {f,
          std::shared_ptr<Boundary>(f, &f->boundary),
          [f] { f->Tick(); },
          [f] {
            f->owner.reset();
            f->build = "changed";
          },
          [f] { return f->owner->RetryStatus(); },
          [f] { return f->owner->RetryStatus().Failure().has_value(); }};
}
inline OwnerDriver MetricsDriver(const fs::path& root) {
  struct Fixture {
    Boundary boundary;
    NodeMetrics owner;
    std::string input = "first";
    explicit Fixture(const fs::path& root) : owner(root) {}
    void Tick() {
      NativeRetryOwnerProbe::Metrics(owner, input, [&](Json sample) -> Result<void> {
        auto result = boundary.Call(std::move(sample));
        return result ? Result<void>{} : Result<void>{result.error()};
      });
    }
  };
  auto f = std::make_shared<Fixture>(root);
  return {f,
          std::shared_ptr<Boundary>(f, &f->boundary),
          [f] { f->Tick(); },
          [f] { f->input = "changed"; },
          [f] { return f->owner.RetryStatus(); },
          [f] { return f->owner.RetryStatus().Failure().has_value(); }};
}
inline std::function<int(Json)> auth_dispatch;
inline OwnerDriver CameraDriver() {
  struct Fixture {
    Boundary boundary;
    media::Sdk sdk;
    AuthorizationController authorization{sdk, {}};
    FaceController owner{sdk, "tenant", "session", authorization};
    Fixture() {
      sdk.remotekit_rtc_send_auth_data = [](uint64_t, const void* data, size_t size, int) {
        return auth_dispatch(
            Json::parse(static_cast<const char*>(data), static_cast<const char*>(data) + size));
      };
      NativeRetryOwnerProbe::SeedCamera(owner);
    }
    void Tick() {
      auth_dispatch = [&](Json message) -> int {
        auto result = boundary.Call(std::move(message));
        return result ? 0 : SdkStatus(result.error().code);
      };
      NativeRetryOwnerProbe::Camera(owner);
    }
  };
  auto f = std::make_shared<Fixture>();
  return {f,
          std::shared_ptr<Boundary>(f, &f->boundary),
          [f] { f->Tick(); },
          [f] { NativeRetryOwnerProbe::SeedCamera(f->owner); },
          [f] { return f->owner.CameraRetryStatus(); },
          [f] { return f->owner.CameraRetryStatus().Failure().has_value(); }};
}
}  // namespace retry_test
}  // namespace remotekit
