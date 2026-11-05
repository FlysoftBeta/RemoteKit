#include "session/session.hpp"
namespace remotekit {
bool Session::ProductCurrent(const Event& event) const {
  return event.peer == peer_controller.Handle() && authorization.Current(event.authorization);
}

void Session::MarkConnection(ConnectionPhase phase) {
  auto& stamp = connection_phases[static_cast<size_t>(phase)];
  if (!stamp.load()) {
    int64_t empty = 0;
    stamp.compare_exchange_strong(empty, QpcNow());
  }
}

Json Session::ConnectionTimings() const {
  constexpr const char* names[] = {
      "answerReady",     "firstCandidate",        "gatherComplete",      "connected",
      "dataChannelOpen", "outputOpenStart",       "outputOpenEnd",       "firstSourceFrame",
      "firstSubmit",     "encoderConfigureStart", "encoderConfigureEnd", "firstEncoded"};
  const auto started = connection_started_qpc.load();
  Json phases = Json::object();
  if (started)
    for (size_t i = 0; i < connection_phases.size(); ++i)
      if (const auto at = connection_phases[i].load(); at >= started)
        phases[names[i]] = 1000.0 * (at - started) / QpcFrequency();
  return phases;
}

uint32_t Session::SamplingFps() const {
  return sampling_fps;
}

fs::path Session::FaceModels() {
  wchar_t executable[32768]{};
  GetModuleFileNameW(nullptr, executable, 32768);
  return fs::path(executable).parent_path() / "face-models";
}

Session::Session(Sdk& api,
                 const RuntimeOptions& opts,
                 std::string tenant_id,
                 std::string session_id,
                 ManagementLink& link)
    : sdk(api),
      options(opts),
      tenant(std::move(tenant_id)),
      id(std::move(session_id)),
      directory(options.data / "sessions" / id),
      browser(api),
      store(directory),
      management(link),
      file_uploads(directory / "uploads"),
      file_library(directory / "file-library"),
      authorization(api,
                    AuthorizationController::Hooks{
                        .peer = [this] { return peer_controller.Handle(); },
                        .connection = [this] { return peer_controller.Connection(); },
                        .files_closed = [this] { file_services.Bind(0); },
                        .revoked =
                            [this] {
                              raw_camera.Cancel();
                              faces.Cancel();
                              WakeCamera();
                              direct_services.Bind(0);
                              input.Clear();
                              control_outbox.Bind({});
                            },
                        .wake = [this] { event_wake.notify_all(); },
                        .opened =
                            [this](uint64_t handle) {
                              direct_services.Bind(handle, peer_controller.Connection());
                              control_outbox.Bind({handle, authorization.Stamp()});
                              presentation.QueueLayout();
                            },
                        .files_opened =
                            [this](uint64_t handle) {
                              file_services.Bind(handle, peer_controller.Connection());
                            }}),
      faces(FaceModels()),
      input(id,
            InputController::Hooks{
                .peer = [this] { return peer_controller.Handle(); },
                .control = [this] { return browser.Rpc().Control(); },
                .input_stamp = [this] { return authorization.Input(); },
                .frame_stamp = [this] { return authorization.Frame(); },
                .epoch = [this] { return presentation.Epoch(); },
                .data_open = [this] { return peer_controller.DataOpen(); },
                .current = [this](uint64_t stamp) { return authorization.Current(stamp); },
                .admitted = [this](const RtcEvent& event) { return ProductCurrent(event); },
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
                      return browser.Rpc().Request(std::move(request), control, timeout,
                                                   opportunistic, admitted);
                    },
                .send = [this](const Json& message, uint64_t stamp) { Send(message, stamp); },
                .send_data =
                    [this](uint64_t peer, uint64_t stamp, const std::string& encoded) {
                      return SendData(peer, stamp, encoded);
                    },
                .notice =
                    [this](uint64_t peer,
                           uint64_t stamp,
                           const std::string& encoded,
                           const std::function<void(const std::string&)>& send) {
                      control_outbox.Notice({peer, stamp}, encoded, send);
                    },
                .flush = [this] { FlushControl(); },
                .failed = [this] { authorization.SetInput(0); },
                .trace = [this] { return trace; }}),
      data_router(DataRouter::Hooks{
          .peer = [this] { return peer_controller.Handle(); },
          .stamp = [this] { return authorization.Stamp(); },
          .epoch = [this] { return authorization.Epoch(); },
          .current = [this](const RtcEvent& event) { return ProductCurrent(event); },
          .product = [this](const RtcEvent& event) { ServiceMessage(event); },
          .presentation =
              [this](const RtcEvent& event) { presentation.PresentationMessage(event); },
          .input = [this](const RtcEvent& event) { input.QueueInput(event); },
          .files =
              [this](const RtcEvent& event) {
                auto admission = authorization.LockAdmission();
                if (ProductCurrent(event) && FileRequestEnvelope(event.message, event.bytes.size()))
                  file_services.Admit(event.peer, event.message);
              },
          .feedback =
              [this](const RtcEvent& event) {
                presentation.ReceiveFeedback(event.peer, event.message, QpcNow(),
                                             event.bytes.size());
              },
          .refresh =
              [this](const RtcEvent& event) {
                if (event.bytes.size() > 256)
                  return;
                const auto now = QpcNow();
                auto previous = last_media_refresh_qpc.load();
                if ((!previous || now - previous >= QpcFrequency()) &&
                    last_media_refresh_qpc.compare_exchange_strong(previous, now)) {
                  refresh_connected = true;
                  event_wake.notify_one();
                }
              },
          .data_state =
              [this](const RtcEvent& event) {
                if (event.value == 1) {
                  refresh_connected = true;
                  presentation.QueueLayout();
                  direct_services.RefreshEditable();
                }
              },
          .received =
              [this](const RtcEvent& event) {
                if (event.message.value("type", Json()) != "input" || !event.trace_input_sequence)
                  return;
                RK_SERVER_TRACE(trace, "input_dc_received", TraceIds{},
                                rk_record.qpc = event.received_qpc;
                                rk_record.peer = event.peer;
                                rk_record.client_sequence = event.trace_input_sequence;
                                DataRouter::Number(event.message, "view", rk_record.view);
                                DataRouter::Number(event.message, "instance", rk_record.instance);
                                DataRouter::Number(event.message, "document", rk_record.document);
                                DataRouter::Number(event.message, "focus", rk_record.focus););
              },
          .send = [this](const Json& message, uint64_t stamp) { Send(message, stamp); }}),
      presentation(PresentationController::Hooks{
          .peer = [this] { return peer_controller.Handle(); },
          .scope =
              [this] {
                return ControlOutbox::Scope{peer_controller.Handle(), authorization.Stamp()};
              },
          .admitted = [this](const RtcEvent& event) { return ProductCurrent(event); },
          .reset_input = [this] { authorization.SetInput(0); },
          .refresh =
              [this] {
                refresh_connected = true;
                event_wake.notify_one();
              },
          .flush = [this] { FlushControl(); },
          .refresh_editable = [this] { direct_services.RefreshEditable(); },
          .outbox = [this]() -> ControlOutbox& { return control_outbox; },
          .sampling = [this] { return sampling; }}),
      peer_controller(
          api,
          options,
          PeerController::Hooks{
              .bind = [this](uint64_t handle, uint64_t) { BindPeerResources(handle); },
              .started = [this](uint64_t handle,
                                const std::string& sdp) { return StartPeerResources(handle, sdp); },
              .stopping = [this] { StopPeerResources(); },
              .drained = [this] { DrainPeerResources(); },
              .event = [this](const RtcEvent& event) { HandlePeerEvent(event); },
              .signal =
                  [this](uint64_t generation, const Json& signal) {
                    management.SendEvent(Json{{"event", "rtc.signal"},
                                              {"tenantId", tenant},
                                              {"connectionId", peer_controller.Connection()},
                                              {"signal", signal}},
                                         generation);
                  },
              .create_encoder =
                  [this](uint64_t peer, uint64_t encoder) {
                    return CreateEncoder(this, peer, encoder);
                  },
              .configure_encoder =
                  [this](uint64_t encoder, const remotekit_rtc_encoder_config* config) {
                    return ConfigureEncoder(this, encoder, config);
                  },
              .encode = [this](uint64_t encoder,
                               const remotekit_rtc_frame* frame,
                               int key) { return Encode(this, encoder, frame, key); },
              .rates = [this](uint64_t encoder,
                              uint32_t bitrate,
                              uint32_t fps) { Rates(this, encoder, bitrate, fps); },
              .keyframe = [this](uint64_t encoder) { Keyframe(this, encoder); },
              .destroy_encoder = [this](uint64_t encoder) { DestroyEncoder(this, encoder); }}) {}

Result<void> Session::Initialize() {
  effective_idle_ms = std::min(1000u, options.idle_idr_ms);
  trace = ServerTrace::Create(tenant, id);
  pool.SetTrace(trace);
  fs::create_directories(directory);
  auto saved = store.Load("views.json", Json::array());
  site_preferences = store.Load("site-preferences.json", Json::object());
  auto event_state = store.Load("events.json", {{"next", 1}, {"events", Json::array()}});
  next_event = event_state.value("next", uint64_t(1));
  durable_events = event_state.value("events", Json::array());
  for (auto& view : saved)
    desired[ViewId(view)] = view;
  bool reconciled_closed = false;
  for (const auto& event : durable_events)
    if (event.value("type", std::string()) == "view.closed")
      reconciled_closed =
          desired.erase(event.at("viewId").get<std::string>()) != 0 || reconciled_closed;
  if (reconciled_closed) {
    auto saved = Save();
    if (!saved)
      return saved.error();
  }
  file_services.Start([this](const auto& job) { return DirectFileCommand(job); },
                      [this] { SweepDirectFiles(); });
  return {};
}

Session::~Session() {
  file_services.Bind(0);
  file_services.Stop();
  try {
    Stop();
  } catch (const std::exception& error) {
    fprintf(stderr, "session shutdown: %s\n", error.what());
  }
}

Result<void> Session::Save() {
  Json values = Json::array();
  for (auto& [view, config] : desired)
    values.push_back(config);
  {
    auto save_result = store.Save("views.json", values);
    if (!save_result)
      return save_result.error();
  }

  return {};
}

Result<void> Session::RecordClosed(const std::string& view, const std::string& reason) {
  if (!observed_closed.contains(view)) {
    const bool recorded =
        std::any_of(durable_events.begin(), durable_events.end(), [&](const Json& event) {
          return event.value("type", std::string()) == "view.closed" &&
                 event.value("viewId", std::string()) == view;
        });
    if (!recorded) {
      if (durable_events.size() >= 256)
        return Error{ErrorCode::kInvalidRequest,
                     "closed event backlog full; acknowledge events before reconciliation"};
      auto closed_events = durable_events;
      closed_events.push_back({{"eventId", std::to_string(next_event)},
                               {"type", "view.closed"},
                               {"viewId", view},
                               {"reason", reason}});
      {
        auto save_result_2 =
            store.Save("events.json", {{"next", next_event + 1}, {"events", closed_events}});
        if (!save_result_2)
          return save_result_2.error();
      }
      durable_events = std::move(closed_events);
      ++next_event;
    }
    // Event is durable first. A crash before the second save is repaired by
    // constructor replay, which removes these IDs before starting a Browser.
    if (desired.contains(view)) {
      Json remaining = Json::array();
      for (const auto& [view_id, config] : desired)
        if (view_id != view)
          remaining.push_back(config);
      {
        auto save_result_3 = store.Save("views.json", remaining);
        if (!save_result_3)
          return save_result_3.error();
      }
      desired.erase(view);
    }
    observed_closed.insert(view);
  }
  navigation_export.Forget(view);
  recoveries.erase(view);
  recovery_revisions.erase(view);
  fs::remove(directory / "recovery" / (view + ".json"));

  return {};
}

Result<void> Session::AckClosed(const Json& views) {
  if (!views.empty()) {
    auto view_closed_ack_result =
        browser.Rpc().Request({{"method", "view.closed.ack"},
                               {"session", id},
                               {"views", views},
                               {"browserIncarnation", browser.Incarnation()}});
    if (!view_closed_ack_result)
      return view_closed_ack_result.error();
  }

  return {};
}

bool Session::Alive() const {
  return browser.Alive();
}

bool Session::ProducerExited() const {
  return browser.Exited();
}

std::string Session::ProcessDiagnostic() const {
  return browser.Diagnostic();
}

Result<void> Session::Start() {
  if (!browser.Stopping() && Alive() && browser.Rpc().Control())
    return {};
  if (browser.Present())
    fprintf(stderr, "session %s browser replacement control=%d stop_pending=%d peer=%llu %s\n",
            id.c_str(), browser.Rpc().Control() != 0, browser.Stopping(), peer_controller.Handle(),
            ProcessDiagnostic().c_str());
  if (!Stop())
    return Error{
        ErrorCode::kConflict,
        "previous browser termination unfinished; retry the retained producer before restart"};
  auto adapter = SelectStreamingAdapter(sdk, options);
  if (!adapter)
    return adapter.error();
  streaming_adapter = std::move(adapter).value();
  const auto luid = AdapterLuid(streaming_adapter->luid);
  fprintf(stderr, "session %s selected streaming encoder=%s adapter_luid=%s\n", id.c_str(),
          streaming_adapter->encoder.c_str(), luid.c_str());
  std::string channel = "RemoteKit.service." + std::to_string(GetCurrentProcessId()) + "." + id +
                        "." + std::to_string(QpcNow());
  auto incarnation = browser.NewIncarnation();
  if (!incarnation)
    return incarnation.error();
  std::wstring command = BrowserProcess::Quote(options.browser.wstring());
  auto append = [&](std::wstring arg) { command += L" " + BrowserProcess::Quote(arg); };
  append(L"--use-adapter-luid=" + std::wstring(luid.begin(), luid.end()));
  append(L"--control-channel=" + std::wstring(channel.begin(), channel.end()));
  append(L"--browser-incarnation=" +
         std::wstring(browser.Incarnation().begin(), browser.Incarnation().end()));
  append(L"--session-id=" + std::wstring(id.begin(), id.end()));
  append(L"--tenant-id=" + std::wstring(id.begin(), id.end()));
  append(L"--data-path=" + directory.wstring());
  append(L"--atlas-width=1920");
  append(L"--atlas-height=1080");
  if (!options.browser_trace_directory.empty()) {
    fs::create_directories(options.browser_trace_directory);
    const auto file = options.browser_trace_directory /
                      ("session-" + id + "-" + std::to_string(QpcNow()) + ".json");
    append(
        L"--trace-startup=gpu.capture,viz,gpu,toplevel,toplevel.flow,disabled-by-default-gpu."
        L"service,disabled-by-default-gpu.device");
    append(L"--trace-startup-duration=16");
    append(L"--trace-startup-format=json");
    append(L"--trace-startup-file=" + file.wstring());
    append(L"--trace-startup-record-mode=record-until-full");
    append(L"--default-trace-buffer-size-limit-in-kb=32768");
  }
  fprintf(stderr, "session %s browser command %s\n", id.c_str(), Utf8(fs::path(command)).c_str());
  auto started = browser.Start(options.browser, std::move(command), channel);
  if (!started)
    return started.error();
  browser.Rpc().SetTrace(trace, browser.Pid());
  observed_closed.clear();
  navigation_export.Clear();
  recovery_revisions.clear();
  recoveries.clear();
  recovery_cursor.clear();
  {
    auto session_sitePreferences_result = browser.Rpc().Request(
        {{"method", "session.sitePreferences"}, {"session", id}, {"sites", site_preferences}});
    if (!session_sitePreferences_result)
      return session_sitePreferences_result.error();
  }
  {
    auto browser_snapshot_result = BrowserSnapshot();
    if (!browser_snapshot_result)
      return browser_snapshot_result.error();
  }
  if (!desired.empty()) {
    // Hidden construction never requires the previous/final atlas to fit an
    // intermediate set of specs. One transaction applies the complete layout.
    for (auto& [view, config] : desired) {
      auto create_view_result = CreateView(config, true);
      if (!create_view_result)
        return create_view_result.error();
    }
    {
      auto desired_geometry_result = DesiredGeometry();
      if (!desired_geometry_result)
        return desired_geometry_result.error();
      auto geometry_config_result = GeometryConfig(std::move(desired_geometry_result).value());
      if (!geometry_config_result)
        return geometry_config_result.error();
    }
  }
  reconciliation_pending = false;

  return {};
}

Result<Json> Session::BrowserSnapshot() {
  auto result = browser.Snapshot();
  if (!result)
    return result.error();
  return result;
}

bool Session::Stop() {
  navigation_export.Clear();
  recoveries.clear();
  recovery_cursor.clear();
  recovery_revisions.clear();
  reconciliation_pending = false;
  has_visible_output = false;
  ClosePeer();
  const bool had_process = browser.Present();
  auto stopped = browser.Stop();
  if (!stopped) {
    fprintf(stderr, "producer stop: %s\n", stopped.error().message.c_str());
    return false;
  }
  if (had_process) {
    last_confirmed_browser_exit = browser.ProcessIncarnation();
    {
      std::lock_guard lock(file_store_mutex);
      file_uploads.ConfirmBrowserStopped(browser.ProcessIncarnation());
    }
    std::string error;
    if (!pool.Close(error))
      fprintf(stderr, "pool close after producer exit: %s\n", error.c_str());
  }
  browser.ReleaseExited();
  streaming_adapter.reset();
  presentation.Bind(0);
  return true;
}

}  // namespace remotekit
