#include "session/session.hpp"
namespace remotekit {
Result<Session::Geometry> Session::DesiredGeometry() {
  std::vector<remotekit::PackItem> items;
  float scale = .5f;
  for (auto& [view, config] : desired) {
    if (!config.value("visible", false))
      continue;
    const auto device = config.value("device", Json::object());
    int w = config.value("width", device.value("width", 1440));
    int h = config.value("height", device.value("height", 900));
    if (w < 1 || h < 1 || w > 8192 || h > 8192)
      return Error{ErrorCode::kInvalidRequest, "invalid viewport dimensions"};
    items.push_back({std::stoull(view), w, h, 1.0});
    scale = std::max(scale, device.value("deviceScaleFactor", 1.0f));
  }
  const auto plan = remotekit::PlanAtlas(items, items.empty() ? 1.f : scale,
                                         RuntimeOptions::kAtlasAllocationAlignment);
  if (!plan)
    return Error{ErrorCode::kLimitExceeded,
                 "visible source atlas cannot be packed within the aligned 16-megapixel/8192-pixel "
                 "resource budget"};
  return Geometry{plan->width, plan->height, plan->scale};
}

bool Session::PauseOutput(bool reconfiguring) {
  const bool active = peer.load() != 0;
  const bool had_media_thread = media_thread.joinable();
  if (active || had_media_thread) {
    stop_media = true;
    event_wake.notify_all();
    if (media_thread.joinable())
      media_thread.join();
  }
  InvalidateLayout(reconfiguring ? "reconfigure" : "output-paused");
  {
    {
      auto output_close_result = browser.Rpc().Request({{"method", "output.close"}});
      if (!output_close_result) {
        const Error error = output_close_result.error();
        fprintf(stderr,
                "output close unfinished: %s; resources retained until producer stop confirmed\n",
                error.message.c_str());
      }
    }
  }

  // A joined MediaLoop already ran its render exit barrier. Without an owner
  // thread (e.g. output-open failure), this caller must perform that barrier.
  if (!had_media_thread) {
    std::string render_error;
    if (!pool.Close(render_error))
      fprintf(stderr, "paused render drain: %s\n", render_error.c_str());
  }
  return active;
}

Result<void> Session::GeometryConfig(const Geometry& value) {
  if (!remotekit::AtlasAllocationDimensions(value.width, value.height, value.scale,
                                            RuntimeOptions::kAtlasAllocationAlignment))
    return Error{ErrorCode::kLimitExceeded,
                 "source atlas exceeds the aligned 16-megapixel/8192-pixel resource budget"};
  Json configs = Json::array();
  bool visible_output = false;
  for (const auto& [view, config] : desired) {
    const auto device = config.value("device", Json::object());
    const bool visible = !Recovering(view) && config.value("visible", false);
    visible_output |= visible;
    configs.push_back({{"session", id},
                       {"view", view},
                       {"width", config.value("width", device.value("width", 1440))},
                       {"height", config.value("height", device.value("height", 900))},
                       {"device", device.value("mode", std::string("desktop"))},
                       {"device_scale_factor", device.value("deviceScaleFactor", 1.0f)},
                       {"visible", visible}});
  }
  {
    auto output_configure_result = browser.Rpc().Request(
        {{"method", "output.configure"},
         {"width", value.width},
         {"height", value.height},
         {"viewConfigs", std::move(configs)},
         {"device_scale", value.scale},
         {"allocation_alignment", RuntimeOptions::kAtlasAllocationAlignment}});
    if (!output_configure_result)
      return output_configure_result.error();
  }
  atlas_width = value.width;
  atlas_height = value.height;
  atlas_scale = value.scale;
  has_visible_output = visible_output;

  return {};
}

Result<void> Session::RefitOutput() {
  auto desired_geometry_result = DesiredGeometry();
  if (!desired_geometry_result)
    return desired_geometry_result.error();
  const auto geometry = std::move(desired_geometry_result).value();
  if (!reconciliation_pending && geometry.width == atlas_width && geometry.height == atlas_height &&
      geometry.scale == atlas_scale)
    return {};
  {
    auto reconcile_output_result = ReconcileOutput();
    if (!reconcile_output_result)
      return reconcile_output_result.error();
  }

  return {};
}

Result<void> Session::ResumeOutput(bool active) {
  if (!active)
    return {};
  {
    auto open_output_result = OpenOutput();
    if (!open_output_result)
      return open_output_result.error();
  }
  stop_media = false;
  media_thread = std::thread([this] {
    RunThread(
        "media", [this] { MediaLoop(); },
        [this] {
          stop_media = true;
          rtc_connected = false;
        });
  });

  return {};
}

Result<void> Session::ReconcileOutput() {
  const bool active = PauseOutput();
  auto reconcile = [&]() -> Result<void> {
    auto geometry = DesiredGeometry();
    if (!geometry)
      return geometry.error();
    auto configured = GeometryConfig(geometry.value());
    if (!configured)
      return configured.error();
    auto saved = Save();
    if (!saved)
      return saved.error();
    return ResumeOutput(active);
  };
  auto result = reconcile();
  reconciliation_pending = !result;
  if (!result) {
    next_reconciliation = QpcNow() + QpcFrequency();
    output_suspended = true;
  }
  return result;
}

Result<Json> Session::ApplyView(const Json& config, bool create, bool recovering) {
  const auto view = ViewId(config);
  const auto old = desired.find(view);
  const Json previous = old == desired.end() ? Json() : old->second;
  const auto normalized = [](Json value) {
    value.erase("id");
    value.erase("method");
    return value;
  };
  if (!previous.is_null() && normalized(previous) == normalized(config)) {
    if (reconciliation_pending || (output_suspended && has_visible_output && rtc_connected)) {
      auto reconciled = ReconcileOutput();
      if (!reconciled)
        return reconciled.error();
    }
    return Json{{"accepted", true}, {"completed", true}};
  }
  const auto rollback = [&] {
    if (previous.is_null())
      desired.erase(view);
    else
      desired[view] = previous;
  };
  desired[view] = config;
  auto geometry = DesiredGeometry();
  if (!geometry) {
    rollback();
    return geometry.error();
  }
  bool source_applied = false;
  const bool reconfiguring = !create && !recovering && !Recovering(view) && !previous.is_null() &&
                             previous.value("visible", false) && config.value("visible", false);
  const bool active = PauseOutput(reconfiguring);
  auto apply = [&]() -> Result<Json> {
    Json result = {{"accepted", true}, {"completed", true}};
    if (create) {
      auto created = CreateView(config, recovering);
      if (!created)
        return created.error();
      result = std::move(created).value();
      source_applied = true;
    }
    auto configured = GeometryConfig(geometry.value());
    if (!configured)
      return configured.error();
    source_applied = true;
    reconciliation_pending = true;
    auto saved = Save();
    if (!saved)
      return saved.error();
    auto resumed = ResumeOutput(active);
    if (!resumed)
      return resumed.error();
    reconciliation_pending = false;
    return result;
  };
  auto result = apply();
  if (!result) {
    if (!source_applied)
      rollback();
    reconciliation_pending = true;
    next_reconciliation = QpcNow() + QpcFrequency();
    output_suspended = true;
    if (reconfiguring)
      InvalidateLayout("reconfigure-failed");
    std::lock_guard lock(stats->mutex);
    stats->error = result.error().message;
  }
  return result;
}

void Session::NavigationOperation(Json& target, const Json& source) {
  for (const auto* key : {"operationId", "operationGeneration", "operationSequence"})
    if (source.contains(key))
      target[key] = source[key];
}

Result<Json> Session::CreateView(const Json& config, bool recovering) {
  auto view = ViewId(config);
  auto device = config.value("device", Json::object());
  std::string mode =
      device.is_object() ? device.value("mode", std::string("desktop")) : std::string("desktop");
  Json request = {
      {"method", "view.create"},
      {"session", id},
      {"view", view},
      {"url", recovering && fs::exists(directory / fs::path("recovery") / (view + ".json"))
                  ? std::string("about:blank")
                  : config.value("url", std::string("about:blank"))},
      {"width", config.value("width", device.value("width", 1440))},
      {"height", config.value("height", device.value("height", 900))},
      {"device", mode},
      {"visible", false}};
  if (!recovering && config.value("method", std::string()) == "view.adopt") {
    request["method"] = "view.adopt";
    request["provisionalId"] = Required(config, "provisionalId");
  }
  if (!recovering)
    NavigationOperation(request, config);
  if (device.contains("deviceScaleFactor"))
    request["device_scale_factor"] = device["deviceScaleFactor"];
  if (recovering && fs::exists(directory / fs::path("recovery") / (view + ".json")))
    request["visible"] = false;
  auto rpc_result = browser.Rpc().Request(request);
  if (!rpc_result)
    return rpc_result.error();
  auto result = std::move(rpc_result).value();
  if (recovering && fs::exists(directory / fs::path("recovery") / (view + ".json")))
    recoveries[view] = Recovery{};
  return result;
}

Json Session::Stats() {
  auto value = stats->Snapshot();
  Json requested_policy;
  {
    std::lock_guard lock(media_policy_mutex);
    requested_policy = requested_media_policy;
  }
  const auto degradation = policy_degradation.load();
  const char* preference = degradation == REMOTEKIT_RTC_MAINTAIN_RESOLUTION  ? "maintain-resolution"
                           : degradation == REMOTEKIT_RTC_MAINTAIN_FRAMERATE ? "maintain-framerate"
                                                                             : "balanced";
  const Json applied_policy =
      peer.load() ? Json{{"maxFps", policy_max_fps.load()}, {"degradationPreference", preference}}
                  : Json(nullptr);
  value["mediaPolicy"] = {{"requested", requested_policy}, {"applied", applied_policy}};
  const auto slots = pool.Stats();
  CompDiagnostics comp;
  {
    std::lock_guard lock(comp_diagnostics_mutex);
    comp = comp_diagnostics;
  }
  value["comp"] = {{"idle", slots.idle},
                   {"idleEntries", slots.idleEntries},
                   {"wakes", slots.wakes},
                   {"begins", slots.begins},
                   {"rejectIdle", slots.rejectIdle},
                   {"rejectNotReady", slots.rejectNotReady},
                   {"rejectStopped", slots.rejectStopped},
                   {"readyObserved", slots.readyObserved},
                   {"consumedCompleted", slots.consumedCompleted},
                   {"stopSent", slots.stopSent},
                   {"stopConfirmed", slots.stopConfirmed},
                   {"activeDepth", slots.activeDepth},
                   {"occupied", slots.occupied},
                   {"retiredOccupied", slots.retiredOccupied},
                   {"peakOccupied", slots.peakOccupied},
                   {"retiredGenerations", slots.retiredGenerations},
                   {"retiredGenerationsCompleted", slots.retiredGenerationsCompleted},
                   {"unknownGpuRetainedGenerations", slots.unknownGpuRetainedGenerations},
                   {"unknownGpuRetentions", slots.unknownGpuRetentions},
                   {"targetFps", slots.idle ? 0 : comp.targetFps},
                   {"resumeMaxFps", comp.resumeMaxFps},
                   {"officialMaxFps", comp.officialMaxFps},
                   {"codecMaxFps", comp.codecMaxFps},
                   {"adaptRequests", comp.adaptRequests},
                   {"adaptDrops", comp.adaptDrops},
                   {"adaptErrors", comp.adaptErrors},
                   {"adaptSizeChanges", comp.adaptSizeChanges},
                   {"presentationRefreshPending", comp.refresh.pending},
                   {"presentationRefreshAttempts", comp.refresh.attempts},
                   {"presentationRefreshForcedBegins", comp.refresh.forced_begins},
                   {"presentationRefreshSuccesses", comp.refresh.successes}};
  value["sourceWidth"] = comp.sourceWidth;
  value["sourceHeight"] = comp.sourceHeight;
  value["encodedWidth"] = comp.encodedWidth;
  value["encodedHeight"] = comp.encodedHeight;
  value["configuredIdleIdrMs"] = options.idle_idr_ms;
  value["connectionTimingMs"] = ConnectionTimings();
  value["connectionTimingOrigin"] = "endpoint-offer-monotonic";
  value["connectionTimingConnectionId"] = connection;
  value["reconciliationPending"] = reconciliation_pending.load();
  value.update(media_feedback.Snapshot(QpcNow(), QpcFrequency()));
  value["audio"] = {{"submitted", audio_submitted.load()},
                    {"gaps", audio_gaps.load()},
                    {"rejected", audio_rejected.load()}};
  value["rtcPlayoutDelayRequested"] = {{"minMs", RuntimeOptions::kRtcPlayoutMinMs},
                                       {"maxMs", RuntimeOptions::kRtcPlayoutMaxMs}};
  value["effectiveIdleIdrMs"] = effective_idle_ms.load();
  value["tailIdrSubmissions"] = tail_submissions.load();
  value["tailIdrCompletions"] = tail_completions.load();
  const auto interval = source_interval_ms.load(), age = last_tail_age_ms.load();
  value["sourceFrameIntervalMs"] = interval > 0 ? Json(interval) : Json(nullptr);
  value["encoderSelection"] = options.encoder;
  value["atlasInput"] = "render-slots";
  value["atlasSharedBorrows"] = pool.shared_borrows();
  value["atlasSharedHeldSlots"] = pool.shared_held_slots();
  value["lastTailAfterSourceMs"] = age > 0 ? Json(age) : Json(nullptr);
  return value;
}

Json Session::RtcSnapshot() const {
  const bool active = peer.load() != 0;
  return {{"active", active}, {"connectionId", active ? Json(connection) : Json(nullptr)}};
}

Json Session::InactiveSnapshot() {
  // Only a signaled process handle proves producer exit. Retire its GPU state
  // through the existing stop boundary; observing a Session never launches it.
  if (ProducerExited()) {
    fprintf(stderr, "session %s inactive snapshot observed producer exit peer=%llu %s\n",
            id.c_str(), peer.load(), ProcessDiagnostic().c_str());
    Stop();
  }
  return {{"sessionId", id},
          {"browserPid", 0},
          {"views", Json::array()},
          {"pendingPopups", Json::array()},
          {"events", durable_events},
          {"running", false},
          {"browserIncarnation", nullptr},
          {"rtc", RtcSnapshot()},
          {"stats", Stats()},
          {"recovery", RecoverySnapshot()}};
}

Result<Json> Session::Snapshot(bool output_diagnostics) {
  if (!Alive() || browser.Stopping())
    return InactiveSnapshot();
  {
    auto browser_snapshot_result_2 = BrowserSnapshot();
    if (!browser_snapshot_result_2) {
      const Error operation_error = browser_snapshot_result_2.error();
      // A producer can exit between the liveness check and any snapshot RPC.
      // Preserve desired views and confirmed events; an exit is not window.close.
      if (!browser.Rpc().Control() || ProducerExited())
        return InactiveSnapshot();
      return operation_error;
    }
    auto snapshot = std::move(browser_snapshot_result_2).value();
    Json views = Json::array(), closed_acks = Json::array();
    bool removed = false;
    for (auto& session : snapshot.at("sessions"))
      for (auto& view : session.at("views")) {
        std::string view_id = view.at("view");
        if (view.value("close_state", std::string()) == "closed") {
          removed |= desired.contains(view_id);
          {
            auto record_closed_result =
                RecordClosed(view_id, view.value("close_reason", std::string("closed")));
            if (!record_closed_result) {
              const Error operation_error = record_closed_result.error();
              // A producer can exit between the liveness check and any snapshot RPC.
              // Preserve desired views and confirmed events; an exit is not window.close.
              if (!browser.Rpc().Control() || ProducerExited())
                return InactiveSnapshot();
              return operation_error;
            }
          }
          closed_acks.push_back(view_id);
          continue;
        }
        Json item = view;
        item["viewId"] = view_id;
        if (const auto recovery = recoveries.find(view_id); recovery != recoveries.end()) {
          item["recovery"] = RecoveryStatus(recovery->second);
          item["browserPending"] = item.value("pending", false);
          // Includes Endpoint import/restore work. actual and browserPending retain
          // the observed Browser state while Control can avoid a conflicting thaw.
          item["pending"] = item.value("pending", false) || recovery->second.Pending();
          if (recovery->second.Pending()) {
            item["browserDesired"] = item["desired"];
            item["desired"] = 0;
          }
        }
        auto page_requests_result = browser.Rpc().Request(
            {{"method", "page.requests"}, {"session", id}, {"view", view_id}});
        if (!page_requests_result) {
          const Error operation_error = page_requests_result.error();
          // A producer can exit between the liveness check and any snapshot RPC.
          // Preserve desired views and confirmed events; an exit is not window.close.
          if (!browser.Rpc().Control() || ProducerExited())
            return InactiveSnapshot();
          return operation_error;
        }
        auto requests = std::move(page_requests_result).value();
        if (view.value("close_state", std::string()) == "closing")
          AddCloseRequest(item, requests);
        item["pageRequests"] = requests.value("requests", requests);
        CaptureNavigation(view);
        views.push_back(std::move(item));
      }
    if (removed) {
      auto refit_output_result = RefitOutput();
      if (!refit_output_result) {
        const Error operation_error = refit_output_result.error();
        // A producer can exit between the liveness check and any snapshot RPC.
        // Preserve desired views and confirmed events; an exit is not window.close.
        if (!browser.Rpc().Control() || ProducerExited())
          return InactiveSnapshot();
        return operation_error;
      }
    }
    {
      auto ack_closed_result = AckClosed(closed_acks);
      if (!ack_closed_result) {
        const Error operation_error = ack_closed_result.error();
        // A producer can exit between the liveness check and any snapshot RPC.
        // Preserve desired views and confirmed events; an exit is not window.close.
        if (!browser.Rpc().Control() || ProducerExited())
          return InactiveSnapshot();
        return operation_error;
      }
    }
    // Explicit, read-only diagnostic sampling; routine Control snapshots do not
    // add an output RPC. Preserve the normal snapshot if output is unavailable.
    Json output_status;
    if (output_diagnostics) {
      auto status = browser.Rpc().Request({{"method", "output.status"}});
      output_status = status ? std::move(status).value()
                             : Json{{"ok", false}, {"error", "output_status_unavailable"}};
    }
    return Json{
        {"sessionId", id},
        {"browserPid", browser.Pid()},
        {"views", views},
        {"pendingPopups", snapshot.at("sessions").at(0).value("pendingPopups", Json::array())},
        {"events", durable_events},
        {"running", true},
        {"browserIncarnation", browser.Incarnation()},
        {"rtc", RtcSnapshot()},
        {"stats", Stats()},
        {"recovery", RecoverySnapshot()},
        {"outputDiagnostics", std::move(output_status)}};
  }
}

void Session::AddCloseRequest(Json& output, const Json& requests) {
  // page.requests wraps its snapshot in "requests". Handle its documented
  // pending list without relying on JSON field order.
  const Json* data = &requests;
  if (requests.contains("requests"))
    data = &requests["requests"];
  if (!data->contains("pending"))
    return;
  for (auto& pending : (*data)["pending"]) {
    if (pending.value("kind", std::string()) == "beforeunload" ||
        pending.value("beforeunload", false)) {
      output["pending_close"] = {{"requestId", pending.at("request")}};
      output["requestId"] = pending.at("request");
      output["pending"] = true;
      return;
    }
  }
}

Result<std::string> Session::PrepareViewCommand(const Json& request, const std::string& method) {
  const bool guarded_page = method == "view.page.reply" || method == "view.close.reply" ||
                            method == "view.page.exitFullscreen";
  if (guarded_page && (!Alive() || !browser.Rpc().Control() || browser.Stopping() ||
                       browser.Incarnation().empty() ||
                       request.value("browserIncarnation", std::string()) != browser.Incarnation()))
    return Error{ErrorCode::kConflict, "stale_browser_incarnation"};
  const bool lifecycle = method == "view.lifecycle";
  const bool guarded_lifecycle = lifecycle && (request.contains("lifecycleGeneration") ||
                                               request.value("action", std::string()) == "unload");
  if (guarded_lifecycle &&
      (!request.value("requireRunning", false) ||
       request.value("browserIncarnation", std::string()) != browser.Incarnation() ||
       browser.Incarnation().empty()))
    return Error{ErrorCode::kConflict, "stale_lifecycle_recovery"};
  const bool require_running = guarded_page || ((method == "view.configure" || lifecycle) &&
                                                request.value("requireRunning", false));
  if (require_running) {
    if (!Alive() || !browser.Rpc().Control() || browser.Stopping())
      return Error{ErrorCode::kUnavailable,
                   "browser not running; guarded maintenance cannot start it"};
  } else {
    auto start_result = Start();
    if (!start_result)
      return start_result.error();
  }
  return ViewId(request);
}
}  // namespace remotekit
