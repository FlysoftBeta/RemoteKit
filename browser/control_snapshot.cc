#include "browser/control_dispatcher.h"
#include "browser/control_requests.h"
#include "browser/control_response.h"
#include "browser/browser_runtime.h"
#include <set>
#include "base/strings/utf_string_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_process_host.h"

namespace remotekit::browser {
Result<SnapshotRequest> DecodeSnapshot(const base::DictValue& wire, RequestEnvelope envelope) {
  SnapshotRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  return decoder.Finish(std::move(request));
}

Result<ShutdownRequest> DecodeShutdown(const base::DictValue& wire, RequestEnvelope envelope) {
  ShutdownRequest request;
  static_cast<RequestEnvelope&>(request) = envelope;
  RequestDecoder decoder(wire);
  return decoder.Finish(std::move(request));
}

ControlResult ControlDispatcher::HandleSnapshot(const SnapshotRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);

  base::ListValue list;
  const auto* session = runtime_.view_model.FindSession(runtime_.session_id);
  base::ListValue view_values;
  for (const auto& [view_id, model] : session->views) {
    auto value = TokenValue(runtime_.view_model.Token(runtime_.session_id, view_id).value);
    value.Set("profile", base::NumberToString(model.profile));
    value.Set("actual", static_cast<int>(model.actual));
    value.Set("desired", static_cast<int>(model.desired));
    value.Set("pending", model.pending.has_value());
    value.Set("focused", model.focused);
    value.Set("lifecycle_generation", base::NumberToString(model.lifecycle_generation));
    if (model.last_lifecycle) {
      base::DictValue result;
      result.Set("generation", base::NumberToString(model.last_lifecycle->generation));
      result.Set("action", static_cast<int>(model.last_lifecycle->action));
      result.Set("succeeded", model.last_lifecycle->succeeded);
      result.Set("detail", model.last_lifecycle->detail);
      value.Set("last_lifecycle", std::move(result));
    }
    for (auto& [i, record] : runtime_.views.records) {
      const auto& adapter = runtime_.views.records.at(i).webview;
      if (adapter->view_id() != view_id)
        continue;
      value.Set("close_state", runtime_.views.records.at(i).requests->close_state());
      value.Set("close_reason", runtime_.views.records.at(i).requests->close_reason());
      value.Set("width", runtime_.views.records.at(i).spec.width);
      value.Set("height", runtime_.views.records.at(i).spec.height);
      value.Set("device", "desktop");
      value.Set("deviceScaleFactor",
                runtime_.layout_transaction.PageScale(runtime_.views.records.at(i).spec));
      auto compositor = adapter->CompositorDiagnostics();
      if (runtime_.output)
        compositor.Set("osr", runtime_.output->RenderStatus(view_id));
      value.Set("compositor", std::move(compositor));
      value.Set("navigationRevision", base::NumberToString(adapter->navigation_revision()));
      value.Set("navigationOperations", adapter->NavigationOperationSnapshot());
      value.Set("visible", runtime_.views.records.at(i).spec.visible);
      value.Set("lifecycle_uncertain", adapter->lifecycle_uncertain());
      auto discard = runtime_.CanDiscard(i);
      value.Set("canDiscard", static_cast<bool>(discard));
      value.Set("discardBlockReason", discard.message);
      auto touch = adapter->TouchInjectionStatus();
      value.Set("touch_code", static_cast<int>(touch.error));
      value.Set("touch_detail", touch.message);
      value.Set("pending_page_requests",
                static_cast<int>(runtime_.views.records.at(i).requests->pending_count()));
      if (auto* page = adapter->contents()) {
        value.Set("url", page->GetLastCommittedURL().spec());
        value.Set("title", base::UTF16ToUTF8(page->GetTitle()));
        value.Set("loading", page->IsLoading());
        value.Set("canGoBack", page->GetController().CanGoBack());
        value.Set("canGoForward", page->GetController().CanGoForward());
        value.Set("audible", page->IsCurrentlyAudible());
        value.Set("captured", page->IsBeingCaptured());
        value.Set("crashed", page->IsCrashed());
        value.Set("fullscreen",
                  runtime_.views.records.at(i).requests->fullscreen() && !page->IsCrashed());
        std::set<base::ProcessId> pids;
        page->GetPrimaryMainFrame()->ForEachRenderFrameHost([&](content::RenderFrameHost* frame) {
          const auto& process = frame->GetProcess()->GetProcess();
          if (process.IsValid())
            pids.insert(process.Pid());
        });
        base::ListValue processes;
        for (auto pid : pids)
          processes.Append(base::NumberToString(pid));
        value.Set("renderer_pids", std::move(processes));
      }
    }
    view_values.Append(std::move(value));
  }
  for (const auto& [closed_view_id, tombstone] : runtime_.closed.tombstones)
    if (*tombstone.FindString("session") == base::NumberToString(runtime_.session_id))
      view_values.Append(tombstone.Clone());
  base::DictValue session_value;
  session_value.Set("session", base::NumberToString(runtime_.session_id));
  session_value.Set("tenant", session->tenant);
  session_value.Set("views", std::move(view_values));
  base::ListValue popup_values;
  for (const auto& [key, popup] : runtime_.popups.pending) {
    if (popup.session != runtime_.session_id)
      continue;
    base::DictValue item;
    item.Set("provisionalId", key);
    item.Set("openerViewId", base::NumberToString(popup.opener));
    item.Set("url", popup.contents && !popup.contents->GetLastCommittedURL().is_empty()
                        ? popup.contents->GetLastCommittedURL().spec()
                        : popup.url.spec());
    item.Set("disposition", static_cast<int>(popup.disposition));
    item.Set("userGesture", popup.user_gesture);
    item.Set("status", popup.status);
    popup_values.Append(std::move(item));
  }
  session_value.Set("pendingPopups", std::move(popup_values));
  list.Append(std::move(session_value));
  reply.Set("ok", true);
  reply.Set("sessions", std::move(list));
  reply.Set("clientGestures", 1);
  return reply;
}

ControlResult ControlDispatcher::HandleShutdown(const ShutdownRequest& request) {
  const int id = request.id;
  auto reply = ControlResult::Success(id);

  reply.Set("ok", true);
  reply.Set("accepted", true);
  if (runtime_.quit)
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(FROM_HERE, runtime_.quit);
  return reply;
}
}  // namespace remotekit::browser
