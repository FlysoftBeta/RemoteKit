#ifndef REMOTEKIT_BROWSER_COMPAT_H_
#define REMOTEKIT_BROWSER_COMPAT_H_

#include <memory>
#include <map>
#include <optional>
#include <vector>
#include "base/values.h"
#include "services/network/public/mojom/web_client_hints_types.mojom-shared.h"
#include "url/origin.h"
#include "url/gurl.h"
#include <string>
#include "base/files/file_path.h"

#include "third_party/blink/public/common/user_agent/user_agent_metadata.h"

namespace content {
class ClientHintsControllerDelegate;
}

namespace remotekit::browser {

using ClientHints = std::map<url::Origin, std::vector<network::mojom::WebClientHintsType>>;
inline std::optional<ClientHints> ParseClientHints(const base::DictValue& data) {
  ClientHints parsed;
  for (const auto [key, value] : data) {
    const auto origin = url::Origin::Create(GURL(key));
    if (origin.opaque() || origin.Serialize() != key || !value.is_list())
      return std::nullopt;
    auto& hints = parsed[origin];
    for (const auto& item : value.GetList()) {
      if (!item.is_int() || !network::mojom::IsKnownEnumValue(
                                static_cast<network::mojom::WebClientHintsType>(item.GetInt())))
        return std::nullopt;
      hints.push_back(static_cast<network::mojom::WebClientHintsType>(item.GetInt()));
    }
  }
  return parsed;
}
std::string ChromeUserAgent();
blink::UserAgentOverride ChromeUserAgentOverride(bool tablet);
blink::UserAgentMetadata ChromeUserAgentMetadata();
// The caller owns one delegate per BrowserContext.
std::unique_ptr<content::ClientHintsControllerDelegate> CreateClientHintsDelegate(
    const base::FilePath& profile);

}  // namespace remotekit::browser
#endif  // REMOTEKIT_BROWSER_COMPAT_H_
