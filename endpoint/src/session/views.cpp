#include "session/site_preferences.hpp"
#include "util/log.hpp"
#include "protocol/page_viewport.hpp"
#include <winsock2.h>
#include <ws2tcpip.h>
#include "session/views.hpp"
#include "session/view_configuration.hpp"
#include <charconv>
#include <cmath>
#include <regex>
#include <winhttp.h>
#include "util/wire_error.hpp"
#include "util/file_io.hpp"
#include "util/result_macros.hpp"
#include "diagnostics/stats.hpp"
#include "diagnostics/timing.hpp"
#include "session/encoders.hpp"
#include "session/output.hpp"
#include "session/presentation.hpp"
#include "options.hpp"
#include "rtc/peer.hpp"
#include "session/navigation_recovery.hpp"
#include "persistence/phase_timing.hpp"
namespace remotekit {
using ConnectionPhase = ConnectionTiming::ConnectionPhase;
using Event = RtcEvent;

Result<void> ViewController::StageDesired(const Json& document) {
  RK_RETURN_IF_ERROR(view_store.SaveDesired(document.at("views"),
                                            document.at("placementEpoch").get<uint64_t>(),
                                            document.at("revision").get<std::string>()));
  RK_ASSIGN_OR_RETURN(retired, view_store.Retired());
  for (const auto& view : retired)
    observed_closed.insert(view.get<std::string>());
  std::map<std::string, Json> staged;
  desired_order.clear();
  for (const auto& value : document.at("views")) {
    const auto view = value.at("viewId").get<std::string>();
    if (observed_closed.contains(view))
      continue;
    auto config = value;
    if (document.at("lock").at("state") != "unlocked")
      config["visible"] = false;
    staged.emplace(view, std::move(config));
    desired_order.push_back(view);
  }
  desired = std::move(staged);
  reconciliation_pending = true;
  return {};
}
Result<void> ViewController::ConvergeDesired() {
  RK_ASSIGN_OR_RETURN(snapshot, Snapshot());
  if (!snapshot.value("running", false))
    return browser.Unavailable("Browser is not running");
  std::set<std::string> existing;
  for (const auto& view : snapshot.at("views")) {
    const auto name = view.at("viewId").get<std::string>();
    if (!desired.contains(name)) {
      RK_ASSIGN_OR_RETURN(closed, ManageViewClose({{"method", "view.close"},
                                                   {"viewId", name},
                                                   {"browserIncarnation", browser.Incarnation()},
                                                   {"force", true}}));
    } else {
      existing.insert(name);
    }
  }
  for (const auto& view : desired_order) {
    if (!desired.contains(view) || existing.contains(view))
      continue;
    const auto config = desired.at(view);
    if (config.at("presence") == "ifPresent") {
      desired.erase(view);
      continue;
    }
    if (config.contains("signIn")) {
      RK_ASSIGN_OR_RETURN(current, view_store.SignInCurrent(view, browser.Incarnation()));
      if (!current) {
        desired.erase(view);
        continue;
      }
    }
    auto created = CreateView(config, restoring_views.contains(view));
    if (!created)
      return created.error();
    restoring_views.erase(view);
  }
  return ReconcileOutput();
}
Result<void> ViewController::RecordClosed(const std::string& view, const std::string& reason) {
  if (!observed_closed.contains(view)) {
    RK_ASSIGN_OR_RETURN(event, view_store.Close(view, reason, browser.Incarnation()));
    desired.erase(view);
    observed_closed.insert(view);
  }
  navigation.Forget(view);
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
  const bool retained = !browser.Stopping() && browser.Alive() && browser.Rpc().Control();
  if (retained) {
    auto health = browser.HealthCheck();
    if (!health)
      return health.error();
    if (browser.Initialized())
      return {};
  }
  if (browser.Stopping())
    return Error{ErrorCode::kUnavailable, "Browser is stopping; waiting for process exit"};
  if (browser.Alive() && !browser.Rpc().Control() && !browser.Rpc().Disconnected())
    return browser.HealthCheck();
  if (!retained) {
    auto admitted = browser.AdmitLaunch();
    if (!admitted)
      return admitted.error();
    if (browser.Present())
      LogEvent(LogLevel::kWarn, "browser.replacing",
               {{"sessionId", id},
                {"reason", browser.Exited() ? "process_exited" : "control_pipe_disconnected"},
                {"control", browser.Rpc().Control() != 0},
                {"stopPending", browser.Stopping()},
                {"peer", peer_controller.Handle()},
                {"diagnostic", browser.Diagnostic()}});
    auto stopped = stop_runtime();
    if (!stopped)
      return browser.Unavailable(stopped.error().message);
    const auto adapter_start = PhaseClock::now();
    auto prepared = registry.PrepareAdapter();
    browser.OpenPhase("adapter", PhaseMs(adapter_start));
    if (!prepared)
      return prepared.error();
    auto adapter = registry.Adapter();
    auto started = browser.Launch(options, id, directory, *adapter, trace);
    if (!started)
      return started.error();
    for (const auto& [view, config] : desired)
      restoring_views.insert(view);
    navigation.Reset();
  }
  if (before_views) {
    auto seeded = before_views();
    if (!seeded)
      return seeded.error();
  }
  {
    auto session_sitePreferences_result = browser.Rpc().Request(
        {{"method", "session.sitePreferences"}, {"session", id}, {"sites", site_preferences}});
    if (!session_sitePreferences_result)
      return session_sitePreferences_result.error();
  }
  std::set<std::string> existing;
  {
    auto browser_snapshot_result = browser.Snapshot();
    if (!browser_snapshot_result)
      return browser_snapshot_result.error();
    for (const auto& session : browser_snapshot_result.value().at("sessions"))
      for (const auto& view : session.at("views"))
        existing.insert(view.at("view").get<std::string>());
  }
  reconciliation_pending = false;
  browser.MarkInitialized();

  return {};
}

Result<ViewController::Geometry> ViewController::DesiredGeometry() {
  std::vector<protocol::PackItem> items;
  float scale = .5f;
  for (auto& [view, config] : desired) {
    if (!config.at("visible").get<bool>())
      continue;
    const auto device = config.at("device");
    int w = config.at("width").get<int>();
    int h = config.at("height").get<int>();
    if (w < 1 || h < 1 || w > 8192 || h > 8192)
      return Error{ErrorCode::kInvalidRequest, "invalid viewport dimensions"};
    items.push_back({std::stoull(view), w, h, 1.0});
    scale = std::max(scale, device.at("deviceScaleFactor").get<float>());
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
    const auto device = config.at("device");
    const bool visible = !navigation.Recovering(view) && config.at("visible").get<bool>();
    visible_output |= visible;
    configs.push_back({{"session", id},
                       {"view", view},
                       {"width", config.at("width").get<int>()},
                       {"height", config.at("height").get<int>()},
                       {"device", device.at("mode").get<std::string>()},
                       {"device_scale_factor", device.at("deviceScaleFactor").get<float>()},
                       {"visible", visible},
                       {"occludedBottom", visible ? config.at("occludedBottom").get<int>() : 0},
                       {"occlusionRevision", config.at("occlusionRevision")}});
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
  auto reconcile = [&]() -> Result<void> {
    auto geometry = DesiredGeometry();
    if (!geometry)
      return geometry.error();
    return GeometryConfig(geometry.value());
  };
  auto result = reconcile();
  reconciliation_pending = !result;
  if (!result) {
    next_reconciliation = QpcNow() + QpcFrequency();
    output.Suspend();
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
  RK_ASSIGN_OR_RETURN(has_recovery_file, recovery_store.Contains(view));
  RK_ASSIGN_OR_RETURN(resume_url, view_store.ResumeUrl(view, config.at("url").get<std::string>()));
  auto device = config.at("device");
  const auto mode = device.at("mode").get<std::string>();
  Json request = {
      {"method", "view.create"},
      {"session", id},
      {"view", view},
      {"url", recovering && has_recovery_file ? std::string("about:blank") : resume_url},
      {"width", config.at("width").get<int>()},
      {"height", config.at("height").get<int>()},
      {"device", mode},
      {"visible", false}};
  RK_RETURN_IF_ERROR(ValidateSignIn(config));
  if (config.contains("signIn"))
    request["signIn"] = config["signIn"];
  if (config.contains("adopt")) {
    if (config["adopt"]["browserIncarnation"] != browser.Incarnation())
      return Error{ErrorCode::kCanceled, "popup Browser is retired"};
    request["method"] = "view.adopt";
    request["provisionalId"] = config["adopt"]["provisionalId"];
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
          {"avSync", active ? Json(peer_controller.AvSync()) : Json(nullptr)},
          {"connectionId", active ? Json(peer_controller.Connection()) : Json(nullptr)}};
}

Result<Json> ViewController::InactiveSnapshot() {
  // Only a signaled process handle proves producer exit. Retire its GPU state
  // through the existing stop boundary; observing a Session never launches it.
  if (browser.Exited()) {
    browser.RecordCrash();
    LogEvent(LogLevel::kWarn, "browser.exit_observed",
             {{"sessionId", id},
              {"peer", peer_controller.Handle()},
              {"diagnostic", browser.Diagnostic()}});
    auto stopped = stop_runtime();
    if (!stopped)
      return browser.Unavailable(stopped.error().message);
  }
  return Json{
      {"browserRestart", browser.RestartState()},
      {"status", browser.Crashed() ? WireError(browser.Unavailable("Browser process exited"))
                                   : Json(nullptr)},
      {"sessionId", id},
      {"browserPid", 0},
      {"views", Json::array()},
      {"pendingPopups", Json::array()},
      {"downloadsInProgress", 0},
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
    Json download_events = Json::array();
    for (const auto& session : snapshot.at("sessions"))
      for (const auto& event : session.value("events", Json::array()))
        if (event.value("type", std::string()) == "download.completed")
          download_events.push_back(event);
    auto imported = downloads.Observe(
        browser.Incarnation(), download_events, id,
        [this](Json command) { return browser.Rpc().Request(std::move(command)); });
    download_reconciliation_failed = !imported;
    if (!imported)
      LogError(LogLevel::kWarn, "download.reconcile_failed", imported.error());
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
        item.erase("view");
        item.erase("session");
        item.erase("tenant");
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
        item["pageRequests"] = {{"pending", requests.at("pending")},
                                {"events", requests.at("events")}};
        {
          std::lock_guard lock(chooser_mutex);
          chooser_requests[view_id] = {{"instance", view.at("instance")},
                                       {"document", view.at("document")},
                                       {"browserIncarnation", browser.Incarnation()},
                                       {"pending", item["pageRequests"].at("pending")}};
        }
        RK_RETURN_IF_ERROR(navigation.CaptureNavigation(view));
        if (desired.contains(view_id) && !navigation.Recovering(view_id) && view.contains("url") &&
            view["url"].is_string()) {
          const auto url = view["url"].get<std::string>();
          if (!url.empty() && resume_urls[view_id] != url) {
            RK_RETURN_IF_ERROR(view_store.CommitNavigation(view_id, url));
            resume_urls[view_id] = url;
          }
        }
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
                             : Json{{"ok", false}, {"error", WireError(status.error())}};
    }
    return Json{
        {"sessionId", id},
        {"browserPid", browser.Pid()},
        {"views", views},
        {"pendingPopups", snapshot.at("sessions").at(0).value("pendingPopups", Json::array())},
        {"downloadsInProgress", snapshot.at("sessions").at(0).value("downloadsInProgress", 0)},
        {"running", true},
        {"browserIncarnation", browser.Incarnation()},
        {"rtc", RtcSnapshot()},
        {"stats", diagnostics.Stats()},
        {"recovery", navigation.RecoverySnapshot()},
        {"outputDiagnostics", std::move(output_status)}};
  }
}

Result<std::vector<std::string>> ViewController::FileChooserAccept(
    const FileUploadStore::Binding& binding) const {
  std::lock_guard lock(chooser_mutex);
  const auto found = chooser_requests.find(binding.view);
  if (found != chooser_requests.end() && found->second.at("instance") == binding.instance &&
      found->second.at("document") == binding.document &&
      found->second.at("browserIncarnation") == binding.browser_incarnation) {
    for (const auto& request : found->second.at("pending")) {
      if (request.value("request", std::string()) == binding.request &&
          request.value("kind", std::string()) == "file_chooser") {
        if (request.value("accept_types_omitted", false))
          return std::vector<std::string>{};
        return request.at("accept_types").get<std::vector<std::string>>();
      }
    }
  }
  return Error{ErrorCode::kConflict, "stale_file_request_target"};
}

void ViewController::AddCloseRequest(Json& output, const Json& requests) {
  for (auto& pending : requests.at("pending")) {
    if (pending.value("kind", std::string()) == "beforeunload" ||
        pending.value("beforeunload", false)) {
      output["pending_close"] = {{"requestId", pending.at("request")}};
      output["requestId"] = pending.at("request");
      output["pending"] = true;
      return;
    }
  }
}

Result<std::string> ViewController::PrepareViewCommand(const Json& request) {
  if (!browser.Alive() || !browser.Rpc().Control() || browser.Stopping())
    return Error{ErrorCode::kUnavailable, "Browser is not running"};
  if (request.value("browserIncarnation", std::string()) != browser.Incarnation())
    return Error{ErrorCode::kConflict, "stale_browser_incarnation"};
  return ViewId(request);
}

namespace {
bool ValidImportId(const Json& request) {
  const auto value = request.find("importId");
  return value != request.end() && value->is_string() &&
         !value->get_ref<const std::string&>().empty() &&
         value->get_ref<const std::string&>().size() <= 128;
}
Json StorageImportStatus(const Json& reply, const std::string& incarnation) {
  Json result = {{"importId", reply.at("importId")},
                 {"state", reply.at("state")},
                 {"browserIncarnation", incarnation}};
  for (const auto* field : {"cookies", "localStorage"})
    if (reply.contains(field))
      result[field] = reply[field];
  return result;
}
}  // namespace

Result<Json> ViewController::ManageSessionStorageImport(const Json& request) {
  if (!ValidImportId(request) || !request.contains("cookies") || !request["cookies"].is_array() ||
      !request.contains("localStorage") || !request["localStorage"].is_array())
    return Error{ErrorCode::kInvalidRequest, "importId, cookies and localStorage required"};
  if (!browser.Alive() || !browser.Rpc().Control() || browser.Stopping())
    return Error{ErrorCode::kUnavailable, "Browser is not running"};
  auto reply = browser.Rpc().Request({{"method", protocol::kStorageImport},
                                      {"session", id},
                                      {"importId", request["importId"]},
                                      {"cookies", request["cookies"]},
                                      {"localStorage", request["localStorage"]}});
  if (!reply)
    return reply.error();
  return StorageImportStatus(reply.value(), browser.Incarnation());
}

Result<Json> ViewController::ManageSessionStorageImportStatus(const Json& request) {
  if (!ValidImportId(request))
    return Error{ErrorCode::kInvalidRequest, "importId string required (1..128 characters)"};
  if (!browser.Alive() || !browser.Rpc().Control() || browser.Stopping())
    return Error{ErrorCode::kNotFound, "Storage import Browser exited"};
  auto reply = browser.Rpc().Request({{"method", protocol::kStorageImportStatus},
                                      {"session", id},
                                      {"importId", request["importId"]}});
  if (!reply)
    return reply.error();
  return StorageImportStatus(reply.value(), browser.Incarnation());
}

Result<Json> ViewController::ManageSessionIdentity(const Json&) {
  if (!browser.Alive() || !browser.Rpc().Control() || browser.Stopping())
    return Error{ErrorCode::kUnavailable, "Browser is not running"};
  auto reply = browser.Rpc().Request({{"method", protocol::kIdentity}, {"session", id}});
  if (!reply)
    return reply.error();
  return Json{{"accepted", true},
              {"userAgent", reply.value().at("userAgent")},
              {"metadata", reply.value().at("metadata")}};
}

Result<Json> ViewController::ApplySitePreferences(const Json& request) {
  RK_RETURN_IF_ERROR(ValidateSitePreferences(request));
  const auto& sites = request.at("sites");
  if (browser.Alive() && browser.Rpc().Control()) {
    auto session_sitePreferences_result = browser.Rpc().Request(
        {{"method", "session.sitePreferences"}, {"session", id}, {"sites", sites}});
    if (!session_sitePreferences_result)
      return session_sitePreferences_result.error();
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

Result<Json> ViewController::ManageViewClose(const Json& request) {
  auto prepare_view_command_result_2 = PrepareViewCommand(request);
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
  auto prepare_view_command_result_3 = PrepareViewCommand(request);
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

Result<Json> ViewController::ManageViewAppInfo(const Json& request) {
  const auto view = ViewId(request);
  if (!desired.contains(view))
    return Error{ErrorCode::kNotFound, "view not found"};
  if (!browser.Alive() || !browser.Rpc().Control() || browser.Stopping() ||
      navigation.Recovering(view))
    return Error{ErrorCode::kUnavailable, "view is not live"};
  auto reply =
      browser.Rpc().Request({{"method", protocol::kViewAppInfo}, {"session", id}, {"view", view}});
  if (!reply)
    return reply.error();
  if (!reply.value().contains("appInfo") || !reply.value()["appInfo"].is_object())
    return Error{ErrorCode::kInternal, "browser appInfo response missing"};
  return std::move(reply).value()["appInfo"];
}

Result<Json> ViewController::ManageViewPageReply(const Json& request) {
  auto prepare_view_command_result_4 = PrepareViewCommand(request);
  if (!prepare_view_command_result_4)
    return prepare_view_command_result_4.error();
  const auto view = std::move(prepare_view_command_result_4).value();

  if (!desired.contains(view))
    return Error{ErrorCode::kNotFound, "view not found"};
  Json command = {{"method", "page.reply"},
                  {"session", id},
                  {"view", view},
                  {"request", Required(request, "requestId")},
                  {"instance", Required(request, "instance")},
                  {"document", Required(request, "document")}};
  if (request.contains("decision")) {
    const auto& decision = request["decision"];
    if ((decision != "allow" && decision != "allow_once" && decision != "block" &&
         decision != "dismiss") ||
        request.contains("accept") || request.contains("text") || request.contains("username") ||
        request.contains("password"))
      return Error{ErrorCode::kInvalidRequest, "invalid permission decision"};
    command["decision"] = decision;
  } else {
    if (!request.contains("accept") || !request["accept"].is_boolean())
      return Error{ErrorCode::kInvalidRequest, "accept boolean required"};
    command["accept"] = request["accept"];
    if (request.contains("username") || request.contains("password")) {
      if (request["accept"] != true || !request.contains("username") ||
          !request["username"].is_string() || !request.contains("password") ||
          !request["password"].is_string() ||
          request["username"].get_ref<const std::string&>().size() > 1024 ||
          request["password"].get_ref<const std::string&>().size() > 1024 ||
          request.contains("text"))
        return Error{ErrorCode::kInvalidRequest, "invalid authentication reply"};
      command["username"] = request["username"];
      command["password"] = request["password"];
    }
  }
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
  auto prepare_view_command_result_5 = PrepareViewCommand(request);
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
  auto prepare_view_command_result_6 = PrepareViewCommand(request);
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
    RK_RETURN_IF_ERROR(recovery_store.Erase(view));
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
  const auto action = Required(request, "action");
  const bool guarded_lifecycle = request.contains("lifecycleGeneration") || action == "unload";
  auto prepare_view_command_result_7 = PrepareViewCommand(request);
  if (!prepare_view_command_result_7)
    return prepare_view_command_result_7.error();
  const auto view = std::move(prepare_view_command_result_7).value();

  if (guarded_lifecycle && action != "unload" && action != "restore")
    return Error{ErrorCode::kInvalidRequest, "unsupported guarded lifecycle action"};
  if (action != "discard" && action != "freeze" && action != "restore" && action != "unload")
    return Error{ErrorCode::kInvalidRequest, "unsupported lifecycle action"};
  if (navigation.Recovering(view)) {
    if (guarded_lifecycle)
      return Error{ErrorCode::kBusy, "navigation_recovery_pending"};
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
  auto prepare_view_command_result_8 = PrepareViewCommand(request);
  if (!prepare_view_command_result_8)
    return prepare_view_command_result_8.error();
  const auto view = std::move(prepare_view_command_result_8).value();

  const auto url = Required(request, "url");
  if (url.starts_with("remotekit-signin://changyan/done?")) {
    Json command = {{"method", "navigate"}, {"session", id}, {"view", view}, {"url", url}};
    return browser.Rpc().Request(std::move(command));
  }
  const bool cancelled = navigation.CancelRecovery(view);
  navigation.Forget(view);
  Json command = {{"method", cancelled ? "view.recreate" : "navigate"},
                  {"session", id},
                  {"view", view},
                  {"url", url}};
  NavigationOperation(command, request);
  auto rpc_result_2 = browser.Rpc().Request(command);
  if (!rpc_result_2)
    return rpc_result_2.error();
  auto result = std::move(rpc_result_2).value();
  RK_RETURN_IF_ERROR(recovery_store.Erase(view));
  navigation.EraseRevision(view);
  if (cancelled) {
    auto reconcile_output_result_2 = ReconcileOutput();
    if (!reconcile_output_result_2)
      return reconcile_output_result_2.error();
  }
  return result;
}

}  // namespace remotekit

namespace remotekit {
Result<void> ViewController::Initialize() {
  RK_ASSIGN_OR_RETURN(saved, view_store.Load());
  RK_ASSIGN_OR_RETURN(retired, view_store.Retired());
  std::map<std::string, Json> loaded;
  for (const auto& config : saved)
    loaded.emplace(config.at("viewId").get<std::string>(), config);
  RK_RETURN_IF_ERROR(downloads.Initialize());
  desired = std::move(loaded);
  for (const auto& config : saved) {
    desired_order.push_back(config.at("viewId").get<std::string>());
    restoring_views.insert(config.at("viewId").get<std::string>());
  }
  for (const auto& view : retired) {
    observed_closed.insert(view.get<std::string>());
    desired.erase(view.get<std::string>());
  }
  return {};
}
void ViewController::Reset() {
  {
    std::lock_guard lock(chooser_mutex);
    chooser_requests.clear();
  }
  reconciliation_pending = false;
  output.SetVisible(false);
}

}  // namespace remotekit

namespace remotekit {
void ViewController::PollSignIn() {
  if (!browser.Alive() || !browser.Rpc().Control() || browser.Stopping() ||
      QpcNow() < next_sign_in_poll)
    return;
  next_sign_in_poll = QpcNow() + QpcFrequency() / 4;
  if (sign_in_incarnation != browser.Incarnation()) {
    sign_in_acknowledged = Json::array();
    sign_in_incarnation = browser.Incarnation();
  }
  const bool has_sign_in = std::any_of(desired.begin(), desired.end(), [](const auto& item) {
    return item.second.contains("signIn");
  });
  if (!has_sign_in && sign_in_acknowledged.empty())
    return;
  auto reply =
      browser.Rpc().Request({{"method", "view.signIn.events"}, {"eventIds", sign_in_acknowledged}});
  if (!reply)
    return;
  sign_in_acknowledged = Json::array();
  for (const auto& event : reply.value().value("events", Json::array())) {
    if (event.is_object() && event.value("result", Json()).is_object() &&
        event["result"].dump().size() > limits::signInBytes) {
      Error error{ErrorCode::kLimitExceeded, "Sign-in result exceeds event bound"};
      error.error_id = NewErrorId();
      LogError(LogLevel::kError, "session.event_dropped", error, {{"type", "view.signIn"}});
      if (event.value("eventId", Json()).is_string())
        sign_in_acknowledged.push_back(event.at("eventId"));
      continue;
    }
    if (!ValidSignInEvent(event))
      continue;
    const auto view = event.at("webviewId").get<std::string>();
    const auto expected = desired.find(view);
    if (expected == desired.end() ||
        expected->second.value("signIn", std::string()) != event.at("provider").get<std::string>())
      continue;
    auto body = event;
    body.erase("type");
    body.erase("eventId");
    const auto identity =
        "signin-" + browser.Incarnation() + "-" + event.at("eventId").get<std::string>();
    if (store.Events().Append("view.signIn", body, identity, browser.Incarnation())) {
      sign_in_acknowledged.push_back(event.at("eventId"));
      LogEvent(LogLevel::kInfo, "signin.completed", {{"viewId", view}});
    }
  }
}
}  // namespace remotekit
