#include "input/validation.hpp"
#include <cmath>
#include <limits>
#include <set>
#include <type_traits>

namespace remotekit {
namespace {
Error Fail(ErrorCode e, const char* m) {
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
Result<void> ValidateInput(const InputPayload& p) {
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
                 v.action <= MouseInput::Action::leave && v.click_count <= 3;
        else if constexpr (std::is_same_v<T, WheelInput>)
          return Finite(v.x, v.y) && Finite(v.delta_x, v.delta_y);
        else if constexpr (std::is_same_v<T, TouchInput>) {
          if (v.gestures.size() > 8 || (!v.client_gestures && !v.gestures.empty()) ||
              (v.client_gestures && !v.clock))
            return false;
          for (const auto& g : v.gestures)
            if (g.type < TouchInput::Gesture::Type::tap_down ||
                g.type > TouchInput::Gesture::Type::fling_cancel || !Finite(g.x, g.y) ||
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
              if (!Finite(point.x, point.y) || !std::isfinite(point.pressure) ||
                  point.pressure < 0 || point.pressure > 1 || !sample_ids.insert(point.id).second)
                return false;
          }
          std::set<std::uint32_t> ids;
          if (v.action < TouchInput::Action::start || v.action > TouchInput::Action::cancel ||
              (v.points.empty() && v.action != TouchInput::Action::cancel))
            return false;
          for (const auto& t : v.points)
            if (!Finite(t.x, t.y) || !std::isfinite(t.pressure) || t.pressure < 0 ||
                t.pressure > 1 || !ids.insert(t.id).second)
              return false;
          return true;
        } else if constexpr (std::is_same_v<T, GestureInput>)
          return v.action >= GestureInput::Action::momentum &&
                 v.action <= GestureInput::Action::cancel && !v.sequence_id.empty() &&
                 v.sequence_id.size() <= 128 && v.elapsed_us >= 0 &&
                 v.elapsed_us <= 86400000000LL && Finite(v.cumulative_x, v.cumulative_y) &&
                 std::abs(v.cumulative_x) <= 1e7 && std::abs(v.cumulative_y) <= 1e7;
        else if constexpr (std::is_same_v<T, KeyInput>)
          return v.action >= KeyInput::Action::down && v.action <= KeyInput::Action::character &&
                 (v.action != KeyInput::Action::character || !v.text.empty()) &&
                 v.text.size() <= 4 && v.unmodified_text.size() <= 4 && Utf16(v.text) &&
                 Utf16(v.unmodified_text) && v.dom_key <= std::numeric_limits<std::uint32_t>::max();
        else
          return true;
      },
      p);
  return ok ? Result<void>{}
            : Fail(ErrorCode::kInvalidRequest, "Invalid input payload or UTF-16 selection");
}
}  // namespace remotekit
