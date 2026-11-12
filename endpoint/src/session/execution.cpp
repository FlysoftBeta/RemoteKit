#include "session/execution.hpp"
#include "cluster/node_files.hpp"
#include "diagnostics/log_files.hpp"
#include "management/methods.hpp"
#include "persistence/checkpoint.hpp"
#include "util/wire_error.hpp"

namespace remotekit {
SessionExecution::SessionExecution(media::Sdk& sdk,
                                   const RuntimeOptions& options,
                                   ManagementLink& management,
                                   objects::ObjectService& objects,
                                   Json target,
                                   std::string incarnation)
    : sdk_(sdk),
      options_(options),
      management_(management),
      objects_(objects),
      tenant_(target.at("tenantId")),
      id_(target.at("sessionId")),
      incarnation_(std::move(incarnation)),
      epoch_(target.at("placementEpoch")),
      directory_(options.data / "sessions" / id_) {}
SessionCoordinator::Hooks SessionExecution::Hooks() {
  const auto self = shared_from_this();
  return {
      .authorization = [self](const Json& value,
                              uint64_t generation) { return self->Authorize(value, generation); },
      .prepare = [self](const Json& value) { return self->Prepare(value); },
      .start = [self] { return self->Start(); },
      .views = [self](const Json& value) { return self->Views(value); },
      .stop = [self](const Json& value) { return self->Stop(value); },
      .observe = [self] { return self->Observe(); },
      .maintain = [self] { self->Maintain(); },
      .admit = [self](const Json& value,
                      uint64_t generation) { return self->Admit(value, generation); },
      .request = [self](const Json& value,
                        uint64_t generation) { return self->Request(value, generation); },
      .replay = [self](const Json& request, uint64_t generation) -> Result<void> {
        if (request.at("method") != "rtc.offer")
          return {};
        const auto session = self->runtime_.load();
        if (!session)
          return Error{ErrorCode::kConflict, "RPC peer is retired"};
        return session->Channel().ReplayOffer(request.at("params"), generation);
      },
      .acknowledge = [self](const std::string& stream,
                            uint64_t up_to) { return self->Acknowledge(stream, up_to); },
      .management_lost =
          [self](uint64_t generation) {
            if (auto session = self->runtime_.load())
              session->ManagementLost(generation);
          },
      .send = [self](
                  const Json& value,
                  uint64_t generation) { return self->management_.SendEvent(value, generation); },
  };
}
void SessionExecution::Activate(std::string connection, uint64_t generation) {
  {
    std::lock_guard lock(scope_mutex_);
    connection_ = std::move(connection);
  }
  generation_ = generation;
}
Result<void> SessionExecution::Authorize(const Json& document, uint64_t generation) {
  std::lock_guard lock(authorization_mutex_);
  auto previous = desired_.load();
  const auto revision = std::stoull(document.at("revision").get<std::string>());
  if (previous && std::stoull(previous->at("revision").get<std::string>()) > revision)
    return {};
  while (!previous || std::stoull(previous->at("revision").get<std::string>()) <= revision) {
    if (previous && *previous == document)
      break;
    if (desired_.compare_exchange_weak(previous, std::make_shared<const Json>(document)))
      break;
  }
  if (auto session = runtime_.load())
    return session->AuthorizeDesired(document, generation);
  return {};
}
Result<void> SessionExecution::Prepare(const Json& document) {
  auto session = runtime_.load();
  if (!session) {
    reader_.reset();
    RK_ASSIGN_OR_RETURN(copy, Checkpoints::Copy(directory_));
    if (!copy.is_null() && copy.at("placementEpoch").get<uint64_t>() > epoch_)
      return Error{ErrorCode::kConflict, "Session copy is fenced"};
    if (!copy.is_null() && copy.at("state") == "clean" && !copy.at("lastCommit").is_null() &&
        copy.at("base") != document.at("checkpoint"))
      return Error{ErrorCode::kBusy, "checkpoint publication is pending"};
    auto key = cluster::DecodeKey(document.at("profileKey").get<std::string>());
    if (!key)
      return key.error();
    struct EraseKey {
      cluster::Key& value;
      ~EraseKey() { SecureZeroMemory(value.data(), value.size()); }
    } erase{key.value()};
    auto access = std::make_shared<objects::SessionObjects>(objects_, tenant_);
    auto phases = RestorePhases();
    phases["event"] = "session.open.timing";
    phases["tenantId"] = tenant_;
    const auto start = PhaseClock::now();
    phases["startedQpc"] = QpcNow();
    if (!Checkpoints::ReuseCopy(copy, epoch_, document.at("checkpoint"))) {
      if (!copy.is_null() && document.at("checkpoint").is_null())
        return Error{ErrorCode::kConflict, "Session copy base differs from desired checkpoint"};
      RK_RETURN_IF_ERROR(Checkpoints(objects_, access, &phases)
                             .Restore(directory_, tenant_, document.at("checkpoint")));
      copy = {{"version", 1},
              {"sessionId", id_},
              {"placementEpoch", epoch_},
              {"base", document.at("checkpoint")},
              {"state", "clean"},
              {"stoppedCleanly", true},
              {"changesAt", 0},
              {"lastCommit", nullptr}};
      RK_RETURN_IF_ERROR(Checkpoints::WriteCopy(directory_, copy));
      RK_RETURN_IF_ERROR(Checkpoints::TruncateChanges(directory_));
    } else {
      phases["mode"] = "reuse";
    }
    session = std::make_shared<Session>(sdk_, options_, tenant_, id_, epoch_, key.value(),
                                        management_, objects_, access);
    RK_RETURN_IF_ERROR(session->Initialize());
    session->BeginManagementRequest(generation_.load());
    phases["restoreTotal"] = PhaseMs(start);
    session->SetOpenTiming(std::move(phases));
    runtime_.store(session);
    ++runtime_generation_;
    RK_ASSIGN_OR_RETURN(events, session->EventState());
    const auto stream = events.at("streamId").get<std::string>();
    if (const auto known = acknowledged_.find(stream); known != acknowledged_.end())
      RK_RETURN_IF_ERROR(session->AcknowledgeEvents(stream, known->second));
  }
  starting_ = !session->Running();
  RK_RETURN_IF_ERROR(session->StageDesired(document));
  staged_revision_ = document.at("revision").get<std::string>();
  return {};
}
Result<void> SessionExecution::Start() {
  const auto session = runtime_.load();
  if (!session)
    return Error{ErrorCode::kUnavailable, "Session execution is not prepared"};
  starting_ = true;
  if (!session->Running())
    ++runtime_generation_;
  auto result = session->Views().Start();
  starting_ = false;
  running_ = session->Running();
  return result;
}
Result<void> SessionExecution::Views(const Json&) {
  const auto session = runtime_.load();
  if (!session)
    return Error{ErrorCode::kUnavailable, "Session execution is not prepared"};
  return session->Views().ConvergeDesired();
}
Result<Json> SessionExecution::Stop(const Json& commit,
                                    bool check_blockers,
                                    PhaseClock::time_point deadline,
                                    bool deferred) {
  if (auto session = runtime_.load()) {
    if (const auto document = desired_.load();
        document && document->at("revision").get<std::string>() != staged_revision_) {
      RK_RETURN_IF_ERROR(session->StageDesired(*document));
      staged_revision_ = document->at("revision").get<std::string>();
    }
    auto stopped = session->StopAndCommit(commit, check_blockers, deadline, deferred);
    if (stopped || stopped.error().code == ErrorCode::kOutcomeUnknown) {
      ++runtime_generation_;
      runtime_.store({});
      running_ = false;
    }
    return stopped;
  }
  RK_ASSIGN_OR_RETURN(copy, Checkpoints::Copy(directory_));
  if (copy.is_null()) {
    if (commit.is_null())
      return Json{{"state", "clean"}, {"base", nullptr}, {"committed", nullptr}};
    const auto desired = desired_.load();
    if (!desired)
      return Error{ErrorCode::kUnavailable, "Session desired state is missing"};
    RK_RETURN_IF_ERROR(Prepare(*desired));
    return Stop(commit, check_blockers, deadline, deferred);
  }
  if (copy.at("placementEpoch") != epoch_)
    return Error{ErrorCode::kConflict, "Session stop placement is fenced"};
  if (!commit.is_null() && !copy.at("lastCommit").is_null() &&
      copy.at("lastCommit").at("requestId") == commit) {
    RK_ASSIGN_OR_RETURN(checkpoint,
                        Checkpoints(objects_).Describe(copy.at("lastCommit").at("manifestId")));
    checkpoint.update({{"state", copy.at("state")},
                       {"base", copy.at("base")},
                       {"committed", copy.at("lastCommit")}});
    return checkpoint;
  }
  if (copy.at("state") == "clean" && !commit.is_null() && !copy.at("base").is_null()) {
    copy["lastCommit"] = {{"requestId", commit}, {"manifestId", copy.at("base")}};
    RK_RETURN_IF_ERROR(Checkpoints::WriteCopy(directory_, copy));
    return Json{
        {"state", "clean"}, {"base", copy.at("base")}, {"committed", copy.at("lastCommit")}};
  }
  if (copy.at("state") == "clean" || commit.is_null())
    return Json{{"state", copy.at("state")}, {"base", copy.at("base")}, {"committed", nullptr}};
  if (!copy.at("stoppedCleanly").get<bool>())
    return Error{ErrorCode::kConflict, "stop blocked: lifecycleUncertain"};
  RK_ASSIGN_OR_RETURN(events, EventState());
  if (events.at("streamId").is_null()) {
    const auto desired = desired_.load();
    if (!desired)
      return Error{ErrorCode::kUnavailable, "Session desired state is missing"};
    RK_RETURN_IF_ERROR(Prepare(*desired));
    return Stop(commit, check_blockers, deadline, deferred);
  }
  if (check_blockers && events.value("pending", int64_t(0)) != 0)
    return Error{ErrorCode::kBusy, "stop waiting for event acknowledgments"};
  reader_.reset();
  CheckpointCache cache;
  RK_RETURN_IF_ERROR(cache.Start(directory_));
  cache.Stop();
  RK_ASSIGN_OR_RETURN(checkpoint,
                      Checkpoints(objects_, {}, nullptr, &cache)
                          .Create(directory_, tenant_, options_.build_id, deadline, deferred));
  copy["lastVersion"] = {{"manifestId", checkpoint.at("manifestId")},
                         {"takenAt", std::chrono::duration_cast<std::chrono::milliseconds>(
                                         std::chrono::system_clock::now().time_since_epoch())
                                         .count()},
                         {"kind", "stopped"}};
  copy["state"] = "clean";
  copy["base"] = checkpoint.at("manifestId");
  copy["lastCommit"] = {{"requestId", commit}, {"manifestId", checkpoint.at("manifestId")}};
  RK_RETURN_IF_ERROR(Checkpoints::WriteCopy(directory_, copy));
  RK_RETURN_IF_ERROR(Checkpoints::TruncateChanges(directory_));
  checkpoint.update(
      {{"state", "clean"}, {"base", copy.at("base")}, {"committed", copy.at("lastCommit")}});
  return checkpoint;
}
Result<void> SessionExecution::Fence() {
  retired_ = true;
  ++runtime_generation_;
  const auto session = runtime_.exchange({});
  running_ = false;
  reader_.reset();
  if (session)
    return session->Stop();
  return {};
}
Result<Json> SessionExecution::EventState() {
  Json state;
  if (auto session = runtime_.load()) {
    RK_ASSIGN_OR_RETURN(current, session->EventState());
    state = std::move(current);
  } else {
    if (!fs::exists(directory_ / "session.db"))
      return Json{{"streamId", nullptr}, {"ackedThrough", "0"}, {"lastSeq", "0"}, {"pending", 0}};
    if (!reader_) {
      RK_ASSIGN_OR_RETURN(copy, Checkpoints::Copy(directory_));
      reader_ = std::make_unique<SessionDb>(directory_);
      RK_RETURN_IF_ERROR(
          reader_->OpenReadOnly(!copy.is_null() && copy.at("stoppedCleanly").get<bool>()));
    }
    RK_ASSIGN_OR_RETURN(current, reader_->Events().State());
    state = std::move(current);
  }
  const auto stream = state.at("streamId").get<std::string>();
  if (const auto known = acknowledged_.find(stream);
      known != acknowledged_.end() &&
      known->second > std::stoull(state.at("ackedThrough").get<std::string>())) {
    state["ackedThrough"] = std::to_string(known->second);
    RK_ASSIGN_OR_RETURN(pending,
                        reader_ ? reader_->Events().Load(known->second, coordination::kMaxEvents)
                                : runtime_.load()->PendingEvents(known->second));
    state["pending"] = pending.size();
  }
  return state;
}
Result<Json> SessionExecution::ReadEvents() {
  RK_ASSIGN_OR_RETURN(state, EventState());
  if (state.at("streamId").is_null())
    return Json::array();
  const auto after = std::stoull(state.at("ackedThrough").get<std::string>());
  if (auto session = runtime_.load())
    return session->PendingEvents(after);
  return reader_->Events().Load(after);
}
Result<void> SessionExecution::Acknowledge(const std::string& stream, uint64_t up_to) {
  RK_ASSIGN_OR_RETURN(state, EventState());
  if (state.at("streamId") != stream || stream != sent_stream_ || up_to > sent_through_)
    return Error{ErrorCode::kConflict, "event acknowledgment exceeds emitted stream"};
  if (auto session = runtime_.load())
    RK_RETURN_IF_ERROR(session->AcknowledgeEvents(stream, up_to));
  acknowledged_[stream] = std::max(acknowledged_[stream], up_to);
  last_events_sent_ = {};
  return {};
}
bool SessionExecution::VersionDue(int64_t now, int64_t interval) const {
  auto session = runtime_.load();
  return session && session->VersionDue(now, interval);
}
Result<SessionExecution::Version> SessionExecution::CaptureVersion() {
  auto session = runtime_.load();
  if (!session || retired_)
    return Error{ErrorCode::kConflict, "Session is not running"};
  RK_ASSIGN_OR_RETURN(plan, session->CaptureVersion());
  return Version{session,
                 std::move(plan),
                 {incarnation_, session->BrowserIncarnation(), epoch_, runtime_generation_}};
}
Result<Json> SessionExecution::CommitVersion(const Version& version,
                                             const Json& snapshot,
                                             const BuiltCheckpoint& built) {
  const auto session = runtime_.load();
  if (retired_ || !session || session != version.session ||
      !version.identity.Current(
          {incarnation_, session->BrowserIncarnation(), epoch_, runtime_generation_},
          session->Running()))
    return Json{{"discarded", true}};
  return session->CommitVersion(snapshot, built);
}
Result<Json> SessionExecution::Observe() {
  if (retired_)
    return Error{ErrorCode::kUnavailable, "Session actor is retired"};
  RK_ASSIGN_OR_RETURN(copy, Checkpoints::Copy(directory_));
  Json snapshot{
      {"views", Json::array()},
      {"pendingPopups", Json::array()},
      {"recovery", {{"pending", false}, {"views", Json::object()}, {"exportPending", false}}},
      {"rtc", {{"active", false}, {"connectionId", nullptr}, {"avSync", nullptr}}},
      {"stats", Json::object()},
      {"browserPid", 0},
      {"browserIncarnation", nullptr},
      {"browserRestart", "ready"}};
  Json authorization{{"connectionId", nullptr},
                     {"epoch", 0},
                     {"unlocked", false},
                     {"revoked", true},
                     {"filesApplied", false}};
  Json lock{{"leaseId", nullptr}, {"epoch", 0}, {"state", "locked"}};
  Json blockers{{"unacknowledgedEvents", 0}, {"pendingNativeSelections", 0},
                {"inFlightUploads", 0},      {"pendingPageRequests", 0},
                {"downloadsInProgress", 0},  {"pendingDownloadImports", 0},
                {"rtcConnected", false},     {"lifecycleUncertain", false}};
  bool running = false;
  if (auto session = runtime_.load()) {
    RK_ASSIGN_OR_RETURN(current, session->Snapshot());
    snapshot.update(current);
    running = session->Running();
    blockers = snapshot.at("stopBlockers");
    authorization = session->AuthorizationSnapshot();
    lock = session->LockSnapshot();
  } else if (!copy.is_null()) {
    blockers["lifecycleUncertain"] = !copy.at("stoppedCleanly").get<bool>();
  }
  running_ = running;
  RK_ASSIGN_OR_RETURN(events, EventState());
  blockers["unacknowledgedEvents"] = events.at("pending");
  events.erase("pending");
  Json data, checkpoint;
  if (!copy.is_null()) {
    data = {{"state", copy.at("state")},
            {"base", copy.at("base")},
            {"stoppedCleanly", copy.at("stoppedCleanly")},
            {"changesAt", copy.at("changesAt")},
            {"committed", copy.at("lastCommit")}};
    data["lastVersion"] = copy.contains("lastVersion") ? copy.at("lastVersion") : Json();
    if (!copy.at("base").is_null() &&
        (copy.at("state") == "clean" || copy.contains("lastVersion"))) {
      RK_ASSIGN_OR_RETURN(described, Checkpoints(objects_).Describe(copy.at("base")));
      checkpoint = std::move(described);
      checkpoint["manifestId"] = copy.at("base");
      checkpoint["kind"] = copy.at("state") == "clean" ? "stopped" : "running";
      checkpoint["takenAt"] = copy.contains("lastVersion") ? copy.at("lastVersion").at("takenAt")
                                                           : copy.at("changesAt");
    }
  }
  return Json{{"browser", starting_ ? "starting"
                          : running ? "running"
                                    : "stopped"},
              {"browserIncarnation", snapshot.at("browserIncarnation")},
              {"browserPid", snapshot.at("browserPid")},
              {"browserRestart", snapshot.at("browserRestart")},
              {"data", data},
              {"checkpoint", checkpoint},
              {"authorization", authorization},
              {"lock", lock},
              {"views", snapshot.at("views")},
              {"pendingPopups", snapshot.at("pendingPopups")},
              {"recovery", snapshot.at("recovery")},
              {"rtc", snapshot.at("rtc")},
              {"blockers", blockers},
              {"events", events},
              {"stats", snapshot.at("stats")}};
}
void SessionExecution::Maintain() {
  if (retired_)
    return;
  if (auto session = runtime_.load()) {
    session->FlushSignals();
    session->MaintainRecovery();
    auto sampled = session->Snapshot();
    if (!sampled)
      return;
  }
  const auto generation = generation_.load();
  if (!management_.Current(generation))
    return;
  const auto now = std::chrono::steady_clock::now();
  if (now - last_events_sent_ < std::chrono::milliseconds(500))
    return;
  auto state = EventState();
  auto events = ReadEvents();
  if (!state || !events || state.value().at("streamId").is_null())
    return;
  std::string connection;
  {
    std::lock_guard lock(scope_mutex_);
    connection = connection_;
  }
  const auto stream = state.value().at("streamId").get<std::string>();
  if (stream != sent_stream_) {
    sent_stream_ = stream;
    sent_through_ = 0;
  }
  for (auto event : events.value()) {
    event.update({{"event", "session.event"},
                  {"connectionEpoch", connection},
                  {"tenantId", tenant_},
                  {"sessionId", id_},
                  {"placementEpoch", epoch_},
                  {"streamId", stream}});
    if (!management_.SendEvent(event, generation))
      return;
    sent_through_ = std::max(sent_through_, std::stoull(event.at("seq").get<std::string>()));
  }
  last_events_sent_ = now;
}
Result<void> SessionExecution::Admit(const Json& request, uint64_t generation) {
  if (!management_.Current(generation) || !request.value("params", Json()).is_object())
    return Error{ErrorCode::kConflict, "RPC target is retired"};
  const auto method = request.at("method").get<std::string>();
  if (method == "session.logs.read")
    return {};
  const auto session = runtime_.load();
  if (!session)
    return Error{ErrorCode::kUnavailable, "Session execution is stopped"};
  const auto& params = request.at("params");
  if ((method.starts_with("view.") || method.starts_with("session.storage.") ||
       method == "session.identity") &&
      params.value("browserIncarnation", Json()) != session->BrowserIncarnation())
    return Error{ErrorCode::kConflict, "RPC Browser is retired"};

  return {};
}
Result<Json> SessionExecution::Request(const Json& request, uint64_t generation) {
  const auto method = request.at("method").get<std::string>();
  auto params = request.at("params");
  params["method"] = method;
  if (method == "session.logs.read")
    return ReadSessionLog(options_.node_root, id_, params);
  const auto handler = ManagementMethods::Find(method);
  if (!handler)
    return Error{ErrorCode::kInvalidRequest, "unknown Session RPC: " + method};
  const auto session = runtime_.load();
  if (!session)
    return Error{ErrorCode::kUnavailable, "Session execution is stopped"};
  session->BeginManagementRequest(generation);
  return handler(*session, params);
}
}  // namespace remotekit
