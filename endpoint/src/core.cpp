#include "remotekit/core.hpp"
#include <algorithm>
#include <cmath>
#include <limits>
#include <set>
#include <tuple>
#include <type_traits>

namespace remotekit {
namespace {
Status Fail(Error e, const char* m) {
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
                 v.action <= MouseInput::Action::up && v.click_count <= 3;
        else if constexpr (std::is_same_v<T, WheelInput>)
          return Finite(v.x, v.y) && Finite(v.delta_x, v.delta_y);
        else if constexpr (std::is_same_v<T, TouchInput>) {
          std::set<std::uint32_t> ids;
          if (v.action < TouchInput::Action::start || v.action > TouchInput::Action::cancel ||
              (v.points.empty() && v.action != TouchInput::Action::cancel))
            return false;
          for (const auto& t : v.points)
            if (!Finite(t.x, t.y) || !std::isfinite(t.pressure) || t.pressure < 0 ||
                t.pressure > 1 || !ids.insert(t.id).second)
              return false;
          return true;
        } else if constexpr (std::is_same_v<T, KeyInput>)
          return v.action >= KeyInput::Action::down && v.action <= KeyInput::Action::character &&
                 (v.action != KeyInput::Action::character || !v.text.empty()) &&
                 v.text.size() <= 4 && v.unmodified_text.size() <= 4 && Utf16(v.text) &&
                 Utf16(v.unmodified_text) && v.dom_key <= std::numeric_limits<std::uint32_t>::max();
        else
          return true;
      },
      p);
  return ok ? Status{} : Fail(Error::invalid, "Invalid input payload or UTF-16 selection");
}
Result<SessionId> Endpoint::CreateSession(std::string tenant) {
  if (tenant.empty())
    return {{}, Fail(Error::invalid, "Tenant cannot be empty")};
  if (tenants_.contains(tenant))
    return {{}, Fail(Error::already_exists, "Tenant already has a session")};
  auto id = next_session_++;
  sessions_.emplace(id, Session{id, tenant, {}, {}});
  tenants_.emplace(std::move(tenant), id);
  return {id, {}};
}
Result<ProfileId> Endpoint::AddProfile(SessionId s, std::string name) {
  auto it = sessions_.find(s);
  if (it == sessions_.end())
    return {{}, Fail(Error::not_found, "Session not found")};
  if (!it->second.profiles.empty())
    return {{}, Fail(Error::unsupported, "Multiple profiles per session are not implemented")};
  auto id = next_profile_++;
  it->second.profiles.emplace(id, Profile{id, std::move(name)});
  return {id, {}};
}
Result<WebViewId> Endpoint::CreateWebView(SessionId s, ProfileId p) {
  auto it = sessions_.find(s);
  if (it == sessions_.end())
    return {{}, Fail(Error::not_found, "Session not found")};
  if (!it->second.profiles.contains(p))
    return {{}, Fail(Error::wrong_session, "Profile does not belong to session")};
  auto id = next_view_++;
  WebView v;
  v.id = id;
  v.profile = p;
  it->second.views.emplace(id, v);
  return {id, {}};
}
const Session* Endpoint::FindSession(SessionId s) const {
  auto i = sessions_.find(s);
  return i == sessions_.end() ? nullptr : &i->second;
}
const WebView* Endpoint::FindWebView(SessionId s, WebViewId v) const {
  auto session = FindSession(s);
  if (!session)
    return nullptr;
  auto i = session->views.find(v);
  return i == session->views.end() ? nullptr : &i->second;
}
WebView* Endpoint::MutableView(SessionId s, WebViewId v) {
  auto i = sessions_.find(s);
  if (i == sessions_.end())
    return nullptr;
  auto j = i->second.views.find(v);
  return j == i->second.views.end() ? nullptr : &j->second;
}
Status Endpoint::SetFocus(SessionId s, WebViewId id, bool focused) {
  auto v = MutableView(s, id);
  if (!v)
    return Fail(Error::not_found, "WebView not found in session");
  if (focused && (v->actual != Residency::live || v->pending))
    return Fail(Error::unavailable, "WebView is not available");
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
Status Endpoint::CommitDocument(SessionId s, WebViewId id) {
  auto v = MutableView(s, id);
  if (!v)
    return Fail(Error::not_found, "WebView not found in session");
  if (v->actual != Residency::live || v->pending)
    return Fail(Error::unavailable, "WebView is not live");
  ++v->document;
  return {};
}
Status Endpoint::InvalidateInstance(SessionId s, WebViewId id) {
  auto v = MutableView(s, id);
  if (!v)
    return Fail(Error::not_found, "WebView not found in session");
  ++v->instance;
  ++v->document;
  ++v->focus_generation;
  ++v->lifecycle_generation;
  v->focused = false;
  v->pending.reset();
  return {};
}
Result<InputToken> Endpoint::Token(SessionId s, WebViewId id) const {
  auto v = FindWebView(s, id);
  if (!v)
    return {{}, Fail(Error::not_found, "WebView not found in session")};
  return {{s, id, v->instance, v->document, v->focus_generation}, {}};
}
Status Endpoint::AcceptInput(SessionId s, const InputEvent& e) {
  if (s != e.token.session)
    return Fail(Error::wrong_session, "Input token session mismatch");
  auto v = MutableView(s, e.token.view);
  if (!v)
    return Fail(Error::not_found, "WebView not found in session");
  if (e.token != Token(s, v->id).value || e.sequence <= v->last_sequence)
    return Fail(Error::stale, "Stale token or sequence");
  if (v->actual != Residency::live || v->pending || !v->focused)
    return Fail(Error::unavailable, "WebView cannot receive input");
  auto result = ValidateInput(e.payload);
  if (!result)
    return result;
  v->last_sequence = e.sequence;
  return {};
}
Result<LifecycleRequest> Endpoint::RequestLifecycle(SessionId s, WebViewId id, Lifecycle action) {
  auto v = MutableView(s, id);
  if (!v)
    return {{}, Fail(Error::not_found, "WebView not found in session")};
  if (v->pending)
    return {{}, Fail(Error::busy, "Lifecycle operation pending")};
  Residency target;
  switch (action) {
    case Lifecycle::freeze:
      if (v->actual != Residency::live)
        return {{}, Fail(Error::invalid, "Freeze requires live state")};
      target = Residency::frozen;
      break;
    case Lifecycle::discard:
      if (v->actual != Residency::live && v->actual != Residency::frozen)
        return {{}, Fail(Error::invalid, "Discard requires live or frozen state")};
      target = Residency::discarded;
      break;
    case Lifecycle::unload:
      target = Residency::unloaded;
      break;
    case Lifecycle::restore:
      if (v->actual == Residency::live)
        return {{}, Fail(Error::invalid, "Already live")};
      target = Residency::live;
      break;
    default:
      return {{}, Fail(Error::invalid, "Unknown lifecycle operation")};
  }
  v->desired = target;
  v->pending = LifecycleRequest{id, ++v->lifecycle_generation, action, target};
  // Invalidate queued input immediately, even if the external operation later fails.
  v->focused = false;
  ++v->focus_generation;
  return {*v->pending, {}};
}
Status Endpoint::CompleteLifecycle(SessionId s,
                                   const LifecycleRequest& r,
                                   bool succeeded,
                                   std::string detail) {
  auto v = MutableView(s, r.view);
  if (!v)
    return Fail(Error::not_found, "WebView not found in session");
  if (!v->pending || v->pending->generation != r.generation || v->pending->action != r.action ||
      v->pending->target != r.target)
    return Fail(Error::stale, "Stale lifecycle completion");
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

namespace {
bool Intersects(const PixelRect& a, const PixelRect& b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
bool Contains(const PixelRect& a, const PixelRect& b) {
  return a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width &&
         a.y + a.height >= b.y + b.height;
}
}  // namespace
Result<Atlas> PackAtlas(int width, int height, int padding, const std::vector<PackItem>& items) {
  if (width <= 0 || height <= 0 || padding < 0)
    return {{}, Fail(Error::invalid, "Invalid atlas bounds")};
  Atlas atlas{width, height, padding, {}};
  std::vector<PixelRect> free{{0, 0, width, height}};
  std::set<WebViewId> ids;
  for (const auto& item : items) {
    if (!ids.insert(item.view).second || item.width <= 0 || item.height <= 0 ||
        !std::isfinite(item.scale) || item.scale <= 0)
      return {{}, Fail(Error::invalid, "Invalid or duplicate pack item")};
    const auto wide = static_cast<std::int64_t>(item.width) + 2LL * padding,
               high = static_cast<std::int64_t>(item.height) + 2LL * padding;
    if (wide > width || high > height)
      return {{}, Fail(Error::no_space, "Item exceeds atlas bounds")};
    int w = static_cast<int>(wide), h = static_cast<int>(high);
    std::optional<PixelRect> chosen;
    auto best = std::tuple{std::numeric_limits<int>::max(), std::numeric_limits<int>::max(),
                           std::numeric_limits<int>::max(), std::numeric_limits<int>::max()};
    for (const auto& f : free)
      if (w <= f.width && h <= f.height) {
        auto score = std::tuple{std::min(f.width - w, f.height - h),
                                std::max(f.width - w, f.height - h), f.y, f.x};
        if (score < best) {
          best = score;
          chosen = PixelRect{f.x, f.y, w, h};
        }
      }
    if (!chosen)
      return {{}, Fail(Error::no_space, "Atlas packing failed")};
    const auto used = *chosen;
    std::vector<PixelRect> next;
    for (const auto& f : free) {
      if (!Intersects(f, used)) {
        next.push_back(f);
        continue;
      }
      if (used.x > f.x)
        next.push_back({f.x, f.y, used.x - f.x, f.height});
      if (used.x + used.width < f.x + f.width)
        next.push_back({used.x + used.width, f.y, f.x + f.width - used.x - used.width, f.height});
      if (used.y > f.y)
        next.push_back({f.x, f.y, f.width, used.y - f.y});
      if (used.y + used.height < f.y + f.height)
        next.push_back({f.x, used.y + used.height, f.width, f.y + f.height - used.y - used.height});
    }
    free.clear();
    for (std::size_t i = 0; i < next.size(); ++i) {
      bool redundant = false;
      for (std::size_t j = 0; j < next.size(); ++j)
        if (i != j && Contains(next[j], next[i]) && (next[j] != next[i] || j < i)) {
          redundant = true;
          break;
        }
      if (!redundant)
        free.push_back(next[i]);
    }
    atlas.placements.push_back({item.view,
                                used,
                                {used.x + padding, used.y + padding, item.width, item.height},
                                item.scale});
  }
  return {atlas, {}};
}
std::optional<Hit> Atlas::HitTest(double x, double y) const {
  if (!Finite(x, y))
    return std::nullopt;
  for (const auto& p : placements)
    if (x >= p.content.x && y >= p.content.y && x < p.content.x + p.content.width &&
        y < p.content.y + p.content.height)
      return Hit{p.view, (x - p.content.x) / p.scale, (y - p.content.y) / p.scale};
  return std::nullopt;
}
Result<std::pair<double, double>> Atlas::DipToPixel(WebViewId id, double x, double y) const {
  if (!Finite(x, y))
    return {{}, Fail(Error::invalid, "Non-finite coordinate")};
  for (const auto& p : placements)
    if (p.view == id) {
      if (x < 0 || y < 0 || x >= p.content.width / p.scale || y >= p.content.height / p.scale)
        return {{}, Fail(Error::invalid, "Coordinate outside content")};
      return {{p.content.x + x * p.scale, p.content.y + y * p.scale}, {}};
    }
  return {{}, Fail(Error::not_found, "View not packed")};
}
}  // namespace remotekit
