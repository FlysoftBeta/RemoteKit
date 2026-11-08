#include "remotekit/browser/view_model.h"
#include <algorithm>
#include <cmath>
#include <limits>
#include <set>
#include <type_traits>
#include <utility>

namespace remotekit {
namespace {
Status Fail(ErrorCode e, const char* m) {
  return {e, m};
}
bool Utf16(const std::u16string& s) {
  for (std::size_t i = 0; i < s.size(); ++i) {
    auto c = s[i];
    if (c >= 0xd800 && c <= 0xdbff) {
      if (++i >= s.size() || s[i] < 0xdc00 || s[i] > 0xdfff)
        return false;
    } else if (c >= 0xdc00 && c <= 0xdfff)
      return false;
  }
  return true;
}
bool Boundary(const std::u16string& s, std::size_t p) {
  return p <= s.size() && (p == 0 || p == s.size() || !(s[p] >= 0xdc00 && s[p] <= 0xdfff));
}
bool Finite(double a, double b) {
  return std::isfinite(a) && std::isfinite(b);
}
bool InRange(double value, double minimum, double maximum) {
  return value >= minimum && value <= maximum;
}
bool ValidTouchPoint(const TouchPoint& point) {
  return Finite(point.x, point.y) && InRange(point.pressure, 0, 1) &&
         InRange(point.width, 0, 1000) && InRange(point.height, 0, 1000);
}
}  // namespace
Status ValidateInput(const InputPayload& p) {
  bool ok = std::visit(
      [](const auto& v) {
        using T = std::decay_t<decltype(v)>;
        if constexpr (std::is_same_v<T, ImeSet>)
          return Utf16(v.text) && v.selection_start <= v.selection_end &&
                 Boundary(v.text, v.selection_start) && Boundary(v.text, v.selection_end);
        else if constexpr (std::is_same_v<T, ImeCommit>)
          return Utf16(v.text);
        else if constexpr (std::is_same_v<T, MouseInput>)
          return Finite(v.x, v.y) && v.button <= 5 && v.action >= MouseInput::Action::move &&
                 v.action <= MouseInput::Action::leave && v.click_count <= 3 &&
                 (!v.pen || (InRange(v.pen->pressure, 0, 1) && InRange(v.pen->tilt_x, -90, 90) &&
                             InRange(v.pen->tilt_y, -90, 90) && InRange(v.pen->twist, 0, 359)));
        else if constexpr (std::is_same_v<T, WheelInput>)
          return Finite(v.x, v.y) && Finite(v.delta_x, v.delta_y);
        else if constexpr (std::is_same_v<T, TouchInput>) {
          if (v.gestures.size() > 8 || !v.clock)
            return false;
          for (const auto& g : v.gestures)
            if (g.type < TouchInput::Gesture::Type::tap_down ||
                g.type > TouchInput::Gesture::Type::long_tap || !Finite(g.x, g.y) ||
                !Finite(g.delta_x, g.delta_y) || !Finite(g.velocity_x, g.velocity_y) ||
                !std::isfinite(g.scale) || g.scale <= 0 || std::abs(g.x) > 1e7 ||
                std::abs(g.y) > 1e7 || std::abs(g.delta_x) > 1e7 || std::abs(g.delta_y) > 1e7 ||
                std::abs(g.velocity_x) > 1e7 || std::abs(g.velocity_y) > 1e7 || g.scale > 100)
              return false;
          if (v.samples.size() > 32 ||
              (!v.samples.empty() && (!v.clock || v.action != TouchInput::Action::move)))
            return false;
          if (v.clock && (v.clock->sequence_id.empty() || v.clock->sequence_id.size() > 128 ||
                          v.clock->elapsed_us < 0 || v.clock->elapsed_us > 86400000000LL ||
                          (v.clock->source && v.clock->start_wall_us <= 0)))
            return false;
          std::int64_t previous = -1;
          for (const auto& sample : v.samples) {
            if (sample.elapsed_us < previous || sample.elapsed_us > v.clock->elapsed_us ||
                sample.points.empty() || sample.points.size() > 16)
              return false;
            previous = sample.elapsed_us;
            std::set<std::uint32_t> sample_ids;
            for (const auto& point : sample.points)
              if (!ValidTouchPoint(point) || !sample_ids.insert(point.id).second)
                return false;
          }
          std::set<std::uint32_t> ids;
          if (v.action < TouchInput::Action::start || v.action > TouchInput::Action::cancel ||
              (v.points.empty() && v.action != TouchInput::Action::cancel))
            return false;
          for (const auto& t : v.points)
            if (!ValidTouchPoint(t) || !ids.insert(t.id).second)
              return false;
          return true;
        } else if constexpr (std::is_same_v<T, GestureInput>)
          return v.action >= GestureInput::Action::momentum &&
                 v.action <= GestureInput::Action::long_press && !v.sequence_id.empty() &&
                 v.sequence_id.size() <= 128 && v.elapsed_us >= 0 &&
                 v.elapsed_us <= 86400000000LL && Finite(v.cumulative_x, v.cumulative_y) &&
                 std::abs(v.cumulative_x) <= 1e7 && std::abs(v.cumulative_y) <= 1e7 &&
                 Finite(v.x, v.y) && std::abs(v.x) <= 1e7 && std::abs(v.y) <= 1e7;
        else if constexpr (std::is_same_v<T, SelectionCommand>)
          return v.menu && v.command >= SelectionCommand::Command::cut &&
                 v.command <= SelectionCommand::Command::context_menu;
        else if constexpr (std::is_same_v<T, ContextCommand>)
          return v.menu && v.command >= ContextCommand::Command::undo &&
                 v.command <= ContextCommand::Command::dismiss;
        else if constexpr (std::is_same_v<T, KeyInput>)
          return v.action >= KeyInput::Action::down && v.action <= KeyInput::Action::character &&
                 (v.action != KeyInput::Action::character || !v.text.empty()) &&
                 v.text.size() <= 4 && v.unmodified_text.size() <= 4 && Utf16(v.text) &&
                 Utf16(v.unmodified_text) && v.dom_key <= std::numeric_limits<std::uint32_t>::max();
        else
          return true;
      },
      p);
  return ok ? Status{}
            : Fail(ErrorCode::invalid_request, "Invalid input payload or UTF-16 selection");
}
Result<SessionId> ViewModel::CreateSession(std::string tenant, SessionId requested_id) {
  if (tenant.empty())
    return {{}, Fail(ErrorCode::invalid_request, "Tenant cannot be empty")};
  if (tenants_.contains(tenant))
    return {{}, Fail(ErrorCode::invalid_request, "Tenant already has a session")};
  if (!requested_id && next_session_ == UINT64_MAX)
    return {{}, Fail(ErrorCode::unavailable, "Session ID space exhausted")};
  auto id = requested_id ? requested_id : next_session_++;
  if (sessions_.contains(id))
    return {{}, Fail(ErrorCode::invalid_request, "Session ID already exists")};
  if (requested_id && requested_id >= next_session_)
    next_session_ = requested_id == UINT64_MAX ? UINT64_MAX : requested_id + 1;
  sessions_.emplace(id, Session{id, tenant, {}, {}});
  tenants_.emplace(std::move(tenant), id);
  return {id, {}};
}
Result<ProfileId> ViewModel::AddProfile(SessionId s, std::string name) {
  auto it = sessions_.find(s);
  if (it == sessions_.end())
    return {{}, Fail(ErrorCode::not_found, "Session not found")};
  if (!it->second.profiles.empty())
    return {{}, Fail(ErrorCode::unsupported, "Multiple profiles per session are not implemented")};
  auto id = next_profile_++;
  it->second.profiles.emplace(id, Profile{id, std::move(name)});
  return {id, {}};
}
Result<WebViewId> ViewModel::CreateWebView(SessionId s, ProfileId p, WebViewId requested_id) {
  auto it = sessions_.find(s);
  if (it == sessions_.end())
    return {{}, Fail(ErrorCode::not_found, "Session not found")};
  if (!it->second.profiles.contains(p))
    return {{}, Fail(ErrorCode::stale_identity, "Profile does not belong to session")};
  if (!requested_id && next_view_ == UINT64_MAX)
    return {{}, Fail(ErrorCode::unavailable, "WebView ID space exhausted")};
  auto id = requested_id ? requested_id : next_view_++;
  for (const auto& [session_id, session] : sessions_)
    if (session.views.contains(id))
      return {{}, Fail(ErrorCode::invalid_request, "WebView ID already exists")};
  if (requested_id && requested_id >= next_view_)
    next_view_ = requested_id == UINT64_MAX ? UINT64_MAX : requested_id + 1;
  WebView v;
  v.id = id;
  v.profile = p;
  it->second.views.emplace(id, v);
  return {id, {}};
}
Status ViewModel::ResetWebView(SessionId session, WebViewId view) {
  auto* model = MutableView(session, view);
  if (!model)
    return Fail(ErrorCode::not_found, "WebView not found in session");
  InvalidateInstance(session, view);
  model->actual = model->desired = Residency::live;
  model->last_lifecycle.reset();
  return {};
}
Status ViewModel::RemoveWebView(SessionId session, WebViewId view) {
  auto it = sessions_.find(session);
  if (it == sessions_.end() || !it->second.views.erase(view))
    return Fail(ErrorCode::not_found, "WebView not found in session");
  return {};
}
const Session* ViewModel::FindSession(SessionId s) const {
  auto i = sessions_.find(s);
  return i == sessions_.end() ? nullptr : &i->second;
}
const WebView* ViewModel::FindWebView(SessionId s, WebViewId v) const {
  auto session = FindSession(s);
  if (!session)
    return nullptr;
  auto i = session->views.find(v);
  return i == session->views.end() ? nullptr : &i->second;
}
WebView* ViewModel::MutableView(SessionId s, WebViewId v) {
  auto i = sessions_.find(s);
  if (i == sessions_.end())
    return nullptr;
  auto j = i->second.views.find(v);
  return j == i->second.views.end() ? nullptr : &j->second;
}
Status ViewModel::SetFocus(SessionId s, WebViewId id, bool focused) {
  auto v = MutableView(s, id);
  if (!v)
    return Fail(ErrorCode::not_found, "WebView not found in session");
  if (focused && (v->actual != Residency::live || v->pending))
    return Fail(ErrorCode::unavailable, "WebView is not available");
  if (focused)
    for (auto& [other_id, other] : sessions_.at(s).views)
      if (other_id != id && other.focused) {
        other.focused = false;
        ++other.focus_generation;
      }
  if (v->focused != focused) {
    v->focused = focused;
    ++v->focus_generation;
  }
  return {};
}
Status ViewModel::InvalidateInput(SessionId session, WebViewId view) {
  auto* model = MutableView(session, view);
  if (!model)
    return Fail(ErrorCode::not_found, "WebView not found in session");
  ++model->focus_generation;
  return {};
}
Status ViewModel::CommitDocument(SessionId s, WebViewId id) {
  auto v = MutableView(s, id);
  if (!v)
    return Fail(ErrorCode::not_found, "WebView not found in session");
  // A renderer can commit during freeze/thaw. Preserve the new document's
  // identity while the pending lifecycle request continues to gate input.
  if ((v->actual != Residency::live && v->actual != Residency::frozen) ||
      (v->pending && v->pending->action != Lifecycle::freeze &&
       !(v->pending->action == Lifecycle::restore && v->actual == Residency::frozen)))
    return Fail(ErrorCode::unavailable, "WebView does not have a live document");
  ++v->document;
  return {};
}
Status ViewModel::InvalidateInstance(SessionId s, WebViewId id) {
  auto v = MutableView(s, id);
  if (!v)
    return Fail(ErrorCode::not_found, "WebView not found in session");
  ++v->instance;
  ++v->document;
  ++v->focus_generation;
  ++v->lifecycle_generation;
  v->focused = false;
  v->pending.reset();
  return {};
}
Result<InputToken> ViewModel::Token(SessionId s, WebViewId id) const {
  auto v = FindWebView(s, id);
  if (!v)
    return {{}, Fail(ErrorCode::not_found, "WebView not found in session")};
  return {{s, id, v->instance, v->document, v->focus_generation}, {}};
}
bool IsHoverInput(const InputPayload& payload) {
  const auto* mouse = std::get_if<MouseInput>(&payload);
  return mouse &&
         (mouse->action == MouseInput::Action::move ||
          mouse->action == MouseInput::Action::leave) &&
         mouse->button == 0 && !(mouse->modifiers & kMouseButtonModifiers);
}
Status ViewModel::AcceptInput(SessionId s, const InputEvent& e) {
  if (s != e.token.session)
    return Fail(ErrorCode::stale_identity, "Input token session mismatch");
  auto v = MutableView(s, e.token.view);
  if (!v)
    return Fail(ErrorCode::not_found, "WebView not found in session");
  if (e.token != Token(s, v->id).value || e.sequence <= v->last_sequence)
    return Fail(ErrorCode::stale_identity, "Stale token or sequence");
  if (v->actual != Residency::live || v->pending || (!v->focused && !IsHoverInput(e.payload)))
    return Fail(ErrorCode::unavailable, "WebView cannot receive input");
  auto result = ValidateInput(e.payload);
  if (!result)
    return result;
  v->last_sequence = e.sequence;
  return {};
}
Result<LifecycleRequest> ViewModel::RequestLifecycle(SessionId s, WebViewId id, Lifecycle action) {
  auto v = MutableView(s, id);
  if (!v)
    return {{}, Fail(ErrorCode::not_found, "WebView not found in session")};
  if (v->pending)
    return {{}, Fail(ErrorCode::busy, "Lifecycle operation pending")};
  Residency target;
  switch (action) {
    case Lifecycle::freeze:
      if (v->actual != Residency::live)
        return {{}, Fail(ErrorCode::invalid_request, "Freeze requires live state")};
      target = Residency::frozen;
      break;
    case Lifecycle::discard:
      if (v->actual != Residency::live && v->actual != Residency::frozen)
        return {{}, Fail(ErrorCode::invalid_request, "Discard requires live or frozen state")};
      target = Residency::discarded;
      break;
    case Lifecycle::unload:
      target = Residency::unloaded;
      break;
    case Lifecycle::restore:
      if (v->actual == Residency::live)
        return {{}, Fail(ErrorCode::invalid_request, "Already live")};
      target = Residency::live;
      break;
    default:
      return {{}, Fail(ErrorCode::invalid_request, "Unknown lifecycle operation")};
  }
  v->desired = target;
  v->pending = LifecycleRequest{id, ++v->lifecycle_generation, action, target};
  // Invalidate queued input immediately, even if the external operation later fails.
  v->focused = false;
  ++v->focus_generation;
  return {*v->pending, {}};
}
Status ViewModel::CompleteLifecycle(SessionId s,
                                    const LifecycleRequest& r,
                                    bool succeeded,
                                    std::string detail) {
  auto v = MutableView(s, r.view);
  if (!v)
    return Fail(ErrorCode::not_found, "WebView not found in session");
  if (!v->pending || v->pending->generation != r.generation || v->pending->action != r.action ||
      v->pending->target != r.target)
    return Fail(ErrorCode::stale_identity, "Stale lifecycle completion");
  if (succeeded) {
    if (r.target == Residency::discarded || r.target == Residency::unloaded) {
      ++v->instance;
      ++v->document;
    }
    v->actual = r.target;
  }
  v->last_lifecycle = LifecycleResult{r.generation, r.action, succeeded, std::move(detail)};
  v->pending.reset();
  return {};
}

}  // namespace remotekit
