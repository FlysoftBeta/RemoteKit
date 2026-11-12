#pragma once
#include "persistence/strict_json.hpp"
#include "cluster/node_files.hpp"
#include <charconv>
#include <set>

namespace remotekit::session_documents {
inline uint64_t Counter(const Json& value, bool positive = false) {
  const auto& text = persisted::Text(value, 1, 20);
  uint64_t result = 0;
  const auto parsed = std::from_chars(text.data(), text.data() + text.size(), result);
  persisted::Require(parsed.ec == std::errc{} && parsed.ptr == text.data() + text.size() &&
                         std::to_string(result) == text && (!positive || result),
                     "invalid decimal counter");
  return result;
}
inline void WireError(const Json& value) {
  using namespace persisted;
  Keys(value, {"code", "message"}, {"reason", "errorId", "retryAfterMs"});
  const auto code = ParseErrorCode(Text(value.at("code")));
  Require(code.has_value(), "unknown error code");
  Text(value.at("message"), 0, 1024 * 1024);
  if (value.contains("reason"))
    Require(ParseErrorReason(Text(value.at("reason"))).has_value(), "unknown error reason");
  if (value.contains("errorId"))
    Require(ValidErrorId(Text(value.at("errorId"))), "invalid error ID");
  if (value.contains("retryAfterMs")) {
    Require(SupportsRetryHint(*code), "error code does not support retry hint");
    Unsigned(value.at("retryAfterMs"), 0, 86400000);
  }
}
inline void View(const Json& value) {
  using namespace persisted;
  Keys(value,
       {"viewId", "presence", "url", "width", "height", "visible", "device", "occludedBottom",
        "occlusionRevision"},
       {"signIn", "adopt"});
  Counter(value.at("viewId"), true);
  Enum(value.at("presence"), {"ensure", "ifPresent"});
  Text(value.at("url"), 0, 32768);
  Unsigned(value.at("width"), 1, 8192);
  const auto height = Unsigned(value.at("height"), 1, 8192);
  Boolean(value.at("visible"));
  Unsigned(value.at("occludedBottom"), 0, height);
  Counter(value.at("occlusionRevision"));
  const auto& device = value.at("device");
  Keys(device, {"mode", "deviceScaleFactor"});
  Enum(device.at("mode"), {"desktop"});
  Number(device.at("deviceScaleFactor"), 0.01, 16);
  if (value.contains("signIn"))
    Enum(value.at("signIn"), {"changyan", "xinjiaoyu"});
  if (value.contains("adopt")) {
    Require(!value.contains("signIn"), "sign-in view cannot adopt");
    Keys(value.at("adopt"), {"browserIncarnation", "provisionalId"});
    Text(value.at("adopt").at("browserIncarnation"), 1, 128);
    Text(value.at("adopt").at("provisionalId"), 1, 128);
  }
}
inline void EventBody(const std::string& type, const Json& body) {
  using namespace persisted;
  if (type == "view.closed") {
    Keys(body, {"viewId", "reason"});
    Counter(body.at("viewId"), true);
    Text(body.at("reason"), 1, 128);
  } else if (type == "download.imported" || type == "download.failed") {
    if (type == "download.imported") {
      Keys(body, {"name", "origin", "assetId", "mimeType", "size"});
      const auto& id = Text(body.at("assetId"));
      Require(id.size() == 64 && id.find_first_not_of("0123456789abcdef") == std::string::npos,
              "invalid downloaded asset ID");
      Text(body.at("mimeType"), 0, 255);
      Counter(body.at("size"));
    } else {
      Keys(body, {"name", "origin", "error"});
      WireError(body.at("error"));
    }
    Text(body.at("name"), 0, 4096);
    Text(body.at("origin"), 0, 2048);
  } else if (type == "clipboard.changed") {
    if (body.contains("oversize")) {
      Keys(body,
           {"baseRevision", "browserSequence", "excludeFromHistory", "oversize", "textBytes",
            "htmlBytes"},
           {"viewId"});
      Require(Boolean(body.at("oversize")), "invalid oversize marker");
      Unsigned(body.at("textBytes"));
      Unsigned(body.at("htmlBytes"));
    } else {
      Keys(body, {"baseRevision", "browserSequence", "excludeFromHistory", "text", "html"},
           {"viewId"});
      Text(body.at("text"), 0, 1024 * 1024);
      Text(body.at("html"), 0, 2 * 1024 * 1024);
    }
    Counter(body.at("baseRevision"));
    Counter(body.at("browserSequence"));
    Boolean(body.at("excludeFromHistory"));
    if (body.contains("viewId"))
      Counter(body.at("viewId"), true);
  } else if (type == "view.signIn") {
    Keys(body, {"version", "webviewId", "provider", "result"});
    Version(body.at("version"), 1);
    Counter(body.at("webviewId"), true);
    Enum(body.at("provider"), {"changyan", "xinjiaoyu"});
    const auto& result = body.at("result");
    if (body.at("provider") == "changyan")
      Keys(result, {"lot_number", "captcha_output", "pass_token", "gen_time"});
    else
      Keys(result, {"authorization", "accesstoken", "clientsession"},
           {"device", "devicetype", "user-agent", "accept-language", "sec-ch-ua",
            "sec-ch-ua-mobile", "sec-ch-ua-platform"});
    for (const auto& item : result)
      Text(item, 0, 8192);
    Require(result.dump().size() <= 8192, "sign-in result exceeds bound");
  } else
    Require(false, "unknown persisted event type");
}
inline void Event(const std::string& type, const Json& value) {
  persisted::Keys(value, {"body", "browserIncarnation"});
  if (!value.at("browserIncarnation").is_null())
    persisted::Text(value.at("browserIncarnation"), 0, 128);
  EventBody(type, value.at("body"));
}
inline void DownloadResult(const Json& value, const Json& event_id) {
  using namespace persisted;
  Require(value.is_object(), "expected download result object");
  const auto type = Text(value.at("type"));
  Require(type == "download.imported" || type == "download.failed", "invalid download result type");
  Require(value.at("eventId") == event_id, "download result identity mismatch");
  auto body = value;
  body.erase("eventId");
  body.erase("type");
  EventBody(type, body);
}
inline void Downloads(const Json& state) {
  using namespace persisted;
  Keys(state, {"records"});
  Array(state.at("records"), 4096);
  std::set<std::string> ids;
  for (const auto& row : state.at("records")) {
    Keys(row, {"incarnation", "eventId", "download"}, {"result", "attempt", "retryAt", "error"});
    Text(row.at("incarnation"), 1, 128);
    Require(ids.insert(Text(row.at("eventId"), 1, 128)).second, "duplicate download import");
    const auto& download = row.at("download");
    Keys(download, {"guid", "eventId", "fileReference", "name", "mimeType", "size", "origin"},
         {"type"});
    if (download.contains("type"))
      Enum(download.at("type"), {"download.completed"});
    Text(download.at("guid"), 1, 128);
    Text(download.at("eventId"), 1, 128);
    Text(download.at("fileReference"), 1, 32768);
    Text(download.at("name"), 0, 4096);
    Text(download.at("mimeType"), 0, 255);
    Text(download.at("origin"), 0, 2048);
    Counter(download.at("size"));
    if (row.contains("result")) {
      DownloadResult(row.at("result"), row.at("eventId"));
    }
    if (row.contains("attempt"))
      Unsigned(row.at("attempt"), 0, UINT32_MAX);
    if (row.contains("retryAt"))
      Unsigned(row.at("retryAt"));
    if (row.contains("error"))
      WireError(row.at("error"));
  }
}
}  // namespace remotekit::session_documents
