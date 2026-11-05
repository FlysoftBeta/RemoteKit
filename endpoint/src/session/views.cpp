#include "session/views.hpp"
#include "util/file_io.hpp"
#include "util/result_macros.hpp"
#include "diagnostics/stats.hpp"
#include "diagnostics/timing.hpp"
#include "media/encoders.hpp"
#include "media/output.hpp"
#include "media/presentation.hpp"
#include "options.hpp"
#include "rtc/peer.hpp"
#include "session/navigation_recovery.hpp"
namespace remotekit {
using ConnectionPhase = ConnectionTiming::ConnectionPhase;
using Event = RtcEvent;
Result<void> ViewController::Save() {
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

Result<void> ViewController::RecordClosed(const std::string& view, const std::string& reason) {
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
  navigation.Forget(view);
  RK_RETURN_IF_ERROR(RemoveFile(directory / "recovery" / (view + ".json")));

  return {};
}

Result<void> ViewController::AckClosed(const Json& views) {
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

Result<void> ViewController::Start() {
  if (!browser.Stopping() && browser.Alive() && browser.Rpc().Control())
    return {};
  if (browser.Present())
    fprintf(stderr, "session %s browser replacement control=%d stop_pending=%d peer=%llu %s\n",
            id.c_str(), browser.Rpc().Control() != 0, browser.Stopping(), peer_controller.Handle(),
            browser.Diagnostic().c_str());
  auto stopped = stop_runtime();
  if (!stopped)
    return stopped.error();
  auto prepared = registry.PrepareAdapter();
  if (!prepared)
    return prepared.error();
  auto adapter = registry.Adapter();
  auto started = browser.Launch(options, id, directory, *adapter, trace);
  if (!started)
    return started.error();
  observed_closed.clear();
  navigation.Reset();
  {
    auto session_sitePreferences_result = browser.Rpc().Request(
        {{"method", "session.sitePreferences"}, {"session", id}, {"sites", site_preferences}});
    if (!session_sitePreferences_result)
      return session_sitePreferences_result.error();
  }
  {
    auto browser_snapshot_result = browser.Snapshot();
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

Result<ViewController::Geometry> ViewController::DesiredGeometry() {
  std::vector<protocol::PackItem> items;
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
  const auto plan = protocol::PlanAtlas(items, items.empty() ? 1.f : scale,
                                        RuntimeOptions::kAtlasAllocationAlignment);
  if (!plan)
    return Error{ErrorCode::kLimitExceeded,
                 "visible source atlas cannot be packed within the aligned 16-megapixel/8192-pixel "
                 "resource budget"};
  return Geometry{plan->width, plan->height, plan->scale};
}

Result<void> ViewController::GeometryConfig(const Geometry& value) {
  if (!protocol::AtlasAllocationDimensions(value.width, value.height, value.scale,
                                           RuntimeOptions::kAtlasAllocationAlignment))
    return Error{ErrorCode::kLimitExceeded,
                 "source atlas exceeds the aligned 16-megapixel/8192-pixel resource budget"};
  Json configs = Json::array();
  bool visible_output = false;
  for (const auto& [view, config] : desired) {
    const auto device = config.value("device", Json::object());
    const bool visible = !navigation.Recovering(view) && config.value("visible", false);
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
    auto output_configure_result = output.Configure(value.width, value.height, value.scale,
                                                    std::move(configs), visible_output);
    if (!output_configure_result)
      return output_configure_result.error();
  }
  atlas_width = value.width;
  atlas_height = value.height;
  atlas_scale = value.scale;

  return {};
}

Result<void> ViewController::RefitOutput() {
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

Result<void> ViewController::ReconcileOutput() {
  auto paused = output.PauseOutput();
  if (!paused) {
    reconciliation_pending = true;
    next_reconciliation = QpcNow() + QpcFrequency();
    output.Suspend();
    return paused.error();
  }
  const bool active = paused.value();
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
    return output.ResumeOutput(active);
  };
  auto result = reconcile();
  reconciliation_pending = !result;
  if (!result) {
    next_reconciliation = QpcNow() + QpcFrequency();
    output.Suspend();
  }
  return result;
}

Result<Json> ViewController::ApplyView(const Json& config, bool create, bool recovering) {
  const auto view = ViewId(config);
  const auto old = desired.find(view);
  const Json previous = old == desired.end() ? Json() : old->second;
  const auto normalized = [](Json value) {
    value.erase("id");
    value.erase("method");
    return value;
  };
  if (!previous.is_null() && normalized(previous) == normalized(config)) {
    if (reconciliation_pending ||
        (output.Suspended() && output.Visible() && peer_controller.Connected())) {
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
  const bool reconfiguring = !create && !recovering && !navigation.Recovering(view) &&
                             !previous.is_null() && previous.value("visible", false) &&
                             config.value("visible", false);
  auto paused = output.PauseOutput(reconfiguring);
  if (!paused) {
    rollback();
    reconciliation_pending = true;
    next_reconciliation = QpcNow() + QpcFrequency();
    output.Suspend();
    return paused.error();
  }
  const bool active = paused.value();
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
    auto resumed = output.ResumeOutput(active);
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
    output.Suspend();
    if (reconfiguring)
      presentation.InvalidateLayout("reconfigure-failed");
    registry.SetError(result.error().message);
  }
  return result;
}

void ViewController::NavigationOperation(Json& target, const Json& source) {
  for (const auto* key : {"operationId", "operationGeneration", "operationSequence"})
    if (source.contains(key))
      target[key] = source[key];
}

Result<Json> ViewController::CreateView(const Json& config, bool recovering) {
  auto view = ViewId(config);
  RK_ASSIGN_OR_RETURN(has_recovery_file, FileExists(directory / "recovery" / (view + ".json")));
  auto device = config.value("device", Json::object());
  std::string mode =
      device.is_object() ? device.value("mode", std::string("desktop")) : std::string("desktop");
  Json request = {
      {"method", "view.create"},
      {"session", id},
      {"view", view},
      {"url", recovering && has_recovery_file ? std::string("about:blank")
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
  if (recovering && has_recovery_file)
    request["visible"] = false;
  auto rpc_result = browser.Rpc().Request(request);
  if (!rpc_result)
    return rpc_result.error();
  auto result = std::move(rpc_result).value();
  if (recovering && has_recovery_file)
    navigation.Begin(view);
  return result;
}

Json ViewController::RtcSnapshot() const {
  const bool active = peer_controller.Handle() != 0;
  return {{"active", active},
          {"connectionId", active ? Json(peer_controller.Connection()) : Json(nullptr)}};
}

Result<Json> ViewController::InactiveSnapshot() {
  // Only a signaled process handle proves producer exit. Retire its GPU state
  // through the existing stop boundary; observing a Session never launches it.
  if (browser.Exited()) {
    fprintf(stderr, "session %s inactive snapshot observed producer exit peer=%llu %s\n",
            id.c_str(), peer_controller.Handle(), browser.Diagnostic().c_str());
    auto stopped = stop_runtime();
    if (!stopped)
      return stopped.error();
  }
  return Json{{"sessionId", id},
              {"browserPid", 0},
              {"views", Json::array()},
              {"pendingPopups", Json::array()},
              {"events", durable_events},
              {"running", false},
              {"browserIncarnation", nullptr},
              {"rtc", RtcSnapshot()},
              {"stats", diagnostics.Stats()},
              {"recovery", navigation.RecoverySnapshot()}};
}

Result<Json> ViewController::Snapshot(bool output_diagnostics) {
  if (!browser.Alive() || browser.Stopping())
    return InactiveSnapshot();
  {
    auto browser_snapshot_result_2 = browser.Snapshot();
    if (!browser_snapshot_result_2) {
      const Error operation_error = browser_snapshot_result_2.error();
      // A producer can exit between the liveness check and any snapshot RPC.
      // Preserve desired views and confirmed events; an exit is not window.close.
      if (!browser.Rpc().Control() || browser.Exited())
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
              if (!browser.Rpc().Control() || browser.Exited())
                return InactiveSnapshot();
              return operation_error;
            }
          }
          closed_acks.push_back(view_id);
          continue;
        }
        Json item = view;
        item["viewId"] = view_id;
        navigation.Annotate(view_id, item);
        auto page_requests_result = browser.Rpc().Request(
            {{"method", "page.requests"}, {"session", id}, {"view", view_id}});
        if (!page_requests_result) {
          const Error operation_error = page_requests_result.error();
          // A producer can exit between the liveness check and any snapshot RPC.
          // Preserve desired views and confirmed events; an exit is not window.close.
          if (!browser.Rpc().Control() || browser.Exited())
            return InactiveSnapshot();
          return operation_error;
        }
        auto requests = std::move(page_requests_result).value();
        if (view.value("close_state", std::string()) == "closing")
          AddCloseRequest(item, requests);
        item["pageRequests"] = requests.value("requests", requests);
        navigation.CaptureNavigation(view);
        views.push_back(std::move(item));
      }
    if (removed) {
      auto refit_output_result = RefitOutput();
      if (!refit_output_result) {
        const Error operation_error = refit_output_result.error();
        // A producer can exit between the liveness check and any snapshot RPC.
        // Preserve desired views and confirmed events; an exit is not window.close.
        if (!browser.Rpc().Control() || browser.Exited())
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
        if (!browser.Rpc().Control() || browser.Exited())
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
        {"stats", diagnostics.Stats()},
        {"recovery", navigation.RecoverySnapshot()},
        {"outputDiagnostics", std::move(output_status)}};
  }
}

void ViewController::AddCloseRequest(Json& output, const Json& requests) {
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

Result<std::string> ViewController::PrepareViewCommand(const Json& request,
                                                       const std::string& method) {
  const bool guarded_page = method == "view.page.reply" || method == "view.close.reply" ||
                            method == "view.page.exitFullscreen";
  if (guarded_page && (!browser.Alive() || !browser.Rpc().Control() || browser.Stopping() ||
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
    if (!browser.Alive() || !browser.Rpc().Control() || browser.Stopping())
      return Error{ErrorCode::kUnavailable,
                   "browser not running; guarded maintenance cannot start it"};
  } else {
    auto start_result = Start();
    if (!start_result)
      return start_result.error();
  }
  return ViewId(request);
}

Result<Json> ViewController::ManageSessionEnsure(const Json& request) {
  {
    auto start_result = Start();
    if (!start_result)
      return start_result.error();
  }
  return Json{{"sessionId", id},
              {"browserPid", browser.Pid()},
              {"running", true},
              {"accepted", true},
              {"browserIncarnation", browser.Incarnation()},
              {"recovery", navigation.RecoverySnapshot()}};
}

Result<Json> ViewController::ManageSessionSnapshot(const Json& request) {
  return Snapshot(request.value("outputDiagnostics", false));
}

Result<Json> ViewController::ManageSessionEventsAck(const Json& request) {
  const auto ids = request.at("eventIds");
  if (!ids.is_array() || ids.size() > 256)
    return Error{ErrorCode::kInvalidRequest, "invalid event ids"};
  std::set<std::string> acknowledged;
  for (const auto& value : ids) {
    if (!value.is_string())
      return Error{ErrorCode::kInvalidRequest, "invalid event id"};
    acknowledged.insert(value.get<std::string>());
  }
  Json remaining = Json::array();
  for (const auto& event : durable_events)
    if (!acknowledged.contains(event.at("eventId").get<std::string>()))
      remaining.push_back(event);
  {
    auto save_result = store.Save("events.json", {{"next", next_event}, {"events", remaining}});
    if (!save_result)
      return save_result.error();
  }
  durable_events = std::move(remaining);
  return Json{{"accepted", true}, {"remaining", durable_events.size()}};
}

Result<Json> ViewController::ManageSessionSitePreferences(const Json& request) {
  const auto sites = request.at("sites");
  if (!sites.is_object() || sites.size() > 4096)
    return Error{ErrorCode::kInvalidRequest, "invalid site preferences"};
  for (auto& [origin, value] : sites.items()) {
    if (origin.size() > 2048 ||
        !(origin.starts_with("https://") || origin.starts_with("http://")) || !value.is_object() ||
        !value.contains("tabletUa") || !value["tabletUa"].is_boolean())
      return Error{ErrorCode::kInvalidRequest, "invalid site preference"};
  }
  if (browser.Alive() && browser.Rpc().Control()) {
    auto session_sitePreferences_result = browser.Rpc().Request(
        {{"method", "session.sitePreferences"}, {"session", id}, {"sites", sites}});
    if (!session_sitePreferences_result)
      return session_sitePreferences_result.error();
  }
  {
    auto save_result_2 = store.Save("site-preferences.json", sites);
    if (!save_result_2)
      return save_result_2.error();
  }
  site_preferences = sites;
  return Json{{"accepted", true}, {"applied", browser.Alive() && browser.Rpc().Control() != 0}};
}

Result<Json> ViewController::ManageViewNavigationAck(const Json& request) {
  if (!browser.Alive() || !browser.Rpc().Control() || browser.Stopping() ||
      request.value("browserIncarnation", std::string()) != browser.Incarnation())
    return Error{ErrorCode::kConflict, "stale_browser_incarnation"};
  Json command = {{"method", "navigation.ack"}, {"session", id}, {"view", ViewId(request)}};
  NavigationOperation(command, request);
  return browser.Rpc().Request(command);
}

Result<Json> ViewController::ManageViewEnsure(const Json& request) {
  const auto method = Required(request, "method");
  auto prepare_view_command_result = PrepareViewCommand(request, Required(request, "method"));
  if (!prepare_view_command_result)
    return prepare_view_command_result.error();
  const auto view = std::move(prepare_view_command_result).value();

  if (!desired.contains(view) && durable_events.size() + desired.size() >= 256)
    return Error{ErrorCode::kConflict,
                 "closed event capacity reserved; acknowledge events before creating views"};
  if (method == "view.adopt" && desired.contains(view)) {
    if (desired.at(view).value("provisionalId", std::string()) !=
        Required(request, "provisionalId"))
      return Error{ErrorCode::kConflict, "view already belongs to another popup"};
    return Json{{"accepted", true}, {"completed", true}};
  }
  if (desired.contains(view))
    return ApplyView(request, false);
  return ApplyView(request, true);
}

Result<Json> ViewController::ManageViewClose(const Json& request) {
  auto prepare_view_command_result_2 = PrepareViewCommand(request, Required(request, "method"));
  if (!prepare_view_command_result_2)
    return prepare_view_command_result_2.error();
  const auto view = std::move(prepare_view_command_result_2).value();

  navigation.CancelRecovery(view);
  auto browser_snapshot_result = browser.Snapshot();
  if (!browser_snapshot_result)
    return browser_snapshot_result.error();
  const auto snapshot = std::move(browser_snapshot_result).value();
  Json identity = {{"browserIncarnation", browser.Incarnation()}};
  for (const auto& session : snapshot.at("sessions"))
    for (const auto& current : session.at("views"))
      if (current.value("view", std::string()) == view && current.contains("instance") &&
          current.contains("document")) {
        identity["instance"] = current["instance"];
        identity["document"] = current["document"];
      }
  auto view_close_result = browser.Rpc().Request({{"method", "view.close"},
                                                  {"session", id},
                                                  {"view", view},
                                                  {"force", request.value("force", false)}});
  if (!view_close_result)
    return view_close_result.error();
  auto result = std::move(view_close_result).value();
  bool closed = result.value("completed", false);
  if (closed) {
    {
      auto record_closed_result = RecordClosed(view, "requested");
      if (!record_closed_result)
        return record_closed_result.error();
    }
    {
      auto ack_closed_result = AckClosed(Json::array({view}));
      if (!ack_closed_result)
        return ack_closed_result.error();
    }
    {
      auto refit_output_result = RefitOutput();
      if (!refit_output_result)
        return refit_output_result.error();
    }
    identity["closed"] = true;
    identity["completed"] = true;
    return identity;
  }
  auto page_requests_result =
      browser.Rpc().Request({{"method", "page.requests"}, {"session", id}, {"view", view}});
  if (!page_requests_result)
    return page_requests_result.error();
  auto requests = std::move(page_requests_result).value();
  Json output = {{"accepted", true}, {"pageRequests", requests.value("requests", requests)}};
  output.update(identity);
  AddCloseRequest(output, requests);
  return output;
}

Result<Json> ViewController::ManageViewCloseReply(const Json& request) {
  auto prepare_view_command_result_3 = PrepareViewCommand(request, Required(request, "method"));
  if (!prepare_view_command_result_3)
    return prepare_view_command_result_3.error();
  const auto view = std::move(prepare_view_command_result_3).value();

  auto close_request_id = Required(request, "requestId");
  if (!request.contains("accept") || !request["accept"].is_boolean())
    return Error{ErrorCode::kInvalidRequest, "accept boolean required"};
  auto page_reply_result = browser.Rpc().Request({{"method", "page.reply"},
                                                  {"session", id},
                                                  {"view", view},
                                                  {"request", close_request_id},
                                                  {"accept", request["accept"]},
                                                  {"instance", Required(request, "instance")},
                                                  {"document", Required(request, "document")},
                                                  {"close_only", true}});
  if (!page_reply_result)
    return page_reply_result.error();
  auto result = std::move(page_reply_result).value();
  return Json{{"accepted", true}, {"browser", result}};
}

Result<Json> ViewController::ManageViewPageReply(const Json& request) {
  auto prepare_view_command_result_4 = PrepareViewCommand(request, Required(request, "method"));
  if (!prepare_view_command_result_4)
    return prepare_view_command_result_4.error();
  const auto view = std::move(prepare_view_command_result_4).value();

  if (!desired.contains(view))
    return Error{ErrorCode::kNotFound, "view not found"};
  if (!request.contains("accept") || !request["accept"].is_boolean())
    return Error{ErrorCode::kInvalidRequest, "accept boolean required"};
  Json command = {{"method", "page.reply"},
                  {"session", id},
                  {"view", view},
                  {"request", Required(request, "requestId")},
                  {"instance", Required(request, "instance")},
                  {"document", Required(request, "document")},
                  {"accept", request["accept"]},
                  {"dialog_only", true}};
  if (request.contains("text")) {
    if (!request["text"].is_string() ||
        request["text"].get_ref<const std::string&>().size() > 16384)
      return Error{ErrorCode::kInvalidRequest, "invalid or oversized dialog text"};
    command["text"] = request["text"];
  }
  auto rpc_result = browser.Rpc().Request(command);
  if (!rpc_result)
    return rpc_result.error();
  return Json{{"accepted", true}, {"browser", std::move(rpc_result).value()}};
}

Result<Json> ViewController::ManageViewPageExitFullscreen(const Json& request) {
  auto prepare_view_command_result_5 = PrepareViewCommand(request, Required(request, "method"));
  if (!prepare_view_command_result_5)
    return prepare_view_command_result_5.error();
  const auto view = std::move(prepare_view_command_result_5).value();

  if (!desired.contains(view))
    return Error{ErrorCode::kNotFound, "view not found"};
  return browser.Rpc().Request({{"method", "page.exitFullscreen"},
                                {"session", id},
                                {"view", view},
                                {"instance", Required(request, "instance")},
                                {"document", Required(request, "document")}});
}

Result<Json> ViewController::ManageViewCommand(const Json& request) {
  auto prepare_view_command_result_6 = PrepareViewCommand(request, Required(request, "method"));
  if (!prepare_view_command_result_6)
    return prepare_view_command_result_6.error();
  const auto view = std::move(prepare_view_command_result_6).value();

  const auto action = Required(request, "command");
  if (action != "back" && action != "forward" && action != "reload" && action != "stop")
    return Error{ErrorCode::kInvalidRequest, "unsupported page command"};
  if (navigation.CancelRecovery(view)) {
    {
      auto view_recreate_result = browser.Rpc().Request(
          {{"method", "view.recreate"},
           {"session", id},
           {"view", view},
           {"url", desired.at(view).value("url", std::string("about:blank"))}});
      if (!view_recreate_result)
        return view_recreate_result.error();
    }
    RK_RETURN_IF_ERROR(RemoveFile(directory / "recovery" / (view + ".json")));
    {
      auto reconcile_output_result = ReconcileOutput();
      if (!reconcile_output_result)
        return reconcile_output_result.error();
    }
  }
  Json command = {{"method", "page.command"}, {"session", id}, {"view", view}, {"action", action}};
  NavigationOperation(command, request);
  return browser.Rpc().Request(command);
}

Result<Json> ViewController::ManageViewLifecycle(const Json& request) {
  const bool guarded_lifecycle =
      request.contains("lifecycleGeneration") || request.value("action", std::string()) == "unload";
  auto prepare_view_command_result_7 = PrepareViewCommand(request, Required(request, "method"));
  if (!prepare_view_command_result_7)
    return prepare_view_command_result_7.error();
  const auto view = std::move(prepare_view_command_result_7).value();

  const auto action = Required(request, "action");
  if (guarded_lifecycle && action != "unload" && action != "restore")
    return Error{ErrorCode::kInvalidRequest, "unsupported guarded lifecycle action"};
  if (action != "discard" && action != "freeze" && action != "restore" && action != "unload")
    return Error{ErrorCode::kInvalidRequest, "unsupported lifecycle action"};
  if (navigation.Recovering(view)) {
    if (guarded_lifecycle)
      return Error{ErrorCode::kConflict, "navigation_recovery_pending"};
    return Json{{"accepted", true},
                {"pending", true},
                {"completed", false},
                {"recovery", navigation.ViewStatus(view)}};
  }
  Json command = {{"method", "lifecycle"}, {"session", id}, {"view", view}, {"action", action}};
  if (guarded_lifecycle)
    command["expected_lifecycle_generation"] = Required(request, "lifecycleGeneration");
  return browser.Rpc().Request(std::move(command));
}

Result<Json> ViewController::ManageViewNavigate(const Json& request) {
  auto prepare_view_command_result_8 = PrepareViewCommand(request, Required(request, "method"));
  if (!prepare_view_command_result_8)
    return prepare_view_command_result_8.error();
  const auto view = std::move(prepare_view_command_result_8).value();

  const auto url = Required(request, "url");
  navigation.Forget(view);
  const bool cancelled = navigation.CancelRecovery(view);
  Json command = {{"method", cancelled ? "view.recreate" : "navigate"},
                  {"session", id},
                  {"view", view},
                  {"url", url}};
  NavigationOperation(command, request);
  auto rpc_result_2 = browser.Rpc().Request(command);
  if (!rpc_result_2)
    return rpc_result_2.error();
  auto result = std::move(rpc_result_2).value();
  RK_RETURN_IF_ERROR(RemoveFile(directory / "recovery" / (view + ".json")));
  navigation.EraseRevision(view);
  if (desired.contains(view)) {
    desired[view]["url"] = request["url"];
    {
      auto save_result_3 = Save();
      if (!save_result_3)
        return save_result_3.error();
    }
  }
  if (cancelled) {
    auto reconcile_output_result_2 = ReconcileOutput();
    if (!reconcile_output_result_2)
      return reconcile_output_result_2.error();
  }
  return result;
}

Result<Json> ViewController::ManageViewConfigure(const Json& request) {
  auto prepare_view_command_result_9 = PrepareViewCommand(request, Required(request, "method"));
  if (!prepare_view_command_result_9)
    return prepare_view_command_result_9.error();
  const auto view = std::move(prepare_view_command_result_9).value();

  if (!desired.contains(view))
    return Error{ErrorCode::kNotFound, "view not found"};
  auto config = desired.at(view);
  for (auto& [key, value] : request.items())
    if (key != "id" && key != "method" && key != "requireRunning")
      config[key] = value;
  return ApplyView(config, false);
}
}  // namespace remotekit

namespace remotekit {
Result<void> ViewController::Initialize() {
  RK_RETURN_IF_ERROR(CreateDirectories(directory));
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
  return {};
}
void ViewController::Reset() {
  reconciliation_pending = false;
  output.SetVisible(false);
}

}  // namespace remotekit
