#pragma once

#include "remotekit/protocol/control.h"
#include "protocol/atlas_plan.hpp"

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <variant>
#include <vector>

namespace remotekit {
using protocol::ErrorCode;
using TenantId = std::string;
using SessionId = std::uint64_t;
using ProfileId = std::uint64_t;
using WebViewId = std::uint64_t;
struct Status {
  std::optional<ErrorCode> error;
  std::string message;
  explicit operator bool() const { return !error; }
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
  std::optional<ErrorCode> error;
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
  enum class Action { move, down, up, leave };
  struct Pen {
    std::uint32_t id;
    double pressure, tilt_x, tilt_y, twist;
    bool eraser;
  };
  Action action{};
  double x{}, y{};
  std::uint8_t button{};
  std::uint32_t modifiers{};
  std::uint8_t click_count{1};
  std::optional<Pen> pen{};
};
struct WheelInput {
  double x{}, y{}, delta_x{}, delta_y{};
  std::uint32_t modifiers{};
};
struct TouchPoint {
  std::uint32_t id{};
  double x{}, y{}, pressure{};
  double width{}, height{};
};
struct TouchInput {
  enum class Action { start, move, end, cancel };
  Action action{};
  std::vector<TouchPoint> points;
  struct Clock {
    std::string sequence_id;
    bool source{};
    std::int64_t elapsed_us{}, start_wall_us{};
  };
  struct Sample {
    std::int64_t elapsed_us{};
    std::vector<TouchPoint> points;
  };
  std::optional<Clock> clock;
  std::vector<Sample> samples;
  struct Gesture {
    enum class Type {
      tap_down,
      tap_cancel,
      tap,
      scroll_begin,
      scroll_update,
      scroll_end,
      pinch_begin,
      pinch_update,
      pinch_end,
      fling_start,
      fling_cancel,
      long_tap
    };
    Type type{};
    double x{}, y{}, delta_x{}, delta_y{}, scale{1}, velocity_x{}, velocity_y{};
  };
  std::vector<Gesture> gestures;
};
struct GestureInput {
  enum class Action { momentum, momentum_end, cancel, long_press };
  Action action{};
  std::string sequence_id;
  std::int64_t elapsed_us{};
  double cumulative_x{}, cumulative_y{};
  double x{}, y{};
};
struct ImeSet {
  std::u16string text;
  std::uint32_t selection_start{}, selection_end{};
};
struct ImeCommit {
  std::u16string text;
};
struct SelectionCommand {
  std::uint64_t menu{};
  enum class Command { cut, copy, paste, select_all, context_menu, dismiss };
  Command command{};
};
struct SelectionExtent {
  enum class Which { start, end, insertion };
  Which which{};
  double x{}, y{};
};
struct ContextCommand {
  std::uint64_t menu{};
  enum class Command {
    undo,
    redo,
    cut,
    copy,
    paste,
    select_all,
    copy_link_address,
    copy_image,
    copy_image_address,
    dismiss
  };
  Command command{};
};
struct EditingDismiss {
  std::uint64_t target{}, revision{};
};
struct ImeCancel {};
struct ImeFinish {};
using InputPayload = std::variant<KeyInput,
                                  MouseInput,
                                  WheelInput,
                                  TouchInput,
                                  GestureInput,
                                  ImeSet,
                                  ImeCommit,
                                  ImeCancel,
                                  ImeFinish,
                                  SelectionCommand,
                                  SelectionExtent,
                                  ContextCommand,
                                  EditingDismiss>;
struct InputEvent {
  InputToken token;
  std::uint64_t sequence{};
  InputPayload payload;
  std::uint64_t editable_target{};
};
Status ValidateInput(const InputPayload&);
// Wire modifiers use Blink WebInputEvent bit positions, including back/forward.
inline constexpr std::uint32_t kMouseButtonModifiers =
    (1u << 6) | (1u << 7) | (1u << 8) | (1u << 20) | (1u << 21);
bool IsHoverInput(const InputPayload&);
bool IsDismissInput(const InputPayload&);

// A deterministic bookkeeping model. Request/complete calls do not execute browser work.
// The host authenticates tenant before selecting a session and serializes all access.
class ViewModel {
 public:
  Result<SessionId> CreateSession(TenantId tenant, SessionId requested_id = 0);
  Result<ProfileId> AddProfile(SessionId, std::string name);
  Result<WebViewId> CreateWebView(SessionId, ProfileId, WebViewId requested_id = 0);
  Status RemoveWebView(SessionId, WebViewId);
  Status ResetWebView(SessionId, WebViewId);
  const Session* FindSession(SessionId) const;
  const WebView* FindWebView(SessionId, WebViewId) const;
  Status CanFocus(SessionId, WebViewId, bool focused) const;
  Result<Residency> CanRequestLifecycle(SessionId, WebViewId, Lifecycle) const;
  Status SetFocus(SessionId, WebViewId, bool);
  Status CommitDocument(SessionId, WebViewId);
  // External instance loss (e.g. crash): invalidates all queued work without
  // requiring a live state. Does not claim a browser lifecycle operation ran.
  Status InvalidateInstance(SessionId, WebViewId);
  Status InvalidateInput(SessionId, WebViewId);
  Result<InputToken> Token(SessionId, WebViewId) const;
  Status AcceptInput(SessionId authenticated_session, const InputEvent&);
  Result<LifecycleRequest> RequestLifecycle(SessionId, WebViewId, Lifecycle);
  Status CompleteLifecycle(SessionId,
                           const LifecycleRequest&,
                           bool succeeded,
                           std::string detail = {},
                           std::optional<ErrorCode> error = {});

 private:
  std::map<SessionId, Session> sessions_;
  std::map<std::string, SessionId> tenants_;
  std::uint64_t next_session_{1}, next_profile_{1}, next_view_{1};
  WebView* MutableView(SessionId, WebViewId);
};

}  // namespace remotekit
