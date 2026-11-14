#pragma once
#include "protocol/shared_render_slots.h"
#include "util/wire_error.hpp"
#include "management/link.hpp"
#include "util/retry_unit.hpp"
#include "util/sdk_error.hpp"
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
class DirectServices {
  friend class NativeRetryOwnerProbe;
  const Json log_fields_;
  mutable std::mutex mutex_;
  uint64_t peer_ = 0;
  std::string connection_;
  std::map<uint64_t, std::string> viewports_;
  std::map<uint64_t, std::string> pending_viewports_;
  std::string context_menu_;
  ServiceJson context_menu_identity_;
  uint64_t context_menu_ticket_ = 0;
  uint64_t context_menu_revision_ = 0;
  RetryUnit context_menu_retry_{"context_menu.fetch"};
  std::map<std::string, RetryUnit> delivery_retries_;
  std::string selection_;
  ServiceJson selection_value_;
  uint64_t selection_revision_ = 0;
  std::string editable_;
  ServiceJson editable_value_;
  uint64_t editable_revision_ = 0;
  ServiceJson editable_focus_;
  uint64_t editable_focus_revision_ = 0;

 public:
  explicit DirectServices(Json log_fields = Json::object()) : log_fields_(std::move(log_fields)) {}
  Json DeliveryFailures() const {
    std::lock_guard lock(mutex_);
    Json failures = Json::object();
    for (const auto& [key, retry] : delivery_retries_)
      if (retry.Failure())
        failures[key] = WireError(*retry.Failure());
    return failures;
  }
  void Bind(uint64_t peer, std::string connection = {}) {
    std::lock_guard lock(mutex_);
    peer_ = peer;
    delivery_retries_.clear();
    viewports_.clear();
    pending_viewports_.clear();
    connection_ = std::move(connection);
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
      context_menu_retry_.Input(std::to_string(peer) + ":" + identity.dump());
      if (!context_menu_retry_.Ready())
        return;
      ticket = ++context_menu_ticket_;
      context_menu_.clear();
    }
    auto value = identity;
    if (!identity["menu"].is_null()) {
      Result<ServiceJson> fetched = fetch(identity);
      if (!fetched) {
        std::lock_guard lock(mutex_);
        if (peer == peer_ && ticket == context_menu_ticket_)
          context_menu_retry_.Fail(fetched.error());
        return;
      }
      value["menu"] = std::move(fetched).value();
      if (!value["menu"].is_object()) {
        std::lock_guard lock(mutex_);
        if (peer == peer_ && ticket == context_menu_ticket_)
          context_menu_retry_.Fail({ErrorCode::kInternal, "context menu reply is invalid"});
        return;
      }
    }
    if (identity != latest())
      return;
    std::lock_guard lock(mutex_);
    if (peer != peer_ || ticket != context_menu_ticket_)
      return;
    context_menu_identity_ = identity;
    context_menu_retry_.Success();
    value["type"] = "input.contextMenu";
    value["version"] = 1;
    value["revision"] = std::to_string(++context_menu_revision_);
    context_menu_ = value.dump();
  }
  template <class Send>
  void Flush(uint64_t peer, Send send, RetryUnit::Clock::time_point now = RetryUnit::Clock::now()) {
    std::lock_guard lock(mutex_);
    if (!peer || peer != peer_)
      return;
    const auto deliver = [&](const std::string& key, const std::string& bytes) {
      auto& retry = delivery_retries_.try_emplace(key, "surface.delivery").first->second;
      retry.Input(bytes);
      if (!retry.Ready(now))
        return retry.Status() != RetryUnit::State::kWaiting;
      const auto status = send(bytes);
      if (status) {
        retry.Fail({SdkErrorCode(status), "surface data send failed"}, now);
        return retry.Status() != RetryUnit::State::kWaiting;
      }
      retry.Success();
      return true;
    };
    for (auto it = pending_viewports_.begin(); it != pending_viewports_.end();) {
      if (deliver("viewport:" + std::to_string(it->first), it->second))
        it = pending_viewports_.erase(it);
      else
        ++it;
    }
    if (!editable_.empty() && deliver("editable", editable_))
      editable_.clear();
    if (!selection_.empty() && deliver("selection", selection_))
      selection_.clear();
    if (!context_menu_.empty() && deliver("menu", context_menu_))
      context_menu_.clear();
  }
};

}  // namespace remotekit
