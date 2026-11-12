#pragma once
#include "util/common.hpp"
#include "util/log.hpp"
#include <algorithm>
#include <cmath>
#include <initializer_list>
#include <limits>
#include <stdexcept>
#include <string_view>

namespace remotekit {
inline Error CorruptState(std::string message) {
  Error error{ErrorCode::kInternal, std::move(message), ErrorReason::kCorruptState};
  error.error_id = NewErrorId();
  return error;
}
inline Error CorruptRecord(std::string message) {
  Error error{ErrorCode::kInternal, std::move(message), ErrorReason::kCorruptRecord};
  error.error_id = NewErrorId();
  return error;
}
namespace persisted {
inline void Require(bool valid, std::string_view message) {
  if (!valid)
    throw std::runtime_error(std::string(message));
}
inline void Keys(const Json& value,
                 std::initializer_list<std::string_view> required,
                 std::initializer_list<std::string_view> optional = {}) {
  Require(value.is_object(), "expected object");
  for (const auto key : required)
    Require(value.contains(key), "missing required field: " + std::string(key));
  for (const auto& [key, item] : value.items())
    Require(std::find(required.begin(), required.end(), key) != required.end() ||
                std::find(optional.begin(), optional.end(), key) != optional.end(),
            "unknown field: " + key);
}
inline const std::string& Text(const Json& value, size_t min = 0, size_t max = 1024 * 1024) {
  Require(value.is_string(), "expected string");
  const auto& text = value.get_ref<const std::string&>();
  Require(text.size() >= min && text.size() <= max, "string length outside bounds");
  return text;
}
inline uint64_t Unsigned(const Json& value,
                         uint64_t min = 0,
                         uint64_t max = std::numeric_limits<int64_t>::max()) {
  Require(value.is_number_integer() && value >= 0, "expected nonnegative integer");
  const auto number = value.get<uint64_t>();
  Require(number >= min && number <= max, "integer outside bounds");
  return number;
}
inline double Number(const Json& value, double min, double max) {
  Require(value.is_number(), "expected number");
  const auto number = value.get<double>();
  Require(std::isfinite(number) && number >= min && number <= max, "number outside bounds");
  return number;
}
inline bool Boolean(const Json& value) {
  Require(value.is_boolean(), "expected boolean");
  return value.get<bool>();
}
inline void Array(const Json& value, size_t max) {
  Require(value.is_array() && value.size() <= max, "expected bounded array");
}
inline void Enum(const Json& value, std::initializer_list<std::string_view> choices) {
  const auto& text = Text(value);
  Require(std::find(choices.begin(), choices.end(), text) != choices.end(), "unknown enumeration");
}
inline void Version(const Json& value, uint64_t version) {
  Require(Unsigned(value, version, version) == version, "invalid format version");
}
}  // namespace persisted
}  // namespace remotekit
