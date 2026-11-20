#pragma once
#include <algorithm>
#include <string>
#include <string_view>

namespace remotekit::protocol {
inline const char* FileNotFoundDetail(std::string_view message) {
  if (message == "unknown_file_selection" || message == "unknown_file_upload" ||
      message == "unknown_asset_upload")
    return "selection_unknown";
  if (message == "entry_missing")
    return "entry_missing";
  return "asset_unreadable";
}

inline constexpr std::string_view kObjectDerivativeKinds[] = {"thumbnail", "preview", "photo",
                                                              "selection-transcode", "document"};
inline bool ValidObjectDerivativeKind(std::string_view kind) {
  return std::find(std::begin(kObjectDerivativeKinds), std::end(kObjectDerivativeKinds), kind) !=
         std::end(kObjectDerivativeKinds);
}

template <class Json>
bool ValidPhotoPreviewParams(const Json& params) {
  if (!params.is_object() || params.size() != 3 || !params.contains("requestId") ||
      params.at("requestId") != "library" || !params.contains("assetId") ||
      !params.at("assetId").is_string() || !params.contains("maxSide") ||
      !params.at("maxSide").is_number_integer())
    return false;
  const auto& id = params.at("assetId").template get_ref<const std::string&>();
  return id.size() == 64 && id.find_first_not_of("0123456789abcdef") == std::string::npos &&
         (params.at("maxSide") == 1280 || params.at("maxSide") == 2560);
}

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
