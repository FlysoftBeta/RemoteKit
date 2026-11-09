#include "browser/control_dispatcher.h"
#include "browser/signin_result.h"
#include "browser/control_requests.h"
#include "browser/control_response.h"
#include "browser/browser_runtime.h"
#include <algorithm>
#include <cmath>
#include "base/check.h"

namespace remotekit::browser {
Result<ClosedAckRequest> DecodeClosedAck(const base::DictValue& wire, RequestEnvelope envelope) {
  ClosedAckRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.browserIncarnation = decoder.Optional<std::string>("browserIncarnation");
  request.eventIds = decoder.Optional<base::ListValue>("eventIds");
  if (request.eventIds) {
    if (request.eventIds->size() > 256)
      return {{}, {ErrorCode::kLimitExceeded, "Too many event IDs"}};
    for (const auto& value : *request.eventIds)
      if (!value.is_string() || value.GetString().empty() || value.GetString().size() > 256)
        return {{}, {ErrorCode::kInvalidRequest, "Invalid event ID"}};
  }
  const auto ids = decoder.Optional<base::ListValue>("views");
  if (!ids || ids->size() > 256)
    return {{}, {ErrorCode::kInvalidRequest, "Closed view IDs required"}};
  request.views.emplace();
  for (const auto& value : *ids) {
    WebViewId view = 0;
    if (!value.is_string() || !base::StringToUint64(value.GetString(), &view) || !view)
      return {{}, {ErrorCode::kInvalidRequest, "Invalid closed view ID"}};
    request.views->push_back(view);
  }
  request.session = decoder.Optional<uint64_t>("session");
  return decoder.Finish(std::move(request));
}

Result<SitePreferencesRequest> DecodeSitePreferences(const base::DictValue& wire,
                                                     RequestEnvelope envelope) {
  SitePreferencesRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.sites = decoder.Optional<base::DictValue>("sites");
  request.session = decoder.Optional<uint64_t>("session");
  return decoder.Finish(std::move(request));
}

Result<CreateViewRequest> DecodeCreateView(const base::DictValue& wire, RequestEnvelope envelope) {
  CreateViewRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.signIn = decoder.Optional<std::string>("signIn");
  if (request.signIn && !ValidSignInPurpose(*request.signIn))
    return {{}, {ErrorCode::kInvalidRequest, "Invalid sign-in purpose"}};
  request.provisionalId = decoder.Optional<std::string>("provisionalId");
  request.width = decoder.Optional<int>("width");
  request.height = decoder.Optional<int>("height");
  request.url = decoder.Optional<std::string>("url");
  request.device = decoder.Optional<std::string>("device");
  request.visible = decoder.Optional<bool>("visible");
  request.device_scale_factor = decoder.Optional<double>("device_scale_factor");
  request.session = decoder.Optional<uint64_t>("session");
  request.view = decoder.Optional<uint64_t>("view");
  auto operation = DecodeNavigationOperation(wire, envelope.method == "navigation.ack");
  if (!operation)
    return {{}, operation.status};
  request.operation = std::move(operation.value);
  if (!request.session || !request.view)
    return {{}, {ErrorCode::kInvalidRequest, "Session and view required"}};
  return decoder.Finish(std::move(request));
}

Result<CloseViewRequest> DecodeCloseView(const base::DictValue& wire, RequestEnvelope envelope) {
  CloseViewRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.force = decoder.Optional<bool>("force");
  request.session = decoder.Optional<uint64_t>("session");
  request.view = decoder.Optional<uint64_t>("view");
  if (!request.session || !request.view)
    return {{}, {ErrorCode::kInvalidRequest, "Session and view required"}};
  return decoder.Finish(std::move(request));
}

Result<RecreateViewRequest> DecodeRecreateView(const base::DictValue& wire,
                                               RequestEnvelope envelope) {
  RecreateViewRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.url = decoder.Optional<std::string>("url");
  request.session = decoder.Optional<uint64_t>("session");
  request.view = decoder.Optional<uint64_t>("view");
  auto operation = DecodeNavigationOperation(wire, envelope.method == "navigation.ack");
  if (!operation)
    return {{}, operation.status};
  request.operation = std::move(operation.value);
  if (!request.session || !request.view)
    return {{}, {ErrorCode::kInvalidRequest, "Session and view required"}};
  return decoder.Finish(std::move(request));
}

Result<ConfigureViewRequest> DecodeConfigureView(const base::DictValue& wire,
                                                 RequestEnvelope envelope) {
  ConfigureViewRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.visible = decoder.Optional<bool>("visible");
  request.width = decoder.Optional<int>("width");
  request.height = decoder.Optional<int>("height");
  request.device = decoder.Optional<std::string>("device");
  request.device_scale_factor = decoder.Optional<double>("device_scale_factor");
  request.session = decoder.Optional<uint64_t>("session");
  request.view = decoder.Optional<uint64_t>("view");
  if (!request.session || !request.view)
    return {{}, {ErrorCode::kInvalidRequest, "Session and view required"}};
  return decoder.Finish(std::move(request));
}

Result<FocusRequest> DecodeFocus(const base::DictValue& wire, RequestEnvelope envelope) {
  FocusRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.focused = decoder.Optional<bool>("focused");
  request.focus = decoder.Optional<uint64_t>("focus");
  request.session = decoder.Optional<uint64_t>("session");
  request.view = decoder.Optional<uint64_t>("view");
  request.instance = decoder.Optional<uint64_t>("instance");
  request.document = decoder.Optional<uint64_t>("document");
  if (!request.session || !request.view)
    return {{}, {ErrorCode::kInvalidRequest, "Session and view required"}};
  return decoder.Finish(std::move(request));
}

Result<VisibleRequest> DecodeVisible(const base::DictValue& wire, RequestEnvelope envelope) {
  VisibleRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.visible = decoder.Optional<bool>("visible");
  request.session = decoder.Optional<uint64_t>("session");
  request.view = decoder.Optional<uint64_t>("view");
  if (!request.session || !request.view)
    return {{}, {ErrorCode::kInvalidRequest, "Session and view required"}};
  return decoder.Finish(std::move(request));
}

Result<LifecycleControlRequest> DecodeLifecycle(const base::DictValue& wire,
                                                RequestEnvelope envelope) {
  LifecycleControlRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  request.action = decoder.Optional<std::string>("action");
  request.expected_lifecycle_generation =
      decoder.Optional<uint64_t>("expected_lifecycle_generation");
  request.session = decoder.Optional<uint64_t>("session");
  request.view = decoder.Optional<uint64_t>("view");
  if (!request.session || !request.view)
    return {{}, {ErrorCode::kInvalidRequest, "Session and view required"}};
  return decoder.Finish(std::move(request));
}

ControlResult ControlDispatcher::HandleClosedAck(const ClosedAckRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);
  auto error = [&](ErrorCode code, std::string detail) {
    return ControlResult::Failure(id, code, detail, std::move(reply));
  };

  uint64_t session = 0;
  const auto* incarnation = Ptr(request.browserIncarnation);
  const auto* ids = Ptr(request.views);
  const auto current =
      base::CommandLine::ForCurrentProcess()->GetSwitchValueASCII("browser-incarnation");
  if (!Assign(request.session, &session) || !runtime_.view_model.FindSession(session) ||
      !incarnation || current.empty() || *incarnation != current || !ids || ids->size() > 256)
    return error(ErrorCode::kInvalidRequest, "invalid_closed_ack_target");
  const auto acknowledged = runtime_.closed.Acknowledge(session, *ids);
  if (!acknowledged)
    return ControlResult::Failure(id, *acknowledged.error, acknowledged.message);
  if (request.eventIds)
    for (auto& context : runtime_.contexts)
      context->AcknowledgeDownloadEvents(*request.eventIds);
  reply.Set("ok", true);
  reply.Set("accepted", true);
  return reply;
}

ControlResult ControlDispatcher::HandleSitePreferences(const SitePreferencesRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);
  auto error = [&](ErrorCode code, std::string detail) {
    return ControlResult::Failure(id, code, detail, std::move(reply));
  };

  uint64_t session = 0;
  const auto* sites = Ptr(request.sites);
  if (!Assign(request.session, &session) || !sites)
    return error(ErrorCode::kInvalidRequest, "session_and_sites_required");
  if (session != runtime_.session_id)
    return error(ErrorCode::kNotFound, "session_not_found");
  std::string detail;
  if (!runtime_.contexts.front()->SetSitePreferences(*sites, &detail))
    return error(ErrorCode::kInvalidRequest, detail);
  reply.Set("ok", true);
  reply.Set("accepted", true);
  reply.Set("applied", true);
  return reply;
}

ControlResult ControlDispatcher::HandleCreateView(const CreateViewRequest& request) {
  const int id = request.id;
  const auto* method = &request.method;
  auto reply = ControlResult::Success(id);
  auto error = [&](ErrorCode code, std::string detail) {
    return ControlResult::Failure(id, code, detail, std::move(reply));
  };

  uint64_t session = 0, view = 0;
  if (!Assign(request.session, &session) || !Assign(request.view, &view) ||
      !runtime_.view_model.FindSession(session) || session != runtime_.session_id)
    return error(ErrorCode::kInvalidRequest, "invalid_session_or_view");
  if (runtime_.closed.retired.contains(view))
    return error(ErrorCode::kConflict, "view_id_closed");
  const bool adopting = *method == "view.adopt";
  const auto* provisional = Ptr(request.provisionalId);
  if (adopting && request.signIn)
    return error(ErrorCode::kForbidden, "sign_in_popup_adoption_forbidden");
  if (adopting && !provisional)
    return error(ErrorCode::kInvalidRequest, "provisional_id_required");
  if (adopting && runtime_.popups.adopted.contains(*provisional)) {
    if (runtime_.popups.adopted.at(*provisional) != view)
      return error(ErrorCode::kConflict, "popup_already_adopted_elsewhere");
    reply.Set("ok", true);
    reply.Set("accepted", true);
    reply.Set("completed", true);
    reply.Set("token", TokenValue(runtime_.view_model.Token(session, view).value));
    return reply;
  }
  runtime_.popups.Prune();
  if (adopting) {
    const auto allowed = runtime_.popups.CanAdopt(*provisional, session);
    if (!allowed)
      return ControlResult::Failure(id, *allowed.error, allowed.message);
  }
  ViewSpec spec;
  spec.sign_in = request.signIn.value_or("");
  spec.width = request.width.value_or(0);
  spec.height = request.height.value_or(0);
  const auto* url = Ptr(request.url);
  const auto* device = Ptr(request.device);
  if (!url || !GURL(*url).is_valid() || spec.width < 1 || spec.height < 1 || spec.width > 8192 ||
      spec.height > 8192 || (device && *device != "desktop" && *device != "tablet") ||
      (Ptr(request.device) && !device))
    return error(ErrorCode::kInvalidRequest, "invalid_view_configuration");
  spec.visible = request.visible.value_or(true);
  if (Ptr(request.device_scale_factor)) {
    const auto scale = request.device_scale_factor;
    if (!scale || !std::isfinite(*scale) || *scale < 0.5 || *scale > 4)
      return error(ErrorCode::kInvalidRequest, "invalid_page_device_scale_factor");
    spec.page_dsf = static_cast<float>(*scale);
  }
  spec.url = *url;
  for (auto& [i, record] : runtime_.views.records) {
    if (runtime_.views.records.at(i).webview->view_id() != view)
      continue;
    if (adopting)
      return error(ErrorCode::kConflict, "view_id_already_exists");
    if (runtime_.views.records.at(i).webview->session_id() != session ||
        runtime_.views.records.at(i).spec != spec)
      return error(ErrorCode::kConflict, "view_id_configuration_conflict");
    if (request.operation) {
      const auto status =
          runtime_.views.records.at(i).webview->Navigate(GURL(spec.url), request.operation);
      if (!status)
        return ControlResult::Failure(id, *status.error, status.message, std::move(reply));
    }
    reply.Set("ok", true);
    reply.Set("accepted", true);
    reply.Set("completed", true);
    reply.Set("token", TokenValue(runtime_.view_model.Token(session, view).value));
    if (request.operation)
      reply.Set("completed", false);
    return reply;
  }
  if (runtime_.views.records.size() >= kSharedAtlasMaxViews)
    return error(ErrorCode::kLimitExceeded, "view_limit_reached");
  auto next = runtime_.views.Specs();
  next.emplace(view, spec);
  auto layout = runtime_.layout_transaction.Prepare(next);
  if (!layout)
    return ControlResult::Failure(id, *layout.status.error, layout.status.message);
  auto created = runtime_.view_model.CreateWebView(session, runtime_.profiles.front(), view);
  if (!created)
    return ControlResult::Failure(id, *created.status.error, created.status.message,
                                  std::move(reply));
  std::unique_ptr<content::WebContents> adopted;
  if (adopting)
    adopted = runtime_.popups.TakeContents(*provisional);
  auto& record = runtime_.views.Create(runtime_.contexts.front().get(), runtime_.view_model,
                                       session, view, spec, std::move(adopted));
  if (spec.sign_in.empty())
    runtime_.popups.Wire(record.requests.get(), session, view);
  runtime_.layout_transaction.Commit(std::move(layout.value));
  runtime_.UpdateOutput();
  auto navigated =
      adopting ? Status{} : record.webview->Navigate(GURL(spec.url), request.operation);
  if (!navigated) {
    runtime_.RemoveView(view);
    return ControlResult::Failure(id, *navigated.error, navigated.message, std::move(reply));
  }
  if (adopting) {
    runtime_.popups.CompleteAdoption(*provisional, view);
  }
  reply.Set("ok", true);
  reply.Set("accepted", true);
  reply.Set("completed", true);
  reply.Set("token", TokenValue(runtime_.view_model.Token(session, view).value));
  if (request.operation)
    reply.Set("completed", false);
  return reply;
}

ControlResult ControlDispatcher::HandleCloseView(const CloseViewRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);
  auto error = [&](ErrorCode code, std::string detail) {
    return ControlResult::Failure(id, code, detail, std::move(reply));
  };

  uint64_t session = 0, view = 0;
  if (!Assign(request.session, &session) || !Assign(request.view, &view) ||
      !runtime_.view_model.FindSession(session))
    return error(ErrorCode::kInvalidRequest, "invalid_session_or_view");
  if (runtime_.closed.retired.contains(view)) {
    reply.Set("ok", true);
    reply.Set("accepted", true);
    reply.Set("completed", true);
    return reply;
  }
  auto* record = runtime_.views.Find(session, view);
  if (!record)
    return error(ErrorCode::kNotFound, "view_not_in_session");
  bool force = request.force.value_or(false);
  if (force)
    runtime_.RemoveView(view);
  else
    record->requests->RequestClose();
  reply.Set("ok", true);
  reply.Set("accepted", true);
  reply.Set("completed", force);
  return reply;
}

ControlResult ControlDispatcher::HandleRecreateView(const RecreateViewRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);
  auto error = [&](ErrorCode code, std::string detail) {
    return ControlResult::Failure(id, code, detail, std::move(reply));
  };
  const auto session = request.session.value_or(0);
  const auto view = request.view.value_or(0);
  auto* record = runtime_.views.Find(session, view);
  if (!record || !runtime_.view_model.FindWebView(session, view))
    return ControlResult::Failure(request.id, ErrorCode::kNotFound, "View is not in session");
  auto& adapter = *record->webview;

  if (record->requests->close_state() == "closing" || record->requests->close_state() == "closed")
    return error(ErrorCode::kConflict, "view_closing");
  const auto* url = Ptr(request.url);
  if (!url || !GURL(*url).is_valid())
    return error(ErrorCode::kInvalidRequest, "invalid_url");
  if (const auto existing = adapter.ExistingNavigationOperation(GURL(*url), request.operation)) {
    if (!*existing)
      return ControlResult::Failure(id, *existing->error, existing->message);
    reply.Set("ok", true);
    reply.Set("accepted", true);
    reply.Set("token", TokenValue(runtime_.view_model.Token(session, view).value));
    return reply;
  }
  runtime_.navigation_transfers.records.erase(view);
  if (runtime_.output)
    runtime_.output->StopView(view);
  runtime_.paused_output.insert(view);
  runtime_.UpdateOutput();
  record->requests->Bind(nullptr);
  const auto profile = runtime_.view_model.FindWebView(session, view)->profile;
  const auto owner = std::ranges::find(runtime_.profiles, profile);
  if (owner == runtime_.profiles.end())
    return error(ErrorCode::kInternal, "profile_missing");
  runtime_.views.Recreate(runtime_.views.records.at(view),
                          runtime_.contexts[owner - runtime_.profiles.begin()].get(),
                          runtime_.view_model);
  if (record->spec.sign_in.empty())
    runtime_.popups.Wire(record->requests.get(), session, view);
  auto plan = runtime_.layout_transaction.Prepare(runtime_.views.Specs());
  CHECK(plan);
  runtime_.layout_transaction.Commit(std::move(plan.value));
  const auto status = record->webview->Navigate(GURL(*url), request.operation);
  runtime_.paused_output.erase(view);
  runtime_.UpdateOutput();
  if (!status)
    return ControlResult::Failure(id, *status.error, status.message);
  reply.Set("ok", true);
  reply.Set("accepted", true);
  reply.Set("token", TokenValue(runtime_.view_model.Token(session, view).value));
  return reply;
}

ControlResult ControlDispatcher::HandleConfigureView(const ConfigureViewRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);
  auto error = [&](ErrorCode code, std::string detail) {
    return ControlResult::Failure(id, code, detail, std::move(reply));
  };
  const auto session = request.session.value_or(0);
  const auto view = request.view.value_or(0);
  auto* record = runtime_.views.Find(session, view);
  if (!record || !runtime_.view_model.FindWebView(session, view))
    return ControlResult::Failure(request.id, ErrorCode::kNotFound, "View is not in session");

  auto spec = record->spec;
  if (record->requests->close_state() == "closing")
    return error(ErrorCode::kConflict, "view_closing");
  if (Ptr(request.visible)) {
    spec.visible = *request.visible;
  }
  if (Ptr(request.width))
    spec.width = request.width.value_or(0);
  if (Ptr(request.height))
    spec.height = request.height.value_or(0);
  if (const auto* device = Ptr(request.device)) {
    if (*device != "desktop" && *device != "tablet")
      return error(ErrorCode::kInvalidRequest, "invalid_device");
  } else if (Ptr(request.device))
    return error(ErrorCode::kInvalidRequest, "invalid_device");
  if (Ptr(request.device_scale_factor)) {
    const auto scale = request.device_scale_factor;
    if (!scale || !std::isfinite(*scale) || *scale < 0.5 || *scale > 4)
      return error(ErrorCode::kInvalidRequest, "invalid_page_device_scale_factor");
    spec.page_dsf = static_cast<float>(*scale);
  }
  if (spec.width < 1 || spec.height < 1 || spec.width > 8192 || spec.height > 8192)
    return error(ErrorCode::kInvalidRequest, "invalid_viewport");
  if (spec == record->spec) {
    reply.Set("ok", true);
    reply.Set("accepted", true);
    reply.Set("completed", true);
    reply.Set("token", TokenValue(runtime_.view_model.Token(session, view).value));
    return reply;
  }
  auto next = runtime_.views.Specs();
  next[view] = spec;
  auto layout = runtime_.layout_transaction.Prepare(next);
  if (!layout)
    return ControlResult::Failure(id, *layout.status.error, layout.status.message);
  runtime_.layout_transaction.Commit(std::move(layout.value));
  runtime_.UpdateOutput();
  reply.Set("ok", true);
  reply.Set("accepted", true);
  reply.Set("completed", true);
  reply.Set("token", TokenValue(runtime_.view_model.Token(session, view).value));
  return reply;
}

ControlResult ControlDispatcher::HandleFocus(const FocusRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);
  auto error = [&](ErrorCode code, std::string detail) {
    return ControlResult::Failure(id, code, detail, std::move(reply));
  };
  const auto session = request.session.value_or(0);
  const auto view = request.view.value_or(0);
  auto* record = runtime_.views.Find(session, view);
  if (!record || !runtime_.view_model.FindWebView(session, view))
    return ControlResult::Failure(request.id, ErrorCode::kNotFound, "View is not in session");
  auto& adapter = *record->webview;
  if (record->requests->close_state() == "closing")
    return ControlResult::Failure(id, ErrorCode::kConflict, "view_closing");

  Status status;

  if (!Ptr(request.focus))
    return error(ErrorCode::kInvalidRequest, "focus_token_required");
  const auto current = runtime_.view_model.Token(session, view).value;
  for (const auto& [supplied, expected] :
       {std::pair{request.instance, current.instance},
        std::pair{request.document, current.document}, std::pair{request.focus, current.focus}}) {
    if (supplied && *supplied != expected)
      return error(ErrorCode::kConflict, "stale_focus_target");
  }
  auto focused = request.focused;
  if (!focused)
    return error(ErrorCode::kInvalidRequest, "focused_boolean_required");
  if (*focused) {
    for (auto& [other_id, other_record] : runtime_.views.records)
      if (other_record.webview->session_id() == session && other_id != view)
        other_record.webview->Focus(false);
  }
  status = adapter.Focus(*focused);

  reply.Set("token", TokenValue(runtime_.view_model.Token(session, view).value));
  runtime_.UpdateOutput();
  if (!status)
    return ControlResult::Failure(id, *status.error, status.message, std::move(reply));
  return reply;
}

ControlResult ControlDispatcher::HandleVisible(const VisibleRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);
  auto error = [&](ErrorCode code, std::string detail) {
    return ControlResult::Failure(id, code, detail, std::move(reply));
  };
  const auto session = request.session.value_or(0);
  const auto view = request.view.value_or(0);
  auto* record = runtime_.views.Find(session, view);
  if (!record || !runtime_.view_model.FindWebView(session, view))
    return ControlResult::Failure(request.id, ErrorCode::kNotFound, "View is not in session");
  if (record->requests->close_state() == "closing")
    return ControlResult::Failure(id, ErrorCode::kConflict, "view_closing");

  Status status;

  auto visible = request.visible;
  if (!visible)
    return error(ErrorCode::kInvalidRequest, "visible_boolean_required");
  auto next = runtime_.views.Specs();
  next[view].visible = *visible;
  auto layout = runtime_.layout_transaction.Prepare(next);
  if (!layout)
    return ControlResult::Failure(id, *layout.status.error, layout.status.message);
  {
    runtime_.layout_transaction.Commit(std::move(layout.value));
    runtime_.UpdateOutput();
  }

  reply.Set("token", TokenValue(runtime_.view_model.Token(session, view).value));
  runtime_.UpdateOutput();
  if (!status)
    return ControlResult::Failure(id, *status.error, status.message, std::move(reply));
  return reply;
}

ControlResult ControlDispatcher::HandleLifecycle(const LifecycleControlRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);
  auto error = [&](ErrorCode code, std::string detail) {
    return ControlResult::Failure(id, code, detail, std::move(reply));
  };
  const auto session = request.session.value_or(0);
  const auto view = request.view.value_or(0);
  auto* record = runtime_.views.Find(session, view);
  if (!record || !runtime_.view_model.FindWebView(session, view))
    return ControlResult::Failure(request.id, ErrorCode::kNotFound, "View is not in session");
  auto& adapter = *record->webview;
  if (record->requests->close_state() == "closing")
    return ControlResult::Failure(id, ErrorCode::kConflict, "view_closing");

  Status status;

  const auto* action = Ptr(request.action);
  if (!action)
    return error(ErrorCode::kInvalidRequest, "action_required");
  std::optional<Lifecycle> operation;
  if (*action == "unload")
    operation = Lifecycle::unload;
  if (*action == "restore")
    operation = Lifecycle::restore;
  if (*action == "freeze")
    operation = Lifecycle::freeze;
  if (*action == "discard")
    operation = Lifecycle::discard;
  if (!operation)
    return error(ErrorCode::kInvalidRequest, "unknown_lifecycle_action");
  const bool guarded = request.expected_lifecycle_generation.has_value();
  const bool recover_uncertain = guarded && *operation == Lifecycle::unload;
  if (guarded) {
    uint64_t generation = 0;
    const auto* model = runtime_.view_model.FindWebView(session, view);
    if (!Assign(request.expected_lifecycle_generation, &generation) || !model ||
        model->lifecycle_generation != generation || model->pending ||
        record->requests->close_state() == "closing" || record->requests->close_state() == "closed")
      return error(ErrorCode::kConflict, "stale_lifecycle_recovery");
    if (recover_uncertain) {
      const auto allowed = adapter.CanRecoverLifecycle();
      if (!allowed)
        return ControlResult::Failure(id, *allowed.error, allowed.message, std::move(reply));
    } else if (*operation != Lifecycle::restore || model->actual != Residency::unloaded ||
               adapter.lifecycle_uncertain()) {
      return error(ErrorCode::kConflict, "stale_lifecycle_recovery");
    }
  }
  if (*operation == Lifecycle::discard || *operation == Lifecycle::freeze) {
    const auto allowed = runtime_.CanDiscard(view);
    if (!allowed)
      return ControlResult::Failure(id, *allowed.error, allowed.message, std::move(reply));
  }
  if (runtime_.output) {
    runtime_.paused_output.insert(view);
    runtime_.output->StopView(view);
    runtime_.UpdateOutput();
  }
  record->requests->CancelAll("lifecycle_transition");
  record->requests->Bind(nullptr);
  status = adapter.RequestLifecycle(*operation, {}, recover_uncertain);
  record->requests->Bind(adapter.contents());
  runtime_.paused_output.erase(view);
  runtime_.UpdateOutput();
  reply.Set("accepted", static_cast<bool>(status));
  const auto* lifecycle = runtime_.view_model.FindWebView(session, view);
  reply.Set("pending", lifecycle->pending.has_value());
  reply.Set("completed", static_cast<bool>(status) && !lifecycle->pending);
  reply.Set("lifecycleGeneration", base::NumberToString(lifecycle->lifecycle_generation));

  reply.Set("token", TokenValue(runtime_.view_model.Token(session, view).value));
  runtime_.UpdateOutput();
  if (!status)
    return ControlResult::Failure(id, *status.error, status.message, std::move(reply));
  return reply;
}
}  // namespace remotekit::browser
