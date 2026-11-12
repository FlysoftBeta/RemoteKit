#include <winsock2.h>
#include <ws2tcpip.h>
#include <winhttp.h>
#include <regex>
#include <set>
#include <charconv>
#include "session/site_preferences.hpp"
namespace remotekit {
namespace {
bool SiteOrigin(const std::string& origin) {
  if (origin.size() > 2048)
    return false;
  static const std::regex pattern(
      R"(^https?://(\[[0-9a-f:]+\]|[a-z0-9.!$&'()*+,;=_~-]+)(:([0-9]+))?$)");
  std::smatch match;
  if (!std::regex_match(origin, match, pattern))
    return false;
  if (match[3].matched) {
    const auto text = match[3].str();
    unsigned port = 0;
    const auto result = std::from_chars(text.data(), text.data() + text.size(), port);
    if (result.ec != std::errc{} || port > 65535 || std::to_string(port) != text ||
        port == (origin.starts_with("https:") ? 443u : 80u))
      return false;
  }
  const auto host = match[1].str();
  if (host.starts_with('[')) {
    IN6_ADDR address{};
    const auto inner = host.substr(1, host.size() - 2);
    if (InetPtonA(AF_INET6, inner.c_str(), &address) != 1)
      return false;
    char canonical[INET6_ADDRSTRLEN]{};
    if (!InetNtopA(AF_INET6, &address, canonical, sizeof(canonical)) || inner != canonical)
      return false;
  } else {
    // Numeric hosts must already be serialized as dotted decimal IPv4.
    const auto last =
        host.substr(host.find_last_of('.') == std::string::npos ? 0 : host.find_last_of('.') + 1);
    if (!last.empty() &&
        (std::all_of(last.begin(), last.end(), [](char c) { return c >= '0' && c <= '9'; }) ||
         last.starts_with("0x"))) {
      IN_ADDR address{};
      if (InetPtonA(AF_INET, host.c_str(), &address) != 1)
        return false;
      char canonical[INET_ADDRSTRLEN]{};
      if (!InetNtopA(AF_INET, &address, canonical, sizeof(canonical)) || host != canonical)
        return false;
    }
  }
  return true;
}
bool HandlerProtocol(const std::string& protocol) {
  static const std::set<std::string> safe = {
      "bitcoin", "cabal", "dat",  "did",  "dweb",        "ethereum", "ftp",    "ftps",
      "geo",     "im",    "ipfs", "ipns", "irc",         "ircs",     "magnet", "mailto",
      "matrix",  "mms",   "news", "nntp", "openpgp4fpr", "sftp",     "sip",    "sms",
      "smsto",   "ssb",   "ssh",  "tel",  "urn",         "webcal",   "wtai",   "xmpp"};
  return safe.contains(protocol) || (protocol.starts_with("web+") && protocol.size() > 4 &&
                                     std::all_of(protocol.begin() + 4, protocol.end(),
                                                 [](char c) { return c >= 'a' && c <= 'z'; }));
}
bool HandlerUrl(const std::string& origin, const std::string& url) {
  if (url.size() > 2048 || url.find("%s") == std::string::npos ||
      url.find("://") == std::string::npos ||
      std::any_of(url.begin(), url.end(),
                  [](unsigned char c) { return c <= 32 || c == 127 || c == '\\'; }))
    return false;
  if (!origin.starts_with("https://") && origin != "http://localhost" &&
      !origin.starts_with("http://localhost:") && origin != "http://127.0.0.1" &&
      !origin.starts_with("http://127.0.0.1:"))
    return false;
  const auto wide = Utf8Path(url).wstring();
  URL_COMPONENTS parts{};
  parts.dwStructSize = sizeof(parts);
  parts.dwHostNameLength = static_cast<DWORD>(-1);
  if (!WinHttpCrackUrl(wide.c_str(), static_cast<DWORD>(wide.size()), 0, &parts) ||
      (parts.nScheme != INTERNET_SCHEME_HTTP && parts.nScheme != INTERNET_SCHEME_HTTPS) ||
      !parts.dwHostNameLength)
    return false;
  std::string host = Utf8(fs::path(std::wstring(parts.lpszHostName, parts.dwHostNameLength)));
  std::transform(host.begin(), host.end(), host.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  if (host.find(':') != std::string::npos && !host.starts_with('['))
    host = "[" + host + "]";
  const bool secure = parts.nScheme == INTERNET_SCHEME_HTTPS;
  auto parsed_origin = std::string(secure ? "https://" : "http://") + host;
  if (parts.nPort != (secure ? 443 : 80))
    parsed_origin += ":" + std::to_string(parts.nPort);
  return parsed_origin == origin;
}
bool SiteEntry(const std::string& origin, const Json& value) {
  if (!SiteOrigin(origin) || !value.is_object() || value.empty())
    return false;
  static const std::set<std::string> permissions = {"geolocation", "clipboard_read",
                                                    "local_fonts", "window_management",
                                                    "midi_sysex",  "idle_detection"};
  for (const auto& [key, field] : value.items()) {
    if (key == "tabletUa") {
      if (field != Json(true))
        return false;
    } else if (key == "permissions") {
      if (!field.is_object() || field.empty())
        return false;
      for (const auto& [permission, setting] : field.items())
        if (!permissions.contains(permission) || (setting != "allow" && setting != "block"))
          return false;
    } else if (key == "protocolHandlers") {
      if (!field.is_array() || field.empty() || field.size() > 32)
        return false;
      for (const auto& handler : field) {
        if (!handler.is_object() || handler.size() != 3 || !handler.contains("protocol") ||
            !handler["protocol"].is_string() || !handler.contains("url") ||
            !handler["url"].is_string() || !handler.contains("allowed") ||
            !handler["allowed"].is_boolean() ||
            !HandlerProtocol(handler["protocol"].get<std::string>()) ||
            !HandlerUrl(origin, handler["url"].get<std::string>()))
          return false;
      }
    } else {
      return false;
    }
  }
  return true;
}
}  // namespace
Result<void> ValidateSitePreferences(const Json& value) {
  if (!value.is_object() || value.size() != 1 || !value.contains("sites") ||
      !value["sites"].is_object() || value["sites"].size() > 4096)
    return Error{ErrorCode::kInvalidRequest, "invalid site preferences"};
  for (const auto& [origin, site] : value["sites"].items())
    if (!SiteEntry(origin, site))
      return Error{ErrorCode::kInvalidRequest, "invalid site preference"};
  return {};
}
}  // namespace remotekit