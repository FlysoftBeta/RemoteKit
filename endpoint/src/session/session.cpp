#include "persistence/versions.hpp"
#include "util/log.hpp"
#include "session/session.hpp"
#include "diagnostics/log_files.hpp"
#include "cluster/node_files.hpp"
#include "persistence/checkpoint.hpp"
#include "util/result_macros.hpp"
namespace remotekit {
Session::Session(media::Sdk& api,
                 const RuntimeOptions& options,
                 std::string tenant,
                 std::string id,
                 uint64_t placement_epoch,
                 const cluster::Key& profile_key,
                 ManagementLink& link,
                 objects::ObjectService& objects,
                 media::FrameAdmission& frame_admission,
                 std::shared_ptr<objects::SessionObjects> access)
    : config{options,
             std::move(tenant),
             id,
             options.data / "sessions" / id,
             placement_epoch,
             profile_key,
             access ? std::move(access)
                    : std::make_shared<objects::SessionObjects>(objects, config.tenant)},
      sdk(api),
      management(link),
      browser(api, config.profile_key),
      store(config.directory),
      trace(media::ServerTrace::Create(config.tenant, config.id)),
      context{
          sdk,   config.options, config.tenant, config.id, config.directory,     browser,
          store, management,     trace,         objects,   config.object_access, frame_admission},
      clipboard(
          config.tenant,
          config.id,
          {.ready =
               [this] { return browser.Alive() && browser.Rpc().Control() && !browser.Stopping(); },
           .incarnation = [this] { return browser.ProcessIncarnation(); },
           .read = [this] { return browser.Rpc().Request({{"method", "clipboard.read"}}); },
           .write = [this](const Json& value) -> Result<Json> {
             auto request = value;
             request["method"] = "clipboard.write";
             return browser.Rpc().Request(std::move(request));
           },
           .sequence = [this] { return output.Slots().ClipboardSequence(); },
           .send =
               [this](const Json& event) {
                 auto body = event;
                 body.erase("type");
                 body.erase("tenantId");
                 body.erase("sessionId");
                 const auto identity = "clipboard-" + browser.ProcessIncarnation() + "-" +
                                       event.at("browserSequence").get<std::string>();
                 return bool(store.Events().Append("clipboard.changed", body, identity,
                                                   browser.ProcessIncarnation()));
               }}),
      timing(context),
      authorization(
          api,
          AuthorizationController::Hooks{
              .peer = [this] { return peer_controller.Handle(); },
              .connection = [this] { return peer_controller.Connection(); },
              .files_closed = [this] { files.Bind(0); },
              .revoked = [this] { channel.Revoke(); },
              .wake = [this] { pipeline.Wake(); },
              .opened = [this](uint64_t handle) { channel.Opened(handle); },
              .files_opened =
                  [this](uint64_t handle) { files.Bind(handle, peer_controller.Connection()); }}),
      input(
          BrowserRuntime::kSessionId,
          InputController::Hooks{
              .control = [this] { return browser.Rpc().Control(); },
              .input_stamp = [this] { return authorization.Input(); },
              .epoch = [this] { return presentation.Epoch(); },
              .admitted = [this](const RtcEvent& event) { return channel.ProductCurrent(event); },
              .admission = [this] { return authorization.Admit(); },
              .revalidate =
                  [this](const AuthorizationController::AdmissionToken& token) {
                    return authorization.Current(token);
                  },
              .allows = [this](const std::string& view,
                               uint64_t epoch) { return presentation.Allows(view, epoch); },
              .rpc =
                  [this](Json request,
                         uint64_t control,
                         uint32_t timeout,
                         bool opportunistic,
                         const std::function<bool()>& admitted) {
                    return browser.Rpc().Exchange(std::move(request), control, timeout,
                                                  opportunistic, admitted);
                  },
              .send = [this](const Json& message, uint64_t stamp) { channel.Send(message, stamp); },
              .failed = [this] { authorization.SetInput(0); },
              .trace = [this] { return trace; },
              .log_fields = {{"tenantId", config.tenant}, {"sessionId", config.id}}}),
      presentation(PresentationController::Hooks{
          .peer = [this] { return peer_controller.Handle(); },
          .scope =
              [this] {
                return ControlOutbox::Scope{peer_controller.Handle(), authorization.Stamp()};
              },
          .admitted = [this](const RtcEvent& event) { return channel.ProductCurrent(event); },
          .reset_input = [this] { authorization.SetInput(0); },
          .refresh = [this] { pipeline.Refresh(); },
          .flush = [this] { channel.FlushControl(); },
          .refresh_editable = [this] { channel.RefreshEditable(); },
          .outbox = [this]() -> ControlOutbox& { return control_outbox; },
          .sampling = [this] { return pipeline.Sampling(); }}),
      peer_controller(
          api,
          config.options,
          PeerController::Hooks{
              .bind = [this](uint64_t handle, uint64_t) { BindPeerResources(handle); },
              .started = [this](uint64_t handle,
                                const std::string& sdp) { return StartPeerResources(handle, sdp); },
              .stopping = [this] { StopPeerResources(); },
              .drained = [this] { DrainPeerResources(); },
              .event = [this](const RtcEvent& event) { channel.HandlePeerEvent(event); },
              .signal =
                  [this](uint64_t generation, const Json& signal) {
                    management.SendEvent(Json{{"event", "rtc.signal"},
                                              {"tenantId", config.tenant},
                                              {"connectionId", peer_controller.Connection()},
                                              {"signal", signal}},
                                         generation);
                  },
              .create_encoder =
                  [this](uint64_t peer, uint64_t encoder) {
                    return EncoderRegistry::CreateEncoder(&registry, peer, encoder);
                  },
              .configure_encoder =
                  [this](uint64_t encoder, const remotekit_rtc_encoder_config* config) {
                    return EncoderRegistry::ConfigureEncoder(&registry, encoder, config);
                  },
              .encode =
                  [this](uint64_t encoder, const remotekit_rtc_frame* frame, int key) {
                    return EncoderRegistry::Encode(&registry, encoder, frame, key);
                  },
              .rates =
                  [this](uint64_t encoder, uint32_t bitrate, uint32_t fps) {
                    EncoderRegistry::Rates(&registry, encoder, bitrate, fps);
                  },
              .keyframe =
                  [this](uint64_t encoder) { EncoderRegistry::Keyframe(&registry, encoder); },
              .destroy_encoder =
                  [this](uint64_t encoder) { EncoderRegistry::DestroyEncoder(&registry, encoder); },
              .log_fields = {{"tenantId", config.tenant}, {"sessionId", config.id}}}),
      output(context, peer_controller, authorization, presentation, registry, pipeline, timing),
      pipeline(context,
               peer_controller,
               authorization,
               presentation,
               output,
               registry,
               timing,
               diagnostics),
      registry(context,
               peer_controller,
               authorization,
               presentation,
               output,
               pipeline,
               channel,
               timing),
      audio({sdk, config.options, config.tenant, BrowserRuntime::kSessionId, config.directory,
             browser, store, management, trace, objects, config.object_access, frame_admission},
            peer_controller,
            authorization),
      files(context, authorization, views, peer_controller),
      navigation(context, views),
      views(context, peer_controller, presentation, output, registry, navigation, diagnostics),
      diagnostics(context,
                  peer_controller,
                  presentation,
                  output,
                  registry,
                  pipeline,
                  audio,
                  views,
                  input,
                  timing,
                  channel),
      channel(context,
              peer_controller,
              authorization,
              control_outbox,
              presentation,
              input,
              files,
              output,
              pipeline,
              registry,
              views,
              timing) {
  views.SetStopRuntime([this] { return Stop(); });
  views.SetBeforeViews([this] { return clipboard.BeforeViews(); });
  output.SetClipboardPoll([this](bool force) { return clipboard.Poll(force); });
  views.SetDownloadImport(
      [this](const Json& download) { return files.Library().ImportDownload(download); });
  output.Slots().SetTrace(trace);
  presentation.SetFirstPresented(
      [this](const std::string& view, int64_t at) { browser.Presented(view, at); });
}
Result<void> Session::StageDesired(const Json& document) {
  auto key = cluster::DecodeKey(document.at("profileKey").get<std::string>());
  if (!key)
    return key.error();
  const bool identical = key.value() == config.profile_key &&
                         document.at("sessionId") == config.id &&
                         document.at("placementEpoch") == config.placement_epoch;
  SecureZeroMemory(key.value().data(), key.value().size());
  if (!identical)
    return Error{ErrorCode::kConflict, "Session identity conflicts"};
  auto preferences = views.ApplySitePreferences(document.at("sitePreferences"));
  if (!preferences)
    return preferences.error();
  auto policy = pipeline.ApplyMediaPolicy(document.at("mediaPolicy"));
  if (!policy)
    return policy.error();
  Json value = document.at("clipboard").at("value");
  value["revision"] = document.at("clipboard").at("revision");
  RK_RETURN_IF_ERROR(clipboard.Write(value));
  return views.StageDesired(document);
}
Result<void> Session::AuthorizeDesired(const Json& document, uint64_t generation) {
  BeginManagementRequest(generation);
  lock_state_.store(std::make_shared<const Json>(document.at("lock")));
  const auto& desired = document.at("authorization");
  const auto rtc = views.RtcSnapshot();
  const bool current =
      rtc.at("active").get<bool>() && rtc.at("connectionId") == desired.at("connectionId");
  const bool unlocked =
      desired.at("unlocked").get<bool>() && document.at("lock").at("state") == "unlocked";
  files_applied_ = false;
  if (!current) {
    authorization.Close();
    return {};
  }
  auto applied = authorization.Authorize({{"connectionId", desired.at("connectionId")},
                                          {"epoch", desired.at("epoch")},
                                          {"unlocked", unlocked}},
                                         generation, [this] { return ManagementCurrent(); });
  if (!applied)
    return applied.error();
  if (unlocked) {
    auto granted = files.AuthorizeFiles({{"connectionId", desired.at("connectionId")},
                                         {"authEpoch", desired.at("epoch")},
                                         {"requests", desired.at("files").at("requests")}});
    if (!granted)
      return granted.error();
    files_applied_ = true;
  }
  return {};
}
Json Session::AuthorizationSnapshot() const {
  const auto rtc = views.RtcSnapshot();
  const bool opened = authorization.Stamp() != 0;
  return {{"connectionId", rtc.at("connectionId")},
          {"epoch", authorization.Epoch()},
          {"unlocked", opened},
          {"revoked", !opened},
          {"filesApplied", opened && files_applied_}};
}
Json Session::LockSnapshot() const {
  auto value = *lock_state_.load();
  if (value.at("state") == "unlocked" && !authorization.Stamp())
    value["state"] = "unlocking";
  return value;
}
Result<void> Session::Initialize() {
  RK_ASSIGN_OR_RETURN(copy, Checkpoints::Copy(config.directory));
  if (copy.is_null())
    copy = {{"sessionId", config.id}, {"placementEpoch", config.placement_epoch},
            {"base", nullptr},        {"state", "clean"},
            {"stoppedCleanly", true}, {"changesAt", 0},
            {"lastCommit", nullptr}};
  RK_RETURN_IF_ERROR(checkpoint_cache.Start(config.directory));
  version_at_ = copy.value("lastVersion", Json::object()).value("takenAt", VersionNow());
  copy["placementEpoch"] = config.placement_epoch;
  copy["state"] = "dirty";
  copy["stoppedCleanly"] = false;
  RK_RETURN_IF_ERROR(Checkpoints::WriteCopy(config.directory, copy));
  RK_RETURN_IF_ERROR(store.Open());
  auto loaded = views.Initialize();
  if (!loaded)
    return loaded.error();
  auto initialized = files.Initialize();
  if (!initialized)
    return initialized.error();
  pipeline.Reset();
  files.Start();
  return {};
}
Session::~Session() {
  files.Stop();
  auto stopped = Shutdown();
  if (!stopped)
    LogError(LogLevel::kWarn, "session.shutdown_failed", stopped.error());
  checkpoint_cache.Stop();
}
void Session::BindPeerResources(uint64_t handle) {
  timing.Reset();
  authorization.Bind();
  pipeline.Reset();
  presentation.Bind(handle);
  channel.Bind(handle);
}
Result<void> Session::StartPeerResources(uint64_t handle, const std::string& sdp) {
  if (sdp.find("m=audio ") != std::string::npos) {
    auto opened = audio.OpenAudio();
    if (!opened)
      return opened.error();
  }
  input.Start(handle);
  pipeline.Start();
  return {};
}
void Session::StopPeerResources() {
  authorization.Close();
  audio.Stop();
  input.Stop();
  pipeline.Join();
  presentation.Bind(0);
  channel.Clear();
  presentation.InvalidateLayout("rtc-closed");
}
void Session::DrainPeerResources() {
  registry.Drain();
  auto closed = output.Close();
  if (!closed)
    LogError(LogLevel::kWarn, "output.close_failed", closed.error());
  if (trace) {
    auto flushed = trace->Flush();
    if (!flushed)
      LogError(LogLevel::kWarn, "trace.flush_failed", flushed.error());
  }
}
Result<void> Session::Stop() {
  return CloseRuntime(false);
}
Result<void> Session::Shutdown() {
  if (browser.Alive()) {
    RK_ASSIGN_OR_RETURN(snapshot, Snapshot());
    if (views.PendingDownloads() || snapshot.value("downloadsInProgress", 0) != 0)
      return Error{ErrorCode::kConflict, "shutdown blocked: pending downloads"};
  } else if (views.PendingDownloads()) {
    return Error{ErrorCode::kConflict, "shutdown blocked: pending downloads"};
  }
  return CloseRuntime(true);
}
Result<void> Session::CloseRuntime(bool graceful) {
  peer_controller.Close();
  if (!graceful) {
    auto clipboard_flushed = clipboard.Poll(true);
    if (!clipboard_flushed)
      LogEvent(LogLevel::kWarn, "clipboard.final_sync_failed");
  }
  const bool had_process = browser.Present();
  auto stopped = graceful ? browser.Shutdown([this]() -> Result<void> {
    RK_RETURN_IF_ERROR(navigation.FinalExport());
    return clipboard.Poll(true);
  })
                          : browser.Stop();
  if (browser.Alive())
    return stopped;
  navigation.Reset();
  views.Reset();
  if (had_process) {
    auto files_stopped = files.BrowserStopped(browser.ProcessIncarnation());
    if (!files_stopped)
      return files_stopped.error();
    auto closed = output.Close();
    if (!closed)
      return closed.error();
  }
  browser.ReleaseExited();
  registry.ReleaseAdapter();
  presentation.Bind(0);
  return stopped;
}
Result<Json> Session::Snapshot(bool output_diagnostics) {
  RK_ASSIGN_OR_RETURN(snapshot, views.Snapshot(output_diagnostics));
  snapshot["browserRestart"] = browser.RestartState();
  auto blockers = files.StopBlockers();
  RK_ASSIGN_OR_RETURN(events, store.Events().State());
  blockers["unacknowledgedEvents"] = events.at("pending");
  blockers["pendingPageRequests"] = 0;
  blockers["downloadsInProgress"] = snapshot["downloadsInProgress"];
  blockers["pendingDownloadImports"] = views.PendingDownloads();
  blockers["rtcConnected"] = peer_controller.Handle() != 0;
  blockers["lifecycleUncertain"] =
      navigation.RecoverySnapshot().value("pending", false) ||
      (!snapshot.value("running", false) && !browser.CheckpointReady());
  for (const auto& view : snapshot["views"]) {
    blockers["pendingPageRequests"] =
        blockers["pendingPageRequests"].get<size_t>() +
        view.value("pageRequests", Json::object()).value("pending", Json::array()).size();
    if (view.value("lifecycle_uncertain", false) || view.value("pending", false) ||
        view.value("close_state", std::string()) == "closing")
      blockers["lifecycleUncertain"] = true;
  }
  snapshot["stopBlockers"] = std::move(blockers);
  return snapshot;
}
bool Session::VersionDue(int64_t now, int64_t interval) const {
  const auto changes = checkpoint_cache.Changes();
  return remotekit::VersionDue(Running(), changes, now, version_at_, interval);
}
Result<Json> Session::SaveVersion(SnapshotClient& client, const Json& snapshot) {
  if (!Running())
    return Error{ErrorCode::kConflict, "Session stopped before version creation"};
  const auto prefix = "sessions/" + config.id;
  RK_ASSIGN_OR_RETURN(entries, SnapshotEntries(snapshot.at("files"), prefix));
  const auto id = snapshot.at("snapshotId").get<std::string>();
  SnapshotSource source{entries, [&](const std::string& name, uint64_t offset, uint32_t length) {
                          return client.Read(id, prefix + "/" + name, offset, length);
                        }};
  RK_ASSIGN_OR_RETURN(checkpoint,
                      Checkpoints(context.objects, config.object_access, nullptr, &checkpoint_cache)
                          .Create(config.directory, config.tenant, config.options.build_id,
                                  PhaseClock::time_point::max(), false, &source));
  Json version{{"manifestId", checkpoint.at("manifestId")},
               {"takenAt", snapshot.at("takenAt")},
               {"kind", "running"}};
  RK_RETURN_IF_ERROR(checkpoint_cache.Version(version));
  version_at_ = snapshot.at("takenAt").get<int64_t>();
  return version;
}
Result<void> Session::MarkStopped() {
  RK_RETURN_IF_ERROR(checkpoint_cache.Flush());
  RK_ASSIGN_OR_RETURN(copy, Checkpoints::Copy(config.directory));
  copy["stoppedCleanly"] = true;
  return Checkpoints::WriteCopy(config.directory, copy);
}
Result<Json> Session::StopAndCommit(const Json& request_id,
                                    bool check_blockers,
                                    PhaseClock::time_point deadline,
                                    bool defer_commits) {
  OperationTiming timing{CheckpointPhases()};
  timing.fields["event"] = "session.stop.timing";
  timing.fields["tenantId"] = config.tenant;
  RK_ASSIGN_OR_RETURN(copy, Checkpoints::Copy(config.directory));
  if (!request_id.is_null() && !copy["lastCommit"].is_null() &&
      copy["lastCommit"]["requestId"] == request_id) {
    RK_ASSIGN_OR_RETURN(details,
                        Checkpoints(context.objects).Describe(copy["lastCommit"]["manifestId"]));
    details.update(
        {{"state", copy["state"]}, {"base", copy["base"]}, {"committed", copy["lastCommit"]}});
    return details;
  }
  if (check_blockers) {
    RK_ASSIGN_OR_RETURN(snapshot, Snapshot());
    for (const auto& [name, value] : snapshot["stopBlockers"].items())
      if ((value.is_boolean() && value.get<bool>()) ||
          (value.is_number() && value.get<uint64_t>() != 0))
        return Error{ErrorCode::kConflict, "stop blocked: " + name};
  }
  auto save = [&]() -> Result<Json> {
    RK_RETURN_IF_ERROR(Shutdown());
    RK_ASSIGN_OR_RETURN(events, store.Events().State());
    if (check_blockers && events.at("pending") != 0)
      return Error{ErrorCode::kBusy, "stop waiting for final event acknowledgments"};
    files.Stop();
    if (!request_id.is_null() && PhaseClock::now() < deadline) {
      RK_RETURN_IF_ERROR(files.PrepareCheckpoint());
      for (const auto* relative : {"uploads", "file-library/staging"})
        fs::remove_all(LongPath(config.directory) / relative);
    }
    RK_RETURN_IF_ERROR(store.Close());
    checkpoint_cache.Stop();
    RK_RETURN_IF_ERROR(MarkStopped());
    RK_ASSIGN_OR_RETURN(stopped_copy, Checkpoints::Copy(config.directory));
    if (request_id.is_null() || PhaseClock::now() >= deadline)
      return Json{{"state", "dirty"}, {"base", stopped_copy["base"]}, {"committed", nullptr}};
    RK_ASSIGN_OR_RETURN(checkpoint, Checkpoints(context.objects, config.object_access,
                                                &timing.fields, &checkpoint_cache)
                                        .Create(config.directory, config.tenant,
                                                config.options.build_id, deadline, defer_commits));
    stopped_copy["state"] = "clean";
    stopped_copy["base"] = checkpoint["manifestId"];
    stopped_copy["lastVersion"] = {
        {"manifestId", checkpoint["manifestId"]}, {"takenAt", VersionNow()}, {"kind", "stopped"}};
    stopped_copy["lastCommit"] = {{"requestId", request_id},
                                  {"manifestId", checkpoint["manifestId"]}};
    RK_RETURN_IF_ERROR(Checkpoints::WriteCopy(config.directory, stopped_copy));
    RK_RETURN_IF_ERROR(Checkpoints::TruncateChanges(config.directory));
    return Json{{"state", "clean"},
                {"base", stopped_copy["base"]},
                {"committed", stopped_copy["lastCommit"]},
                {"objects", checkpoint["objects"]},
                {"buildId", config.options.build_id}};
  };
  try {
    auto saved = save();
    if (!saved) {
      auto error = saved.error();
      if (error.code == ErrorCode::kBusy)
        return error;
      error.code = ErrorCode::kOutcomeUnknown;
      error.retry_after_ms.reset();
      return error;
    }
    return saved;
  } catch (const std::filesystem::filesystem_error& error) {
    return WithOsError(ErrorCode::kOutcomeUnknown, error.what(), OsError::Kind::kWin32,
                       error.code().value());
  } catch (const std::exception& error) {
    return Error{ErrorCode::kOutcomeUnknown, error.what()};
  }
}
}  // namespace remotekit
