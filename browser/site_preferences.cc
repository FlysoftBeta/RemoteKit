#include "browser/site_preferences.h"

#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "url/origin.h"

namespace remotekit::browser {
bool ValidSitePermission(std::string_view name) {
  return name == "geolocation" || name == "clipboard_read" || name == "local_fonts" ||
         name == "window_management" || name == "midi_sysex" || name == "idle_detection";
}
bool ValidProtocolHandler(std::string_view origin,
                          std::string_view protocol,
                          std::string_view value) {
  for (const unsigned char character : value)
    if (character <= 32 || character == 127 || character == '\\')
      return false;
  const auto safelist = base::SplitStringPiece(
      "bitcoin cabal dat did dweb ethereum ftp ftps geo im ipfs ipns irc ircs magnet mailto matrix "
      "mms news nntp openpgp4fpr sftp sip sms smsto ssb ssh tel urn webcal wtai xmpp",
      " ", base::TRIM_WHITESPACE, base::SPLIT_WANT_NONEMPTY);
  bool valid = false;
  for (const auto name : safelist)
    valid |= protocol == name;
  if (protocol.starts_with("web+") && protocol.size() > 4)
    valid |= protocol.substr(4).find_first_not_of("abcdefghijklmnopqrstuvwxyz") ==
             std::string_view::npos;
  const GURL url(value);
  return valid && value.size() <= 2048 && value.find("%s") != std::string_view::npos &&
         url.is_valid() && url::Origin::Create(url).Serialize() == origin &&
         (url.SchemeIs("https") ||
          (url.SchemeIs("http") && (url.host() == "localhost" || url.host() == "127.0.0.1")));
}
bool ValidSitePreferences(const base::DictValue& sites) {
  if (sites.size() > 4096)
    return false;
  for (const auto [origin, value] : sites) {
    const GURL url(origin);
    if (origin.size() > 2048 || !url.is_valid() || !url.SchemeIsHTTPOrHTTPS() ||
        url::Origin::Create(url).Serialize() != origin || !value.is_dict() ||
        value.GetDict().empty())
      return false;
    for (const auto [key, field] : value.GetDict()) {
      if (key == "tabletUa") {
        if (!field.is_bool() || !field.GetBool())
          return false;
      } else if (key == "permissions") {
        if (!field.is_dict() || field.GetDict().empty())
          return false;
        for (const auto [name, setting] : field.GetDict())
          if (!ValidSitePermission(name) || !setting.is_string() ||
              (setting.GetString() != "allow" && setting.GetString() != "block"))
            return false;
      } else if (key == "protocolHandlers") {
        if (!field.is_list() || field.GetList().empty() || field.GetList().size() > 32)
          return false;
        for (const auto& handler : field.GetList()) {
          const auto* item = handler.GetIfDict();
          const auto* protocol = item ? item->FindString("protocol") : nullptr;
          const auto* target = item ? item->FindString("url") : nullptr;
          if (!item || item->size() != 3 || !protocol || !target ||
              !item->FindBool("allowed").has_value() ||
              !ValidProtocolHandler(origin, *protocol, *target))
            return false;
        }
      } else {
        return false;
      }
    }
  }
  return true;
}
}  // namespace remotekit::browser
