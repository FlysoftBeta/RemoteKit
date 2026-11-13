#pragma once

#include "session/view_configuration.hpp"
#include "session/site_preferences.hpp"
#include "util/result_macros.hpp"
#include <set>
#include "protocol/limits.hpp"

namespace remotekit::coordination {
inline constexpr size_t kMaxSessions = limits::sessions;
inline constexpr size_t kMaxViews = limits::views;
inline constexpr size_t kMaxResults = limits::results;
inline constexpr size_t kMaxEvents = limits::events;
inline constexpr size_t kMaxEventBytes = limits::eventBacklogBytes;
inline constexpr size_t kMaxDocumentBytes = limits::documentBytes;

inline bool Counter(const Json& value, bool positive = false) {
  if (!value.is_string())
    return false;
  const auto& text = value.get_ref<const std::string&>();
  uint64_t result = 0;
  const auto parsed = std::from_chars(text.data(), text.data() + text.size(), result);
  return parsed.ec == std::errc{} && parsed.ptr == text.data() + text.size() &&
         std::to_string(result) == text && (!positive || result != 0);
}
inline bool Hex(const Json& value, size_t size) {
  if (!value.is_string())
    return false;
  const auto& text = value.get_ref<const std::string&>();
  return text.size() == size && std::all_of(text.begin(), text.end(), [](char c) {
           return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
         });
}
inline bool Epoch(const Json& value, bool zero = false) {
  return value.is_number_integer() && value >= (zero ? 0 : 1) && value <= 9007199254740991ULL;
}
inline bool Keys(const Json& value,
                 std::initializer_list<const char*> required,
                 std::initializer_list<const char*> optional = {}) {
  if (!value.is_object())
    return false;
  std::set<std::string> allowed;
  for (const auto* name : required) {
    if (!value.contains(name))
      return false;
    allowed.insert(name);
  }
  for (const auto* name : optional)
    allowed.insert(name);
  for (const auto& [name, item] : value.items())
    if (!allowed.contains(name))
      return false;
  return true;
}
inline Result<void> ValidateTarget(const Json& value) {
  if (!value.contains("tenantId") || !value["tenantId"].is_string() ||
      value["tenantId"].get_ref<const std::string&>().empty() ||
      !Hex(value.value("sessionId", Json()), 32) || !Epoch(value.value("placementEpoch", Json())))
    return Error{ErrorCode::kInvalidRequest, "invalid Session target"};
  return {};
}
inline Result<void> ValidateNodeDesired(const Json& value) {
  if (!Keys(value, {"method", "connectionEpoch", "revision", "sessions"}, {"id"}) ||
      value["method"] != "node.desired" || !value["connectionEpoch"].is_string() ||
      !Counter(value["revision"], true) || !value["sessions"].is_array() ||
      value["sessions"].size() > kMaxSessions)
    return Error{ErrorCode::kInvalidRequest, "invalid node.desired"};
  std::set<std::string> tenants, sessions;
  for (const auto& session : value["sessions"]) {
    RK_RETURN_IF_ERROR(ValidateTarget(session));
    if (!Keys(session, {"tenantId", "sessionId", "placementEpoch", "dataState"}) ||
        (session["dataState"] != "clean" && session["dataState"] != "dirty") ||
        !tenants.insert(session["tenantId"].get<std::string>()).second ||
        !sessions.insert(session["sessionId"].get<std::string>()).second)
      return Error{ErrorCode::kInvalidRequest, "invalid fencing list"};
  }
  return {};
}
inline size_t WireNumberBytes(double number) {
  // Control serializes numbers with JSON.stringify, including its exponent thresholds.
  if (number == 0)
    return 1;
  char buffer[64];
  const auto encoded = std::to_chars(buffer, buffer + sizeof(buffer), number);
  const std::string text(buffer, encoded.ptr);
  const auto exponent_at = text.find('e');
  const auto mantissa = text.substr(0, exponent_at);
  const int exponent =
      exponent_at == std::string::npos ? 0 : std::stoi(text.substr(exponent_at + 1));
  const bool negative = number < 0;
  const auto decimal_at = mantissa.find('.');
  const int decimal_position =
      static_cast<int>(decimal_at == std::string::npos ? mantissa.size() : decimal_at) - negative;
  const int digits =
      static_cast<int>(mantissa.size()) - negative - (decimal_at != std::string::npos);
  const int position = decimal_position + exponent;
  if (position > 0 && position <= 21)
    return negative + std::max(digits, position) + (position < digits);
  if (position <= 0 && position > -6)
    return negative + 2 - position + digits;
  const int scientific_exponent = position - 1;
  return negative + digits + (digits > 1) + 2 +
         std::to_string(std::abs(scientific_exponent)).size();
}
inline std::ptrdiff_t WireNumberAdjustment(const Json& value) {
  std::ptrdiff_t bytes = 0;
  if (value.is_number_float())
    return static_cast<std::ptrdiff_t>(WireNumberBytes(value.get<double>())) -
           static_cast<std::ptrdiff_t>(value.dump().size());
  if (value.is_structured())
    for (const auto& child : value)
      bytes += WireNumberAdjustment(child);
  return bytes;
}
inline size_t DocumentBytes(Json value) {
  value.erase("id");
  value.erase("opId");
  return value.dump().size() + WireNumberAdjustment(value);
}
inline Result<void> ValidateClipboard(const Json& value) {
  if (!Keys(value,
            {"method", "tenantId", "sessionId", "placementEpoch", "connectionEpoch", "revision",
             "value"},
            {"id"}) ||
      value["method"] != "session.clipboard" || !value["connectionEpoch"].is_string() ||
      value["connectionEpoch"].get_ref<const std::string&>().empty() ||
      value["connectionEpoch"].get_ref<const std::string&>().size() > limits::identityBytes ||
      !Counter(value["revision"]) || !Keys(value["value"], {"text", "html"}) ||
      !value["value"]["text"].is_string() || !value["value"]["html"].is_string() ||
      value["value"]["text"].get_ref<const std::string&>().size() > limits::textBytes ||
      value["value"]["html"].get_ref<const std::string&>().size() > limits::htmlBytes ||
      (value["revision"] == "0" && (value["value"]["text"] != "" || value["value"]["html"] != "")))
    return Error{ErrorCode::kInvalidRequest, "invalid session.clipboard"};
  RK_RETURN_IF_ERROR(ValidateTarget(value));
  if (value["tenantId"].get_ref<const std::string&>().size() > limits::identityBytes)
    return Error{ErrorCode::kInvalidRequest, "invalid clipboard tenant"};
  if (DocumentBytes(value) + limits::managementEnvelopeBytes > limits::documentBytes)
    return Error{ErrorCode::kLimitExceeded, "clipboard document exceeds bound"};
  return {};
}
inline Result<void> ValidateDesired(const Json& value) {
  if (!Keys(value,
            {"method", "connectionEpoch", "tenantId", "sessionId", "placementEpoch", "revision",
             "run", "commit", "profileKey", "checkpoint", "sitePreferences", "mediaPolicy",
             "quality", "clipboard", "views", "authorization", "lock"},
            {"id"}) ||
      value["method"] != "session.desired" || !value["connectionEpoch"].is_string() ||
      !Counter(value["revision"], true))
    return Error{ErrorCode::kInvalidRequest, "invalid session.desired"};
  RK_RETURN_IF_ERROR(ValidateTarget(value));
  const auto& commit = value["commit"];
  if ((value["run"] != "running" && value["run"] != "stopped") ||
      (!commit.is_null() && (!commit.is_string() || commit.get_ref<const std::string&>().empty() ||
                             commit.get_ref<const std::string&>().size() > limits::identityBytes ||
                             value["run"] == "running")) ||
      !value["profileKey"].is_string() ||
      (!value["checkpoint"].is_null() && !Hex(value["checkpoint"], 64)))
    return Error{ErrorCode::kInvalidRequest, "invalid desired run or checkpoint"};
  const auto& clipboard = value["clipboard"];
  if (!Keys(clipboard, {"revision"}) || !Counter(clipboard["revision"]))
    return Error{ErrorCode::kInvalidRequest, "invalid desired clipboard"};
  if (!Keys(value["quality"], {"effectiveDpr"}) || !value["quality"]["effectiveDpr"].is_number() ||
      !std::isfinite(value["quality"]["effectiveDpr"].get<double>()) ||
      value["quality"]["effectiveDpr"] <= 0 || !value["views"].is_array() ||
      value["views"].size() > kMaxViews)
    return Error{ErrorCode::kInvalidRequest, "invalid desired quality or views"};
  std::set<std::string> views;
  for (const auto& view : value["views"]) {
    if (!Keys(view,
              {"viewId", "presence", "url", "width", "height", "visible", "device",
               "occludedBottom", "occlusionRevision"},
              {"signIn", "adopt"}) ||
        !Counter(view["viewId"], true) || !views.insert(view["viewId"].get<std::string>()).second ||
        (view["presence"] != "ensure" && view["presence"] != "ifPresent") ||
        !view["url"].is_string() || !view["visible"].is_boolean() ||
        !Counter(view["occlusionRevision"]) ||
        !Keys(view["device"], {"mode", "deviceScaleFactor"}) ||
        view["device"]["mode"] != "desktop" ||
        view["device"]["deviceScaleFactor"] != value["quality"]["effectiveDpr"] ||
        (view.contains("signIn") && view.contains("adopt")))
      return Error{ErrorCode::kInvalidRequest, "invalid desired view"};
    RK_RETURN_IF_ERROR(ValidateViewConfiguration(view));
    if (view["occludedBottom"] > view["height"])
      return Error{ErrorCode::kInvalidRequest, "invalid desired view occlusion"};
    if (view.contains("adopt") && (!Keys(view["adopt"], {"browserIncarnation", "provisionalId"}) ||
                                   !view["adopt"]["browserIncarnation"].is_string() ||
                                   !view["adopt"]["provisionalId"].is_string()))
      return Error{ErrorCode::kInvalidRequest, "invalid desired adoption"};
  }
  const auto& media = value["mediaPolicy"];
  if (!Keys(media, {"audio", "maxFps", "degradationPreference"}) || !media["audio"].is_boolean() ||
      !media["maxFps"].is_number_integer() || media["maxFps"] < 1 ||
      media["maxFps"] > limits::maxFps ||
      (media["degradationPreference"] != "maintain-resolution" &&
       media["degradationPreference"] != "balanced" &&
       media["degradationPreference"] != "maintain-framerate"))
    return Error{ErrorCode::kInvalidRequest, "invalid desired media policy"};
  const auto& auth = value["authorization"];
  const auto& lock = value["lock"];
  if (!Keys(auth, {"connectionId", "epoch", "unlocked", "files"}) ||
      (!auth["connectionId"].is_null() && !auth["connectionId"].is_string()) ||
      !Epoch(auth["epoch"], auth["connectionId"].is_null()) || !auth["unlocked"].is_boolean() ||
      (auth["connectionId"].is_null() && (auth["epoch"] != 0 || auth["unlocked"] != false)) ||
      !Keys(auth["files"], {"requests"}) || !auth["files"]["requests"].is_array() ||
      auth["files"]["requests"].size() > limits::fileRequests ||
      !Keys(lock, {"leaseId", "epoch", "state"}) || !Epoch(lock["epoch"], true) ||
      (!lock["leaseId"].is_null() && !lock["leaseId"].is_string()) ||
      (lock["state"] != "locked" && lock["state"] != "unlocking" && lock["state"] != "unlocked"))
    return Error{ErrorCode::kInvalidRequest, "invalid desired authorization"};
  if (!Keys(value["sitePreferences"], {"sites"}) ||
      !value["sitePreferences"]["sites"].is_object() ||
      value["sitePreferences"]["sites"].size() > limits::sites)
    return Error{ErrorCode::kInvalidRequest, "invalid desired policy"};
  RK_RETURN_IF_ERROR(ValidateSitePreferences(value["sitePreferences"]));
  std::set<std::string> requests;
  for (const auto& item : auth["files"]["requests"]) {
    if (!Keys(item, {"id", "binding"}) || !item["id"].is_string() ||
        item["id"].get_ref<const std::string&>().empty() ||
        item["id"].get_ref<const std::string&>().size() > limits::identityBytes ||
        !requests.insert(item["id"].get<std::string>()).second || item["id"] == "library" ||
        !Keys(item["binding"], {"browserIncarnation", "view", "instance", "document", "request"}))
      return Error{ErrorCode::kInvalidRequest, "invalid desired file grant"};
    const auto& binding = item["binding"];
    if (!binding["browserIncarnation"].is_string() ||
        binding["browserIncarnation"].get_ref<const std::string&>().empty() ||
        binding["browserIncarnation"].get_ref<const std::string&>().size() > limits::identityBytes)
      return Error{ErrorCode::kInvalidRequest, "invalid desired file Browser"};
    for (const auto* field : {"view", "instance", "document", "request"})
      if (!Counter(binding[field], true))
        return Error{ErrorCode::kInvalidRequest, "invalid desired file binding"};
  }
  if (DocumentBytes(value) + limits::managementEnvelopeBytes > limits::configurationBytes)
    return Error{ErrorCode::kLimitExceeded, "desired document exceeds bound"};
  return {};
}
}  // namespace remotekit::coordination
