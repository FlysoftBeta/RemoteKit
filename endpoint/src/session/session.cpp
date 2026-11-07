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
                 const objects::Keys& object_keys)
    : config{options,         std::move(tenant), id,         options.data / "sessions" / id,
             placement_epoch, profile_key,       object_keys},
      sdk(api),
      management(link),
      browser(api, config.profile_key),
      store(config.directory),
      trace(media::ServerTrace::Create(config.tenant, config.id)),
      context{sdk,   config.options, config.tenant, config.id, config.directory,  browser,
              store, management,     trace,         objects,   config.object_keys},
      timing(context),
      authorization(
          api,
          AuthorizationController::Hooks{
              .peer = [this] { return peer_controller.Handle(); },
              .connection = [this] { return peer_controller.Connection(); },
              .files_closed = [this] { files.Bind(0); },
              .revoked =
                  [this] {
                    face.Cancel();
                    channel.Revoke();
                  },
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
              .trace = [this] { return trace; }}),
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
                  [this](uint64_t encoder) {
                    EncoderRegistry::DestroyEncoder(&registry, encoder);
                  }}),
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
             browser, store, management, trace, objects, config.object_keys},
            peer_controller,
            authorization),
      face(context, authorization),
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
                  channel,
                  face),
      channel(context,
              peer_controller,
              authorization,
              control_outbox,
              presentation,
              input,
              files,
              face,
              output,
              pipeline,
              registry,
              views,
              timing) {
  views.SetStopRuntime([this] { return Stop(); });
  output.Slots().SetTrace(trace);
}
Result<Json> Session::Open(const Json& request) const {
  auto key = cluster::DecodeKey(request.at("profileKey").get<std::string>());
  if (!key)
    return key.error();
  auto object_key = cluster::DecodeKey(request.at("objectKey").get<std::string>());
  auto id_key = cluster::DecodeKey(request.at("objectIdKey").get<std::string>());
  if (!object_key || !id_key) {
    SecureZeroMemory(key.value().data(), key.value().size());
    if (object_key)
      SecureZeroMemory(object_key.value().data(), object_key.value().size());
    if (id_key)
      SecureZeroMemory(id_key.value().data(), id_key.value().size());
    return Error{ErrorCode::kInvalidRequest, "invalid object keys"};
  }
  const bool identical =
      request.at("sessionId") == config.id &&
      request.at("placementEpoch") == config.placement_epoch && key.value() == config.profile_key &&
      object_key.value() == config.object_keys.object && id_key.value() == config.object_keys.id;
  SecureZeroMemory(key.value().data(), key.value().size());
  SecureZeroMemory(object_key.value().data(), object_key.value().size());
  SecureZeroMemory(id_key.value().data(), id_key.value().size());
  if (!identical)
    return Error{ErrorCode::kConflict, "session placement conflicts with the open session"};
  return Json{{"sessionId", config.id}, {"placementEpoch", config.placement_epoch}};
}
Result<void> Session::Initialize() {
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
    fprintf(stderr, "session shutdown: %s\n", stopped.error().message.c_str());
}
void Session::BindPeerResources(uint64_t handle) {
  timing.Reset();
  authorization.Bind();
  pipeline.Reset();
  presentation.Bind(handle);
  channel.Bind(handle);
}
Result<void> Session::StartPeerResources(uint64_t handle, const std::string& sdp) {
  face.Start(handle);
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
  face.Stop();
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
    fprintf(stderr, "peer output close: %s\n", closed.error().message.c_str());
  if (trace) {
    auto flushed = trace->Flush();
    if (!flushed)
      fprintf(stderr, "server trace: %s\n", flushed.error().message.c_str());
  }
}
Result<void> Session::Stop() {
  return CloseRuntime(false);
}
Result<void> Session::Shutdown() {
  return CloseRuntime(true);
}
Result<void> Session::CloseRuntime(bool graceful) {
  peer_controller.Close();
  const bool had_process = browser.Present();
  auto stopped =
      graceful ? browser.Shutdown([this] { return navigation.FinalExport(); }) : browser.Stop();
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
  auto blockers = files.Hibernation();
  blockers["unacknowledgedClosedEvents"] = snapshot["events"].size();
  blockers["pendingPageRequests"] = 0;
  blockers["downloadsInProgress"] = snapshot["downloadsInProgress"];
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
  snapshot["hibernation"] = std::move(blockers);
  return snapshot;
}
Result<Json> Session::ReadLog(const Json& request) const {
  const auto name = Required(request, "log");
  fs::path path;
  if (name == "browser")
    path = config.directory / "browser.log";
  else if (name == "endpoint")
    path = config.options.node_root / "logs" / "endpoint.log";
  else if (name == "endpoint.1")
    path = config.options.node_root / "logs" / "endpoint.log.1";
  else
    return Error{ErrorCode::kInvalidRequest, "unknown log"};
  const auto& max = request.at("maxBytes");
  const auto* end = request.contains("end") ? &request.at("end") : nullptr;
  if (!max.is_number_unsigned() || (end && !end->is_number_unsigned()))
    return Error{ErrorCode::kInvalidRequest, "invalid log window"};
  return ReadLogWindow(path, end ? std::optional(end->get<uint64_t>()) : std::nullopt,
                       max.get<uint64_t>());
}
Result<Json> Session::Hibernate(objects::ObjectService& objects) {
  RK_ASSIGN_OR_RETURN(snapshot, Snapshot());
  for (const auto& [name, value] : snapshot["hibernation"].items())
    if ((value.is_boolean() && value.get<bool>()) ||
        (value.is_number() && value.get<uint64_t>() != 0))
      return Error{ErrorCode::kConflict, "hibernation blocked: " + name};
  RK_RETURN_IF_ERROR(Shutdown());
  files.Stop();
  // No session worker can mutate files after the shutdown boundary.
  for (const auto* relative :
       {"uploads", "file-library/drafts", "file-library/incoming", "file-library/staging"})
    fs::remove_all(config.directory / relative);
  return Checkpoints(objects).Create(config.directory, config.tenant, config.object_keys, config.id,
                                     config.placement_epoch, config.options.build_id);
}
}  // namespace remotekit
