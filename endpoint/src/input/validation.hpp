#pragma once
#include "util/error.hpp"
#include <cstdint>
#include <optional>
#include <string>
#include <variant>
#include <vector>

namespace remotekit {
using WebViewId = std::uint64_t;
inline constexpr std::uint32_t kInputModifiers =
    0xf | (1u << 6) | (1u << 7) | (1u << 8) | (1u << 9) | (1u << 10) | (1u << 20) | (1u << 21);
struct PenInput {
  std::uint32_t id{};
  double pressure{}, tilt_x{}, tilt_y{}, twist{};
  bool eraser{};
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
  Action action{};
  double x{}, y{};
  std::uint8_t button{};
  std::uint32_t modifiers{};
  std::uint8_t click_count{1};
  std::optional<PenInput> pen;
};
struct WheelInput {
  double x{}, y{}, delta_x{}, delta_y{};
  std::uint32_t modifiers{};
};
struct TouchPoint {
  std::uint32_t id{};
  double x{}, y{}, pressure{};
  std::optional<double> width, height;
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
  bool client_gestures{};
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
  enum class Command { cut, copy, paste, select_all, context_menu };
  Command command{};
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
struct ImeCancel {};
struct ImeFinish {};
struct KeyboardLayoutInput {
  std::vector<std::pair<std::string, std::u16string>> entries;
};
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
                                  ContextCommand,
                                  KeyboardLayoutInput>;
bool ValidPen(const PenInput&);
bool ValidContactSize(const std::optional<double>&);
Result<void> ValidateInput(const InputPayload&);
}  // namespace remotekit
