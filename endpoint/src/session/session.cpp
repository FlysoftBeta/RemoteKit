#include "session/session.hpp"
namespace remotekit {
Session::Session(media::Sdk& api,
                 const RuntimeOptions& options,
                 std::string tenant,
                 std::string id,
                 ManagementLink& link)
    : config{options, std::move(tenant), id, options.data / "sessions" / id},
      sdk(api),
      management(link),
      browser(api),
      store(config.directory),
      trace(media::ServerTrace::Create(config.tenant, config.id)),
      context{sdk,     config.options, config.tenant, config.id, config.directory,
              browser, store,          management,    trace},
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
          config.id,
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
      audio(context, peer_controller, authorization),
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
  auto stopped = Stop();
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
  navigation.Reset();
  views.Reset();
  peer_controller.Close();
  const bool had_process = browser.Present();
  auto stopped = browser.Stop();
  if (!stopped)
    return stopped.error();
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
  return {};
}
}  // namespace remotekit
