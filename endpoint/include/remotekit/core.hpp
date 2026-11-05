#pragma once
#include "remotekit/error.hpp"
#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <variant>
#include <vector>

namespace remotekit {
using WebViewId = std::uint64_t;
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
      fling_cancel
    };
    Type type{};
    double x{}, y{}, delta_x{}, delta_y{}, scale{1}, velocity_x{}, velocity_y{};
  };
  bool client_gestures{};
  std::vector<Gesture> gestures;
};
struct GestureInput {
  enum class Action { momentum, momentum_end, cancel };
  Action action{};
  std::string sequence_id;
  std::int64_t elapsed_us{};
  double cumulative_x{}, cumulative_y{};
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
using InputPayload = std::variant<KeyInput,
                                  MouseInput,
                                  WheelInput,
                                  TouchInput,
                                  GestureInput,
                                  ImeSet,
                                  ImeCommit,
                                  ImeCancel,
                                  ImeFinish>;
Result<void> ValidateInput(const InputPayload&);
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
struct Atlas {
  int width{}, height{}, padding{};
  std::vector<Placement> placements;
};
// Input order is preserved; best-short-side MaxRects scoring has deterministic ties.
// Dimensions are content pixels; padding is reserved on all four sides. No rotation.
Result<Atlas> PackAtlas(int width, int height, int padding, const std::vector<PackItem>&);
}  // namespace remotekit
