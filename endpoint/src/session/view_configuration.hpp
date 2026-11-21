#pragma once
#include "protocol/control.h"
#include "util/result_macros.hpp"
#include "protocol/limits.hpp"
#include <algorithm>
#include "session/signin.hpp"
#include <charconv>
#include <cmath>
namespace remotekit {
// `document` marks a PDF view: the URL is the internal viewer marker, and only then.
inline Result<void> ValidateDocument(const Json& config) {
  const bool viewer = config.contains("url") && config["url"].is_string() &&
                      config["url"].get_ref<const std::string&>() == protocol::kPdfViewerUrl;
  if (!config.contains("document")) {
    if (viewer)
      return Error{ErrorCode::kInvalidRequest, "viewer URL requires a document"};
    return {};
  }
  const auto& document = config["document"];
  if (!document.is_object() || document.size() != 2 || document.value("kind", Json()) != "pdf" ||
      !document.contains("assetId") || !document["assetId"].is_string())
    return Error{ErrorCode::kInvalidRequest, "invalid view document"};
  const auto& id = document["assetId"].get_ref<const std::string&>();
  if (id.size() != 64 || !std::all_of(id.begin(), id.end(), [](char c) {
        return (c >= 'a' && c <= 'f') || (c >= '0' && c <= '9');
      }))
    return Error{ErrorCode::kInvalidRequest, "invalid view document asset"};
  if (!viewer || config.contains("signIn") || config.contains("adopt") ||
      config.value("method", std::string()) == "view.adopt")
    return Error{ErrorCode::kInvalidRequest, "a document view must use only the viewer URL"};
  return {};
}
inline Result<void> ValidateViewConfiguration(const Json& config) {
  if (!config.is_object())
    return Error{ErrorCode::kInvalidRequest, "view configuration must be an object"};
  for (const auto* name : {"visible", "requireRunning"})
    if (config.contains(name) && !config[name].is_boolean())
      return Error{ErrorCode::kInvalidRequest, std::string("required boolean: ") + name};
  for (const auto* name : {"url", "method"})
    if (config.contains(name) && !config[name].is_string())
      return Error{ErrorCode::kInvalidRequest, std::string("required string: ") + name};
  for (const auto* name : {"width", "height", "occludedBottom"})
    if (config.contains(name) &&
        (!config[name].is_number_integer() ||
         config[name] < (std::string_view(name) == "occludedBottom" ? 0 : 1) ||
         config[name] > limits::viewDimension))
      return Error{ErrorCode::kInvalidRequest, std::string("invalid viewport ") + name};
  if (config.contains("occlusionRevision")) {
    if (!config["occlusionRevision"].is_string())
      return Error{ErrorCode::kInvalidRequest, "invalid occlusion revision"};
    const auto& text = config["occlusionRevision"].get_ref<const std::string&>();
    uint64_t revision = 0;
    const auto parsed = std::from_chars(text.data(), text.data() + text.size(), revision);
    if (parsed.ec != std::errc{} || parsed.ptr != text.data() + text.size())
      return Error{ErrorCode::kInvalidRequest, "invalid occlusion revision"};
  }
  if (config.contains("device")) {
    const auto& device = config["device"];
    if (!device.is_object())
      return Error{ErrorCode::kInvalidRequest, "device must be an object"};
    for (const auto* name : {"width", "height"})
      if (device.contains(name) && (!device[name].is_number_integer() || device[name] < 1 ||
                                    device[name] > limits::viewDimension))
        return Error{ErrorCode::kInvalidRequest, std::string("invalid device ") + name};
    if (device.contains("mode") && !device["mode"].is_string())
      return Error{ErrorCode::kInvalidRequest, "required string: device.mode"};
    if (device.contains("deviceScaleFactor") &&
        (!device["deviceScaleFactor"].is_number() ||
         !std::isfinite(device["deviceScaleFactor"].get<double>()) ||
         device["deviceScaleFactor"] <= 0))
      return Error{ErrorCode::kInvalidRequest, "invalid deviceScaleFactor"};
  }
  RK_RETURN_IF_ERROR(ValidateSignIn(config));
  return ValidateDocument(config);
}
}  // namespace remotekit
