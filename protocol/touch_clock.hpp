#pragma once
#include <cstdint>
#include <optional>

namespace remotekit {
// Consult wall only at first down; caller freezes its monotonic origin.
inline std::optional<std::int64_t> TouchStartAgeUs(std::int64_t start_wall_us,
                                                   std::int64_t now_wall_us) {
  if (start_wall_us <= 0 || now_wall_us <= 0)
    return std::nullopt;
  const auto age = now_wall_us - start_wall_us;
  if (age < -1000 || age > 5000000)
    return std::nullopt;
  return age;
}
inline bool TouchElapsedValid(std::int64_t previous_us,
                              std::int64_t elapsed_us,
                              std::int64_t monotonic_age_us,
                              bool source) {
  return elapsed_us >= previous_us && elapsed_us >= 0 && elapsed_us <= 86400000000LL &&
         (!source || elapsed_us <= monotonic_age_us + 1000);
}
}  // namespace remotekit
