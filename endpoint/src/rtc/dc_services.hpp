#pragma once
#include "protocol/shared_render_slots.h"
#include "util/wire_error.hpp"
#include "management/link.hpp"
#include <json.hpp>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <deque>
#include <istream>
#include <map>
#include <mutex>
#include <string>

namespace remotekit {
using ServiceJson = nlohmann::json;
inline bool BoundedServiceId(const ServiceJson& value, size_t maximum = 128) {
  return value.is_string() && !value.get_ref<const std::string&>().empty() &&
         value.get_ref<const std::string&>().size() <= maximum &&
         std::all_of(value.get_ref<const std::string&>().begin(),
                     value.get_ref<const std::string&>().end(),
                     [](unsigned char c) { return c >= 33 && c <= 126; });
}
inline bool ProductActionEnvelope(const ServiceJson& message, size_t bytes) {
  if (bytes > 33792 || !message.is_object() || message.value("version", ServiceJson()) != 1 ||
      !message.contains("operationId") || !BoundedServiceId(message["operationId"], 36) ||
      !message.contains("operationGeneration") ||
      !BoundedServiceId(message["operationGeneration"]) || !message.contains("action") ||
      !message["action"].is_object() || message["action"].dump().size() > 32768)
    return false;
  const auto& id = message["operationId"].get_ref<const std::string&>();
  if (id.size() != 36)
    return false;
  for (size_t i = 0; i < id.size(); ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (id[i] != '-')
        return false;
    } else if (!((id[i] >= '0' && id[i] <= '9') || (id[i] >= 'a' && id[i] <= 'f') ||
                 (id[i] >= 'A' && id[i] <= 'F')))
      return false;
  }
  const auto type = message["action"].value("type", ServiceJson());
  // Control validates the action union; Endpoint only owns the bounded envelope.
  return BoundedServiceId(type);
}

// Routing receipts only: Control owns operation semantics and product state.
// Together requests, outstanding receipts and replies occupy at most 64 slots.
// No operation is replayed across a management disconnect or a peer replacement.
class DirectServices {
  struct Pending {
    ServiceJson message;
    double since;
    bool queued = false;
    DeliveryFlag delivery = std::make_shared<DeliveryState>();
  };
  mutable std::mutex mutex_;
  uint64_t peer_ = 0;
  std::string connection_;
  std::map<std::string, Pending> pending_;
  std::deque<std::string> results_;
  std::map<uint64_t, std::string> viewports_;
  std::map<uint64_t, std::string> pending_viewports_;
  std::string context_menu_;
  ServiceJson context_menu_identity_;
  uint64_t context_menu_ticket_ = 0;
  uint64_t context_menu_revision_ = 0;
  std::string selection_;
  ServiceJson selection_value_;
  uint64_t selection_revision_ = 0;
  std::string editable_;
  ServiceJson editable_value_;
  uint64_t editable_revision_ = 0;
  ServiceJson editable_focus_;
  uint64_t editable_focus_revision_ = 0;
  static std::string Key(const ServiceJson& value) {
    return value.at("operationGeneration").get<std::string>() + "\n" +
           value.at("operationId").get<std::string>();
  }
  ServiceJson Failure(const ServiceJson& request, const char* error, bool unknown = false) const {
    return {{"type", "product.result"},
            {"version", 1},
            {"operationId", request.at("operationId")},
            {"connectionId", connection_},
            {"operationGeneration", request.at("operationGeneration")},
            {"result",
             {{"operationId", request.at("operationId")},
              {"operationGeneration", request.at("operationGeneration")},
              {"status", unknown ? "unknown" : "failed"},
              {"error", WireError({unknown ? ErrorCode::kOutcomeUnknown : ErrorCode::kUnavailable,
                                   error})}}}};
  }

 public:
  void Bind(uint64_t peer, std::string connection = {}) {
    std::lock_guard lock(mutex_);
    peer_ = peer;
    viewports_.clear();
    pending_viewports_.clear();
    connection_ = std::move(connection);
    pending_.clear();
    results_.clear();
    editable_.clear();
    editable_value_ = nullptr;
    editable_revision_ = 0;
    editable_focus_ = nullptr;
    editable_focus_revision_ = 0;
    selection_.clear();
    selection_value_ = nullptr;
    selection_revision_ = 0;
    context_menu_.clear();
    context_menu_identity_ = nullptr;
    ++context_menu_ticket_;
    context_menu_revision_ = 0;
  }
  bool Admit(uint64_t peer, const ServiceJson& message, double now) {
    std::lock_guard lock(mutex_);
    if (!peer || peer != peer_)
      return false;
    const auto key = Key(message);
    if (pending_.contains(key))
      return true;
    if (pending_.size() + results_.size() >= 64)
      return false;
    pending_.emplace(key, Pending{message, now});
    return true;
  }
  template <class Dispatch>
  void DispatchPending(uint64_t peer, double now, Dispatch dispatch) {
    std::lock_guard lock(mutex_);
    if (!peer || peer != peer_)
      return;
    unsigned budget = 8;
    for (auto it = pending_.begin(); it != pending_.end();) {
      auto& item = it->second;
      if (now - item.since >= 15000) {
        // Once forwarded, a timeout cannot prove rejection. Return a queryable
        // uncertain receipt; never replay the operation to obtain another reply.
        const bool dispatched = item.delivery->CancelAndWasWritten();
        results_.push_back(Failure(item.message,
                                   dispatched ? "control_result_unknown" : "control_unavailable",
                                   dispatched)
                               .dump());
        it = pending_.erase(it);
        continue;
      }
      if (!item.queued && budget) {
        --budget;
        if (!dispatch(item.message, item.delivery)) {
          results_.push_back(Failure(item.message, "control_unavailable").dump());
          it = pending_.erase(it);
          continue;
        }
        item.queued = true;
      }
      ++it;
    }
  }
  bool Result(uint64_t peer, const ServiceJson& message) {
    std::lock_guard lock(mutex_);
    if (!peer || peer != peer_ || message.dump().size() > 16384)
      return false;
    const auto found = pending_.find(Key(message));
    if (found == pending_.end())
      return false;
    auto result = message;
    result["type"] = "product.result";
    result["version"] = 1;
    results_.push_back(result.dump());
    pending_.erase(found);
    return true;
  }
  void Viewports(uint64_t peer, const SharedAtlasFrame& frame) {
    std::lock_guard lock(mutex_);
    if (!peer || peer != peer_ || !frame.generation)
      return;
    for (uint32_t i = 0; i < frame.view_count; ++i) {
      const auto& view = frame.views[i];
      ServiceJson value = {{"type", "view.viewport"},
                           {"viewId", std::to_string(view.webview_id)},
                           {"session", std::to_string(view.session_id)},
                           {"instance", std::to_string(view.instance_generation)},
                           {"document", std::to_string(view.document_generation)},
                           {"pageHeight", view.page_height_dip},
                           {"outputGeneration", std::to_string(frame.generation)},
                           {"occlusionRevision", std::to_string(view.occlusion_revision)}};
      auto encoded = value.dump();
      if (viewports_[view.webview_id] != encoded) {
        viewports_[view.webview_id] = encoded;
        pending_viewports_[view.webview_id] = std::move(encoded);
      }
    }
  }
  void RefreshEditable() {
    std::lock_guard lock(mutex_);
    editable_value_ = nullptr;
    editable_.clear();
    selection_value_ = nullptr;
    selection_.clear();
    context_menu_.clear();
    context_menu_identity_ = nullptr;
    ++context_menu_ticket_;
  }
  void Editable(uint64_t peer, const SharedAtlasFrame& frame, bool output_suspended = false) {
    std::lock_guard lock(mutex_);
    if (!peer || peer != peer_)
      return;
    if (!output_suspended && (!frame.generation ||
                              (frame.status != SharedAtlasStatus::kStarting &&
                               frame.status != SharedAtlasStatus::kRunning) ||
                              frame.view_count > kSharedAtlasMaxViews))
      return;
    const SharedAtlasView* selected = nullptr;
    for (uint32_t i = 0; !output_suspended && i < frame.view_count; ++i) {
      const auto& view = frame.views[i];
      if (view.text_input.target_id && (view.text_input.flags & kAtlasTextInputActive)) {
        selected = &view;
        break;
      }
    }
    ServiceJson value = {{"view", nullptr},
                         {"editable",
                          {{"type", 0},
                           {"flags", 0},
                           {"active", false},
                           {"target", "0"},
                           {"focusSource", "other"},
                           {"focusRevision", "0"},
                           {"selectionStart", 0},
                           {"selectionEnd", 0},
                           {"compositionStart", 0},
                           {"compositionEnd", 0},
                           {"caretX", 0},
                           {"caretY", 0},
                           {"caretWidth", 0},
                           {"caretHeight", 0}}}};
    if (selected) {
      const auto& view = *selected;
      const auto& input = view.text_input;
      value["view"] = {{"session", std::to_string(view.session_id)},
                       {"id", std::to_string(view.webview_id)},
                       {"instance", std::to_string(view.instance_generation)},
                       {"document", std::to_string(view.document_generation)},
                       {"focus", std::to_string(view.focus_generation)}};
      auto finite = [](float v) { return std::isfinite(v) ? v : 0.0f; };
      value["editable"] = {
          {"type", input.type},
          {"flags", input.flags},
          {"active", true},
          {"target", std::to_string(input.target_id)},
          {"focusSource", std::array{"other", "pointer", "keyboard", "script"}[input.focus_source]},
          {"selectionStart", input.selection_start},
          {"selectionEnd", input.selection_end},
          {"compositionStart", input.composition_start},
          {"compositionEnd", input.composition_end},
          {"caretX", finite(input.caret_x)},
          {"caretY", finite(input.caret_y)},
          {"caretWidth", finite(input.caret_width)},
          {"caretHeight", finite(input.caret_height)}};
    }
    ServiceJson focus = nullptr;
    if (selected) {
      focus = {{"session", selected->session_id},
               {"view", selected->webview_id},
               {"instance", selected->instance_generation},
               {"document", selected->document_generation},
               {"target", selected->text_input.target_id},
               {"observation", selected->text_input.focus_observation}};
    }
    if (focus != editable_focus_) {
      editable_focus_ = focus;
      editable_focus_revision_ = selected ? editable_revision_ + 1 : 0;
    }
    value["editable"]["focusRevision"] = std::to_string(editable_focus_revision_);
    if (value == editable_value_)
      return;
    editable_value_ = value;
    value["type"] = "input.editable";
    value["version"] = 1;
    value["revision"] = std::to_string(++editable_revision_);
    editable_ = value.dump();
  }
  void Selection(uint64_t peer,
                 const SharedAtlasFrame& frame,
                 uint64_t layout_epoch,
                 bool output_suspended = false) {
    std::lock_guard lock(mutex_);
    if (!peer || peer != peer_)
      return;
    if (!output_suspended && (!frame.generation ||
                              (frame.status != SharedAtlasStatus::kStarting &&
                               frame.status != SharedAtlasStatus::kRunning) ||
                              frame.view_count > kSharedAtlasMaxViews))
      return;
    ServiceJson value = {
        {"view", nullptr},
        {"menu", nullptr},
        {"outputGeneration", std::to_string(frame.generation)},
        {"layoutEpoch", std::to_string(layout_epoch)},
        {"handles", {{"start", nullptr}, {"end", nullptr}, {"insertion", nullptr}}}};
    for (uint32_t i = 0; !output_suspended && i < frame.view_count; ++i) {
      const auto& view = frame.views[i];
      const auto& menu = view.selection_menu;
      const bool menu_visible = (menu.flags & kAtlasSelectionMenuVisible) && menu.menu_id;
      if (!menu_visible && !menu.start.visible && !menu.end.visible && !menu.insertion.visible)
        continue;
      value["view"] = {{"session", std::to_string(view.session_id)},
                       {"id", std::to_string(view.webview_id)},
                       {"instance", std::to_string(view.instance_generation)},
                       {"document", std::to_string(view.document_generation)}};
      auto commands = ServiceJson::array();
      const char* names[] = {"cut", "copy", "paste", "selectAll"};
      for (unsigned n = 0; n < 4; ++n)
        if (menu.flags & (2u << n))
          commands.push_back(names[n]);
      auto finite = [](float v) { return std::isfinite(v) ? v : 0.0f; };
      const auto handle = [&](const SharedAtlasSelectionMenu::Handle& bound) -> ServiceJson {
        if (!bound.visible)
          return nullptr;
        return {{"x", finite(bound.x)},
                {"y", finite(bound.y)},
                {"lineHeight", finite(bound.line_height)}};
      };
      value["handles"] = {{"start", handle(menu.start)},
                          {"end", handle(menu.end)},
                          {"insertion", handle(menu.insertion)}};
      if (menu_visible)
        value["menu"] = {{"id", std::to_string(menu.menu_id)},
                         {"x", finite(menu.anchor_x)},
                         {"y", finite(menu.anchor_y)},
                         {"width", finite(menu.anchor_width)},
                         {"height", finite(menu.anchor_height)},
                         {"handleHeight", finite(menu.handle_height)},
                         {"commands", commands},
                         {"more", (menu.flags & kAtlasSelectionCanContextMenu) != 0}};
      break;
    }
    if (value == selection_value_)
      return;
    selection_value_ = value;
    value["type"] = "input.selection";
    value["version"] = 1;
    value["revision"] = std::to_string(++selection_revision_);
    selection_ = value.dump();
  }
  static ServiceJson ContextMenuIdentity(const SharedAtlasFrame& frame, bool suspended) {
    if (suspended || frame.status == SharedAtlasStatus::kStopped ||
        frame.status == SharedAtlasStatus::kFailed)
      return {{"view", nullptr}, {"menu", nullptr}};
    if (!frame.generation || frame.view_count > kSharedAtlasMaxViews)
      return nullptr;
    for (uint32_t i = 0; i < frame.view_count; ++i) {
      const auto& view = frame.views[i];
      if (!view.context_menu.menu_id)
        continue;
      return {{"view",
               {{"session", std::to_string(view.session_id)},
                {"id", std::to_string(view.webview_id)},
                {"instance", std::to_string(view.instance_generation)},
                {"document", std::to_string(view.document_generation)}}},
              {"menu", std::to_string(view.context_menu.menu_id)}};
    }
    return {{"view", nullptr}, {"menu", nullptr}};
  }
  // Fetch runs on the session thread without mutex_: Browser RPCs must never
  // block DataChannel callbacks or the media thread. Latest rejects a result
  // whose menu or surface was superseded while the RPC was in flight.
  template <class Fetch, class Latest>
  void ContextMenu(uint64_t peer,
                   const SharedAtlasFrame& frame,
                   bool suspended,
                   Fetch fetch,
                   Latest latest) {
    auto identity = ContextMenuIdentity(frame, suspended);
    if (identity.is_null())
      return;
    uint64_t ticket;
    {
      std::lock_guard lock(mutex_);
      if (!peer || peer != peer_ || identity == context_menu_identity_)
        return;
      context_menu_identity_ = identity;
      ticket = ++context_menu_ticket_;
      context_menu_.clear();
    }
    auto value = identity;
    if (!identity["menu"].is_null()) {
      value["menu"] = fetch(identity);
      if (!value["menu"].is_object())
        return;
    }
    if (identity != latest())
      return;
    std::lock_guard lock(mutex_);
    if (peer != peer_ || ticket != context_menu_ticket_)
      return;
    value["type"] = "input.contextMenu";
    value["version"] = 1;
    value["revision"] = std::to_string(++context_menu_revision_);
    context_menu_ = value.dump();
  }
  template <class Send>
  void Flush(uint64_t peer, Send send) {
    std::lock_guard lock(mutex_);
    if (!peer || peer != peer_)
      return;
    for (unsigned n = 0; n < 4 && !results_.empty(); ++n) {
      if (send(results_.front()) != 0)
        return;
      results_.pop_front();
    }
    for (auto it = pending_viewports_.begin(); it != pending_viewports_.end();) {
      if (send(it->second) != 0)
        return;
      it = pending_viewports_.erase(it);
    }
    if (!editable_.empty() && send(editable_) == 0)
      editable_.clear();
    if (!selection_.empty() && send(selection_) == 0)
      selection_.clear();
    if (!context_menu_.empty() && send(context_menu_) == 0)
      context_menu_.clear();
  }
};

// Consume a too-long line completely without retaining its tail. Return a
// fixed invalid request so the caller can report an error and read the next line.

}  // namespace remotekit
