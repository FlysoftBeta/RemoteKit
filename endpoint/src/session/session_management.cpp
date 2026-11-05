#include "session/session.hpp"
namespace remotekit {
Result<void> Session::ManagementLost(uint64_t generation) {
  std::lock_guard transition(authorization_mutex);
  if (management_generation == generation) {
    if (RevokeProduct() != 0)
      fprintf(stderr, "RTC media authorization revoke failed\n");
  }

  return {};
}

Result<Json> Session::ManageSessionEnsure(const Json& request) {
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
              {"recovery", RecoverySnapshot()}};
}

Result<Json> Session::ManageSessionSnapshot(const Json& request) {
  return Snapshot(request.value("outputDiagnostics", false));
}

Result<Json> Session::ManageSessionEventsAck(const Json& request) {
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

Result<Json> Session::ManageSessionMediaPolicy(const Json& request) {
  const auto& value = request.at("maxFps");
  if (!value.is_number_integer() || value.get<int64_t>() < 1 || value.get<int64_t>() > 240)
    return Error{ErrorCode::kInvalidRequest, "invalid media policy maxFps"};
  const auto preference = Required(request, "degradationPreference");
  uint32_t degradation;
  if (preference == "maintain-resolution")
    degradation = REMOTEKIT_RTC_MAINTAIN_RESOLUTION;
  else if (preference == "balanced")
    degradation = REMOTEKIT_RTC_BALANCED;
  else if (preference == "maintain-framerate")
    degradation = REMOTEKIT_RTC_MAINTAIN_FRAMERATE;
  else
    return Error{ErrorCode::kInvalidRequest, "invalid degradation preference"};
  {
    std::lock_guard lock(media_policy_mutex);
    if (peer && (sdk.remotekit_rtc_set_degradation_preference(peer, degradation) != 0 ||
                 sdk.remotekit_rtc_set_source_max_fps(peer, value.get<uint32_t>()) != 0))
      return Error{ErrorCode::kRejected, "RTC media policy rejected"};
    policy_max_fps = value.get<uint32_t>();
    policy_degradation = degradation;
    requested_media_policy = {{"maxFps", policy_max_fps.load()},
                              {"degradationPreference", preference}};
  }
  event_wake.notify_one();
  return Json{{"accepted", true}, {"applied", peer.load() != 0}};
}

Result<Json> Session::ManageSessionSitePreferences(const Json& request) {
  const auto sites = request.at("sites");
  if (!sites.is_object() || sites.size() > 4096)
    return Error{ErrorCode::kInvalidRequest, "invalid site preferences"};
  for (auto& [origin, value] : sites.items()) {
    if (origin.size() > 2048 ||
        !(origin.starts_with("https://") || origin.starts_with("http://")) || !value.is_object() ||
        !value.contains("tabletUa") || !value["tabletUa"].is_boolean())
      return Error{ErrorCode::kInvalidRequest, "invalid site preference"};
  }
  if (Alive() && browser.Rpc().Control()) {
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
  return Json{{"accepted", true}, {"applied", Alive() && browser.Rpc().Control() != 0}};
}

Result<Json> Session::ManageRtcActionResult(const Json& request) {
  if (request.value("connectionId", std::string()) != connection || !peer.load() ||
      !authorization.Stamp())
    return Json{{"accepted", false}};
  if (request.value("authEpoch", Json()) != authorization.Epoch())
    return Json{{"accepted", false}};
  if (!request.contains("operationId") ||
      !remotekit::BoundedServiceId(request["operationId"], 36) ||
      !request.contains("operationGeneration") ||
      !remotekit::BoundedServiceId(request["operationGeneration"]) || !request.contains("ok") ||
      !request["ok"].is_boolean())
    return Error{ErrorCode::kInvalidRequest, "invalid action result"};
  Json result = {{"connectionId", connection},
                 {"operationId", request["operationId"]},
                 {"operationGeneration", request["operationGeneration"]},
                 {"ok", request["ok"]}};
  if (request.contains("result"))
    result["result"] = request["result"];
  if (request.contains("error"))
    result["error"] = request["error"];
  const bool accepted = direct_services.Result(peer.load(), result);
  event_wake.notify_one();
  return Json{{"accepted", accepted}};
}

Result<Json> Session::ManageRtcOffer(const Json& request) {
  auto offer_result = Offer(request, request_generation_);
  if (!offer_result)
    return offer_result.error();
  auto result = std::move(offer_result).value();
  if (!management.Current(request_generation_)) {
    {
      auto management_lost_result = ManagementLost(request_generation_);
      if (!management_lost_result)
        return management_lost_result.error();
    }
    return Error{ErrorCode::kUnavailable, "management_disconnected"};
  }
  return result;
}

Result<Json> Session::ManageRtcClose(const Json& request) {
  if (request.value("connectionId", std::string()) == connection)
    ClosePeer();
  return Json{{"closed", true}};
}

Result<Json> Session::ManageRtcIce(const Json& request) {
  if (request.value("connectionId", std::string()) != connection || !peer)
    return Error{ErrorCode::kConflict, "stale RTC connection"};
  auto ice = request.at("candidate");
  if (ice.is_null())
    return Json::object();
  auto candidate = ice.value("candidate", std::string()),
       mid = ice.value("sdpMid", std::string("0"));
  if (sdk.remotekit_rtc_add_ice(peer.load(), mid.c_str(), ice.value("sdpMLineIndex", 0),
                                candidate.data(), candidate.size()) != 0)
    return Error{ErrorCode::kRejected, "ICE candidate rejected"};
  return Json::object();
}

Result<Json> Session::ManageViewNavigationAck(const Json& request) {
  if (!Alive() || !browser.Rpc().Control() || browser.Stopping() ||
      request.value("browserIncarnation", std::string()) != browser.Incarnation())
    return Error{ErrorCode::kConflict, "stale_browser_incarnation"};
  Json command = {{"method", "navigation.ack"}, {"session", id}, {"view", ViewId(request)}};
  NavigationOperation(command, request);
  return browser.Rpc().Request(command);
}

Result<Json> Session::ManageViewEnsure(const Json& request) {
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

Result<Json> Session::ManageViewClose(const Json& request) {
  auto prepare_view_command_result_2 = PrepareViewCommand(request, Required(request, "method"));
  if (!prepare_view_command_result_2)
    return prepare_view_command_result_2.error();
  const auto view = std::move(prepare_view_command_result_2).value();

  CancelRecovery(view);
  auto browser_snapshot_result = BrowserSnapshot();
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

Result<Json> Session::ManageViewCloseReply(const Json& request) {
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

Result<Json> Session::ManageViewPageReply(const Json& request) {
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

Result<Json> Session::ManageViewPageExitFullscreen(const Json& request) {
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

Result<Json> Session::ManageViewCommand(const Json& request) {
  auto prepare_view_command_result_6 = PrepareViewCommand(request, Required(request, "method"));
  if (!prepare_view_command_result_6)
    return prepare_view_command_result_6.error();
  const auto view = std::move(prepare_view_command_result_6).value();

  const auto action = Required(request, "command");
  if (action != "back" && action != "forward" && action != "reload" && action != "stop")
    return Error{ErrorCode::kInvalidRequest, "unsupported page command"};
  if (CancelRecovery(view)) {
    {
      auto view_recreate_result = browser.Rpc().Request(
          {{"method", "view.recreate"},
           {"session", id},
           {"view", view},
           {"url", desired.at(view).value("url", std::string("about:blank"))}});
      if (!view_recreate_result)
        return view_recreate_result.error();
    }
    fs::remove(directory / "recovery" / (view + ".json"));
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

Result<Json> Session::ManageViewLifecycle(const Json& request) {
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
  if (Recovering(view)) {
    if (guarded_lifecycle)
      return Error{ErrorCode::kConflict, "navigation_recovery_pending"};
    return Json{{"accepted", true},
                {"pending", true},
                {"completed", false},
                {"recovery", RecoveryStatus(recoveries.at(view))}};
  }
  Json command = {{"method", "lifecycle"}, {"session", id}, {"view", view}, {"action", action}};
  if (guarded_lifecycle)
    command["expected_lifecycle_request_generation_"] = Required(request, "lifecycleGeneration");
  return browser.Rpc().Request(std::move(command));
}

Result<Json> Session::ManageViewNavigate(const Json& request) {
  auto prepare_view_command_result_8 = PrepareViewCommand(request, Required(request, "method"));
  if (!prepare_view_command_result_8)
    return prepare_view_command_result_8.error();
  const auto view = std::move(prepare_view_command_result_8).value();

  const auto url = Required(request, "url");
  navigation_export.Forget(view);
  const bool cancelled = CancelRecovery(view);
  Json command = {{"method", cancelled ? "view.recreate" : "navigate"},
                  {"session", id},
                  {"view", view},
                  {"url", url}};
  NavigationOperation(command, request);
  auto rpc_result_2 = browser.Rpc().Request(command);
  if (!rpc_result_2)
    return rpc_result_2.error();
  auto result = std::move(rpc_result_2).value();
  fs::remove(directory / "recovery" / (view + ".json"));
  recovery_revisions.erase(view);
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

Result<Json> Session::ManageViewConfigure(const Json& request) {
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

Result<Json> Session::ManageRtcAuthorize(const Json& request) {
  return Authorize(request, request_generation_,
                   [this] { return management.Current(request_generation_); });
}

Result<Json> Session::ManageAuthFaceCapabilities(const Json& request) {
  return FaceCapabilities();
}

Result<Json> Session::ManageSessionFilesAuthorize(const Json& request) {
  return AuthorizeFiles(request);
}

Result<Json> Session::ManageAuthFaceBegin(const Json& request) {
  return FaceCommand(Required(request, "method"), request, request_generation_,
                     [this] { return management.Current(request_generation_); });
}

Result<Json> Session::ManageAuthFaceStatus(const Json& request) {
  return FaceCommand(Required(request, "method"), request, request_generation_,
                     [this] { return management.Current(request_generation_); });
}

Result<Json> Session::ManageAuthFaceCancel(const Json& request) {
  return FaceCommand(Required(request, "method"), request, request_generation_,
                     [this] { return management.Current(request_generation_); });
}

Result<Json> Session::ManageSessionLibraryDescribe(const Json& request) {
  return LibraryCommand(Required(request, "method"), request);
}

Result<Json> Session::ManageSessionLibraryRetain(const Json& request) {
  return LibraryCommand(Required(request, "method"), request);
}

Result<Json> Session::ManageSessionLibraryPrepare(const Json& request) {
  return LibraryCommand(Required(request, "method"), request);
}

Result<Json> Session::ManageSessionLibrarySelectionStatus(const Json& request) {
  return LibraryCommand(Required(request, "method"), request);
}
}  // namespace remotekit
