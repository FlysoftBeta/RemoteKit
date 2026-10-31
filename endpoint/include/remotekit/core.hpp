#pragma once
#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <utility>
#include <variant>
#include <vector>

namespace remotekit {
using TenantId = std::string;
using SessionId = std::uint64_t;
using ProfileId = std::uint64_t;
using WebViewId = std::uint64_t;
enum class Error {
  none,
  not_found,
  wrong_session,
  already_exists,
  unsupported,
  invalid,
  busy,
  stale,
  unavailable,
  no_space
};
struct Status {
  Error error{Error::none};
  std::string message;
  explicit operator bool() const { return error == Error::none; }
};
template <class T>
struct Result {
  T value{};
  Status status{};
  explicit operator bool() const { return static_cast<bool>(status); }
};
enum class Residency { live, frozen, discarded, unloaded };
enum class Lifecycle { freeze, discard, unload, restore };
struct InputToken {
  SessionId session{};
  WebViewId view{};
  std::uint64_t instance{}, document{}, focus{};
  bool operator==(const InputToken&) const = default;
};
struct LifecycleRequest {
  WebViewId view{};
  std::uint64_t generation{};
  Lifecycle action{};
  Residency target{};
};
struct LifecycleResult {
  std::uint64_t generation{};
  Lifecycle action{};
  bool succeeded{};
  std::string detail;
};
struct WebView {
  WebViewId id{};
  ProfileId profile{};
  Residency desired{Residency::live}, actual{Residency::live};
  std::uint64_t instance{1}, document{1}, focus_generation{1};
  bool focused{};
  std::uint64_t last_sequence{}, lifecycle_generation{};
  std::optional<LifecycleRequest> pending;
  std::optional<LifecycleResult> last_lifecycle;
};
struct Profile {
  ProfileId id{};
  std::string name;
};
struct Session {
  SessionId id{};
  TenantId tenant;
  std::map<ProfileId, Profile> profiles;
  std::map<WebViewId, WebView> views;
};
struct KeyInput {
  enum class Action { down, up, character };
  Action action{};
  std::uint32_t physical_code{}, modifiers{};
  bool repeat{};
  std::int32_t windows_key_code{};
  std::uint32_t dom_code{};
  std::uint64_t dom_key{};
  std::u16string text, unmodified_text;
};
struct MouseInput {
  enum class Action { move, down, up };
  Action action{};
  double x{}, y{};
  std::uint8_t button{};
  std::uint32_t modifiers{};
  std::uint8_t click_count{1};
};
struct WheelInput {
  double x{}, y{}, delta_x{}, delta_y{};
  std::uint32_t modifiers{};
};
struct TouchPoint {
  std::uint32_t id{};
  double x{}, y{}, pressure{};
};
struct TouchInput {
  enum class Action { start, move, end, cancel };
  Action action{};
  std::vector<TouchPoint> points;
};
struct ImeSet {
  std::u16string text;
  std::uint32_t selection_start{}, selection_end{};
};
struct ImeCommit {
  std::u16string text;
};
struct ImeCancel {};
struct ImeFinish {};
using InputPayload = std::
    variant<KeyInput, MouseInput, WheelInput, TouchInput, ImeSet, ImeCommit, ImeCancel, ImeFinish>;
struct InputEvent {
  InputToken token;
  std::uint64_t sequence{};
  InputPayload payload;
};
Status ValidateInput(const InputPayload&);

// A deterministic bookkeeping model. Request/complete calls do not execute browser work.
// The host authenticates tenant before selecting a session and serializes all access.
class Endpoint {
 public:
  Result<SessionId> CreateSession(TenantId tenant);
  Result<ProfileId> AddProfile(SessionId, std::string name);
  Result<WebViewId> CreateWebView(SessionId, ProfileId);
  const Session* FindSession(SessionId) const;
  const WebView* FindWebView(SessionId, WebViewId) const;
  Status SetFocus(SessionId, WebViewId, bool);
  Status CommitDocument(SessionId, WebViewId);
  // External instance loss (e.g. crash): invalidates all queued work without
  // requiring a live state. Does not claim a browser lifecycle operation ran.
  Status InvalidateInstance(SessionId, WebViewId);
  Result<InputToken> Token(SessionId, WebViewId) const;
  Status AcceptInput(SessionId authenticated_session, const InputEvent&);
  Result<LifecycleRequest> RequestLifecycle(SessionId, WebViewId, Lifecycle);
  Status CompleteLifecycle(SessionId,
                           const LifecycleRequest&,
                           bool succeeded,
                           std::string detail = {});

 private:
  std::map<SessionId, Session> sessions_;
  std::map<std::string, SessionId> tenants_;
  std::uint64_t next_session_{1}, next_profile_{1}, next_view_{1};
  WebView* MutableView(SessionId, WebViewId);
};

struct PixelRect {
  int x{}, y{}, width{}, height{};
  bool operator==(const PixelRect&) const = default;
};
struct PackItem {
  WebViewId view{};
  int width{}, height{};
  double scale{1.0};
};
struct Placement {
  WebViewId view{};
  PixelRect outer, content;
  double scale{1.0};
};
struct Hit {
  WebViewId view{};
  double dip_x{}, dip_y{};
};
struct Atlas {
  int width{}, height{}, padding{};
  std::vector<Placement> placements;
  std::optional<Hit> HitTest(double pixel_x, double pixel_y) const;
  Result<std::pair<double, double>> DipToPixel(WebViewId, double x, double y) const;
};
// Input order is preserved; best-short-side MaxRects scoring has deterministic ties.
// Dimensions are content pixels; padding is reserved on all four sides. No rotation.
Result<Atlas> PackAtlas(int width, int height, int padding, const std::vector<PackItem>&);
}  // namespace remotekit
