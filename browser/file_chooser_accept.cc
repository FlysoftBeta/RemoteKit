#include "remotekit/browser/file_chooser_accept.h"

#include <string_view>
#include <utility>

#include "base/json/json_writer.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "net/base/mime_util.h"

namespace remotekit::browser {
namespace {
bool UsableHint(std::string_view type) {
  if (type.empty() || !base::IsStringUTF8(type))
    return false;
  if (type.front() != '.')
    return net::ParseMimeTypeWithoutParameter(type, nullptr, nullptr);
  if (type.size() < 2)
    return false;
  for (const unsigned char c : type)
    if (c <= 32 || c == 127 || c == ',' || c == '/' || c == '\\')
      return false;
  return true;
}
}  // namespace
FileChooserAcceptHints ExportFileChooserAcceptHints(const std::vector<std::u16string>& types) {
  FileChooserAcceptHints result;
  for (const auto& type : types) {
    if (result.types.size() == 64) {
      result.omitted = true;
      break;
    }
    // UTF-16 length is a cheap prefilter; the actual bound is UTF-8 bytes.
    if (type.size() > 256) {
      result.omitted = true;
      continue;
    }
    std::string utf8;
    if (!base::UTF16ToUTF8(type.data(), type.size(), &utf8) || utf8.size() > 256 ||
        !UsableHint(utf8)) {
      result.omitted = true;
      continue;
    }
    auto candidate = result.types.Clone();
    candidate.Append(utf8);
    const auto encoded = base::WriteJson(candidate);
    if (!encoded || encoded->size() > 16 * 1024) {
      result.omitted = true;
      continue;
    }
    result.types = std::move(candidate);
  }
  return result;
}
}  // namespace remotekit::browser
