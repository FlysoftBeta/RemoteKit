#pragma once

#include <cstddef>
#include <cstdint>

#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/values.h"

namespace remotekit::browser {
inline constexpr size_t kControlJsonLimit = 1024 * 1024;
// A UTF-8 byte can expand to six bytes (\u00XX), plus the RPC envelope.
inline constexpr size_t kClipboardJsonLimit = 6 * (1024 * 1024 + 2 * 1024 * 1024) + 64 * 1024;

inline size_t ControlRequestJsonLimit(const base::DictValue& request) {
  const auto* method = request.FindString("method");
  return method && *method == "clipboard.write" ? kClipboardJsonLimit : kControlJsonLimit;
}
inline size_t ControlResponseJsonLimit(const base::DictValue& request) {
  const auto* method = request.FindString("method");
  return method && *method == "clipboard.read" ? kClipboardJsonLimit : kControlJsonLimit;
}

inline bool ValidClipboardWrite(const base::DictValue& request) {
  const auto* revision = request.FindString("revision");
  const auto* text = request.FindString("text");
  const auto* html = request.FindString("html");
  uint64_t value = 0;
  return revision && base::StringToUint64(*revision, &value) &&
         base::NumberToString(value) == *revision && text && html && base::IsStringUTF8(*text) &&
         base::IsStringUTF8(*html);
}
}  // namespace remotekit::browser
