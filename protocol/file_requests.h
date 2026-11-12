#pragma once
#include <algorithm>
#include <string>

namespace remotekit::protocol {
template <class Json>
bool ValidDocumentOpenParams(const Json& params) {
  if (!params.is_object() || params.size() != 3 || !params.contains("requestId") ||
      params.at("requestId") != "library" || !params.contains("assetId") ||
      !params.at("assetId").is_string() || !params.contains("type") ||
      !params.at("type").is_string())
    return false;
  const auto& id = params.at("assetId").template get_ref<const std::string&>();
  const auto& type = params.at("type").template get_ref<const std::string&>();
  return id.size() == 64 && id.find_first_not_of("0123456789abcdef") == std::string::npos &&
         type.size() <= 255 && std::all_of(type.begin(), type.end(), [](unsigned char character) {
           return character >= 0x20 && character <= 0x7e;
         });
}
}  // namespace remotekit::protocol
