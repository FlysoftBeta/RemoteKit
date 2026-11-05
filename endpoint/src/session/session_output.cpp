#include "session/session.hpp"
namespace remotekit {
Result<void> Session::OpenOutput(bool preserve_visibility) {
  MarkConnection(ConnectionPhase::output_open_start);
  // OSR output resources require a subscribed view. With no visible output,
  // keep RTC/DataChannel alive without opening a render generation.
  // MediaLoop's resource replacement uses its existing subscription state.
  // Control may already be changing desired before PauseOutput joins us.
  if (!preserve_visibility)
    output_suspended = !has_visible_output.load();
  if (output_suspended || !rtc_connected || !authorization.Stamp())
    return {};
  remotekit_rtc_clock_sample clock{};
  clock.struct_size = sizeof(clock);
  if (!sdk.sample_clock || sdk.sample_clock(&clock) != 0 || !clock.qpc_frequency)
    return Error{ErrorCode::kUnavailable, "SDK monotonic clock mapping unavailable"};
  pool.SetClock(clock);
  if (trace)
    trace->SdkClock(clock);
  remotekit_sdk_render_setup setup{};
  setup.struct_size = sizeof(setup);
  auto result = browser.Rpc().OpenRender(setup);
  if (!result)
    return result.error();
  capture_clock_uncertainty_ms = pool.clock_uncertainty_us() / 1000;
  const auto& adapter = *streaming_adapter;
  std::string error;
  if (!pool.Open(setup, browser.Pid(), sdk, adapter.luid, adapter.device.Get(),
                 adapter.context.Get(), error))
    return Error{ErrorCode::kInvalidRequest,
                 error + " expected_adapter=" + AdapterLuid(adapter.luid) + " render_adapter=" +
                     AdapterLuid({setup.adapter_luid_low, setup.adapter_luid_high})};
  MarkConnection(ConnectionPhase::output_open_end);

  return {};
}

int Session::SendData(uint64_t handle, uint64_t stamp, const std::string& encoded) {
  if (!authorization.Current(stamp))
    return 1;
  // All outboxes serialize objects. Append the active wire epoch at actual
  // admission, while the queue's local generation still owns this send.
  if (encoded.size() < 2 || encoded.front() != '{' || encoded.back() != '}')
    return 1;
  std::string wire = encoded.substr(0, encoded.size() - 1);
  if (wire.size() > 1)
    wire += ',';
  wire += "\"authEpoch\":" + std::to_string(authorization.Epoch()) + "}";
  return authorization.Current(stamp)
             ? sdk.remotekit_rtc_send_data(handle, wire.data(), wire.size(), 0)
             : 1;
}

void Session::Send(const Json& message, uint64_t expected_stamp) {
  const auto stamp = authorization.Stamp();
  auto handle = peer.load();
  if (!stamp || (expected_stamp && stamp != expected_stamp) || !handle || !data_open ||
      stamp != frame_authorization.load())
    return;
  FlushControl();
  control_outbox.Transient(
      handle, message.dump(),
      [&](const std::string& encoded) { return SendData(handle, stamp, encoded); },
      message.value("type", std::string()) == "frame" ||
          message.value("type", std::string()) == "stats");
}

void Session::FlushControl() {
  const auto stamp = authorization.Stamp();
  const auto handle = peer.load();
  if (!stamp || !handle || !data_open || stamp != frame_authorization.load())
    return;
  control_outbox.Flush(
      handle, [&](const std::string& encoded) { return SendData(handle, stamp, encoded); });
  // Layout and prepare always have admission priority over service replies.
  control_outbox.Transient(handle, std::string(), [&](const std::string&) {
    direct_services.Flush(
        handle, [&](const std::string& encoded) { return SendData(handle, stamp, encoded); });
    return 0;
  });
  control_outbox.Transient(handle, std::string(), [&](const std::string&) {
    file_services.Flush(
        handle, [&](const std::string& encoded) { return SendData(handle, stamp, encoded); });
    return 0;
  });
}

bool Session::ServiceMessage(const Event& event) {
  if (event.value != 0 || !ProductCurrent(event))
    return false;
  const auto message = Json::parse(event.bytes, nullptr, false);
  if (!message.is_object())
    return false;
  const auto type = message.value("type", Json());
  if (type == "clock.ping") {
    if (event.bytes.size() > 512 || message.value("version", Json()) != 1 ||
        !message.contains("requestId") || !remotekit::BoundedServiceId(message["requestId"]))
      return true;
    LARGE_INTEGER before{}, after{};
    FILETIME utc{};
    QueryPerformanceCounter(&before);
    GetSystemTimePreciseAsFileTime(&utc);
    QueryPerformanceCounter(&after);
    ULARGE_INTEGER ticks{};
    ticks.LowPart = utc.dwLowDateTime;
    ticks.HighPart = utc.dwHighDateTime;
    Send({{"type", "clock.pong"},
          {"version", 1},
          {"requestId", message["requestId"]},
          {"serverTimeMs", double(ticks.QuadPart - 116444736000000000ULL) / 10000.0},
          {"serverMonotonicMs",
           1000.0 * (before.QuadPart + (after.QuadPart - before.QuadPart) / 2) / QpcFrequency()}},
         event.authorization);
    return true;
  }
  if (type != "product.action")
    return false;
  std::unique_lock admission(admission_mutex);
  if (!ProductCurrent(event))
    return true;
  if (!remotekit::ProductActionEnvelope(message, event.bytes.size()))
    return true;
  const bool accepted =
      direct_services.Admit(event.peer, message, 1000.0 * QpcNow() / QpcFrequency());
  admission.unlock();
  if (!accepted)
    Send({{"type", "product.result"},
          {"version", 1},
          {"operationId", message["operationId"]},
          {"connectionId", connection},
          {"operationGeneration", message["operationGeneration"]},
          {"ok", false},
          {"error", "endpoint_backpressure"}},
         event.authorization);
  return true;
}

void Session::QueueLayout(const Json& mode) {
  Json prepare;
  if (layout_prepare && !layout.empty()) {
    const auto& key = *layout_prepare;
    prepare = {{"type", "presentation.prepare"},
               {"version", 1},
               {"barrierId", std::to_string(key.barrier)},
               {"outputGeneration", std::to_string(key.generation)},
               {"layoutEpoch", std::to_string(key.epoch)}};
  }
  control_outbox.Replace(peer.load(), mode.is_null() ? std::string() : mode.dump(),
                         layout.empty() ? std::string() : layout.dump(),
                         prepare.is_null() ? std::string() : prepare.dump());
  FlushControl();
}

bool Session::PresentationNumber(const Json& message, const char* field, uint64_t& result) {
  const auto found = message.find(field);
  if (found == message.end() || !found->is_string())
    return false;
  const auto& value = found->get_ref<const std::string&>();
  if (value.empty() || (value.size() > 1 && value[0] == '0'))
    return false;
  const auto parsed = std::from_chars(value.data(), value.data() + value.size(), result);
  return parsed.ec == std::errc{} && parsed.ptr == value.data() + value.size();
}

bool Session::PresentationMessage(const Event& event) {
  const auto message = Json::parse(event.bytes, nullptr, false);
  if (!message.is_object())
    return false;
  const auto type = message.value("type", Json());
  if (type != "media.presentation" && type != "presentation.ready")
    return false;
  if (event.bytes.size() > 512 || message.value("version", Json()) != 1)
    return true;
  if (type == "media.presentation") {
    if (message.value("backend", Json()) != "video")
      return true;
    const bool restart = ProductCurrent(event) && message.value("restart", Json()) == true;
    layout_prepare = presentation.Video(event.peer, restart);
    if (restart) {
      input_authorization = 0;
      control_outbox.Bind(event.peer);
      refresh_connected = true;
    }
    // Mode() installs the gate before any video support confirmation leaves.
    QueueLayout({{"type", "presentation.mode"}, {"version", 1}, {"backend", "video"}});
  } else {
    remotekit::PresentationBarrier::Key key;
    if (PresentationNumber(message, "barrierId", key.barrier) &&
        PresentationNumber(message, "outputGeneration", key.generation) &&
        PresentationNumber(message, "layoutEpoch", key.epoch) &&
        presentation.Ready(event.peer, key)) {
      layout_prepare.reset();
      refresh_connected = true;
    }
  }
  return true;
}

void Session::PublishLayout(Json next, uint64_t epoch) {
  // Serialize replacement with the last encoded publication, including old
  // hardware jobs already in flight. Metadata is sent only after gate closure.
  const auto prepare =
      presentation.Layout(std::stoull(next.at("generation").get<std::string>()), epoch);
  std::map<std::string, bool> ready;
  std::set<std::string> feedback_views;
  for (const auto& view : next.at("views"))
    feedback_views.insert(view.at("id").get<std::string>());
  media_feedback.Bind(peer.load(), next.at("epoch").get<std::string>(),
                      next.at("generation").get<std::string>(), std::move(feedback_views));
  for (const auto& view : next.at("views"))
    ready[view.at("id").get<std::string>()] = !view.value("stale", false);
  coordinate_readiness.Set(epoch, std::move(ready));
  // Layout() returns no new key for an identical epoch. Preserve the current
  // key so a repeated transaction retries the same idempotent barrier.
  if (prepare)
    layout_prepare = prepare;
  next = remotekit::LayoutCapabilities(
      std::move(next),
      browser.Rpc().Control() != 0 && client_gestures_control.load() == browser.Rpc().Control());
  if (next.at("generation") != "0" && !layout.empty() && layout.value("reconfiguring", false))
    direct_services.RefreshEditable();
  layout = std::move(next);
  QueueLayout();
}

void Session::InvalidateLayout(const char* reason) {
  current_geometry = std::string("invalid:") + reason;
  const auto epoch = layout_epoch.fetch_add(1) + 1;
  Json invalid = {{"type", "layout"},
                  {"generation", "0"},
                  {"width", 16},
                  {"height", 16},
                  {"mediaScale", 1},
                  {"views", Json::array()},
                  {"epoch", std::to_string(epoch)}};
  if (std::string_view(reason) == "reconfigure")
    invalid["reconfiguring"] = true;
  direct_services.RefreshEditable();
  PublishLayout(std::move(invalid), epoch);
}

Json Session::Layout(const remotekit::SharedAtlasFrame& frame) {
  auto fit = sampling;
  if (!fit.width)
    fit = {frame.width_pixels, frame.height_pixels, 1};
  const double sx = double(fit.width) / frame.width_pixels,
               sy = double(fit.height) / frame.height_pixels;
  Json views = Json::array();
  for (uint32_t i = 0; i < frame.view_count; ++i) {
    auto& v = frame.views[i];
    views.push_back(
        {{"id", std::to_string(v.webview_id)},
         {"session", std::to_string(v.session_id)},
         {"instance", std::to_string(v.instance_generation)},
         {"document", std::to_string(v.document_generation)},
         {"focus", std::to_string(v.focus_generation)},
         {"x", std::lround(v.x_pixels * sx)},
         {"y", std::lround(v.y_pixels * sy)},
         {"width", std::lround((v.x_pixels + v.width_pixels) * sx) - std::lround(v.x_pixels * sx)},
         {"height",
          std::lround((v.y_pixels + v.height_pixels) * sy) - std::lround(v.y_pixels * sy)},
         {"deviceScaleFactor", v.page_device_scale_factor},
         {"mediaScale", fit.scale * v.atlas_pixels_per_dip / v.page_device_scale_factor},
         {"mediaScaleX", sx * v.atlas_pixels_per_dip / v.page_device_scale_factor},
         {"mediaScaleY", sy * v.atlas_pixels_per_dip / v.page_device_scale_factor},
         {"stale", (v.reserved & remotekit::kSharedAtlasViewStale) != 0}});
  }
  return {{"type", "layout"},        {"generation", std::to_string(frame.generation)},
          {"width", fit.width},      {"height", fit.height},
          {"mediaScale", fit.scale}, {"mediaScaleX", sx},
          {"mediaScaleY", sy},       {"views", views}};
}

std::string Session::GeometryKey(const remotekit::SharedAtlasFrame& frame) {
  auto value = Layout(frame);
  for (auto& view : value["views"])
    view.erase("focus");
  return value.dump();
}

uint64_t Session::ObserveLayout(const remotekit::SharedAtlasFrame& frame) {
  const auto key = GeometryKey(frame);
  if (key != current_geometry) {
    current_geometry = key;
    layout_epoch.fetch_add(1);
  }
  return layout_epoch.load();
}
}  // namespace remotekit
