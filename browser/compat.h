#ifndef REMOTEKIT_BROWSER_COMPAT_H_
#define REMOTEKIT_BROWSER_COMPAT_H_

#include <memory>
#include <string>

#include "third_party/blink/public/common/user_agent/user_agent_metadata.h"

namespace content {
class ClientHintsControllerDelegate;
}

namespace remotekit::browser {

std::string ChromeUserAgent();
blink::UserAgentMetadata ChromeUserAgentMetadata();
// The caller owns one delegate per BrowserContext.
std::unique_ptr<content::ClientHintsControllerDelegate> CreateClientHintsDelegate();

}  // namespace remotekit::browser
#endif  // REMOTEKIT_BROWSER_COMPAT_H_
