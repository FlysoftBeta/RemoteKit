#pragma once
#include "input/validation.hpp"
#include "util/common.hpp"
#include <cmath>
#include <windows.h>

namespace remotekit {
inline bool InputNumber(const Json& value, double minimum, double maximum) {
  if (!value.is_number())
    return false;
  const auto number = value.get<double>();
  return std::isfinite(number) && number >= minimum && number <= maximum;
}

inline Result<PenInput> ParsePen(const Json& value) {
  if (!value.is_object() || !value.contains("id") || !InputNumber(value["id"], 0, UINT32_MAX) ||
      std::floor(value["id"].get<double>()) != value["id"].get<double>() ||
      !value.contains("eraser") || !value["eraser"].is_boolean())
    return Error{ErrorCode::kInvalidRequest, "invalid pen identity"};
  for (const auto* field : {"pressure", "tiltX", "tiltY", "twist"})
    if (!value.contains(field) || !value[field].is_number())
      return Error{ErrorCode::kInvalidRequest, "invalid pen field"};
  PenInput pen{value["id"].get<uint32_t>(),  value["pressure"].get<double>(),
               value["tiltX"].get<double>(), value["tiltY"].get<double>(),
               value["twist"].get<double>(), value["eraser"].get<bool>()};
  if (!ValidPen(pen))
    return Error{ErrorCode::kInvalidRequest, "invalid pen range"};
  return pen;
}

inline Result<KeyboardLayoutInput> ParseKeyboardLayout(const Json& message) {
  if (!message.is_object() || !message.contains("entries") || !message["entries"].is_array() ||
      message["entries"].size() > 256)
    return Error{ErrorCode::kInvalidRequest, "invalid keyboard layout entries"};
  KeyboardLayoutInput layout;
  for (const auto& entry : message["entries"]) {
    if (!entry.is_array() || entry.size() != 2 || !entry[0].is_string() || !entry[1].is_string())
      return Error{ErrorCode::kInvalidRequest, "invalid keyboard layout entry"};
    const auto& key = entry[1].get_ref<const std::string&>();
    if (key.empty() || key.size() > 16)
      return Error{ErrorCode::kInvalidRequest, "invalid keyboard layout key"};
    wchar_t utf16[4];
    const auto length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, key.data(),
                                            static_cast<int>(key.size()), utf16, 4);
    if (!length)
      return Error{ErrorCode::kInvalidRequest, "invalid keyboard layout UTF-16 length"};
    std::u16string text;
    for (int index = 0; index < length; ++index)
      text.push_back(static_cast<char16_t>(utf16[index]));
    layout.entries.emplace_back(entry[0].get<std::string>(), std::move(text));
  }
  const auto valid = ValidateInput(layout);
  if (!valid)
    return valid.error();
  return layout;
}

inline Result<void> ValidateInputFidelity(const Json& event) {
  if (!event.is_object())
    return Error{ErrorCode::kInvalidRequest, "invalid input event"};
  const auto type = event.value("type", Json());
  if (type == "key" || type == "mouse" || type == "wheel") {
    const auto modifiers = event.find("modifiers");
    if (modifiers != event.end() &&
        (!InputNumber(*modifiers, 0, UINT32_MAX) ||
         std::floor(modifiers->get<double>()) != modifiers->get<double>() ||
         (modifiers->get<uint32_t>() & ~kInputModifiers)))
      return Error{ErrorCode::kInvalidRequest, "invalid input modifiers"};
  }
  if (type == "mouse" && event.contains("pen")) {
    const auto pen = ParsePen(event["pen"]);
    if (!pen)
      return pen.error();
  }
  if (type == "touch") {
    const auto points_valid = [](const Json& points) {
      if (!points.is_array())
        return false;
      for (const auto& point : points) {
        if (!point.is_object())
          return false;
        for (const auto* field : {"width", "height"})
          if (point.contains(field) && !InputNumber(point[field], 0, 1000))
            return false;
      }
      return true;
    };
    if (event.contains("points") && !points_valid(event["points"]))
      return Error{ErrorCode::kInvalidRequest, "invalid touch contact size"};
    if (event.contains("samples")) {
      if (!event["samples"].is_array())
        return Error{ErrorCode::kInvalidRequest, "invalid touch samples"};
      for (const auto& sample : event["samples"])
        if (!sample.is_object() || !sample.contains("points") || !points_valid(sample["points"]))
          return Error{ErrorCode::kInvalidRequest, "invalid sampled touch contact size"};
    }
  }
  return {};
}
}  // namespace remotekit
