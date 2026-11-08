#ifndef REMOTEKIT_BROWSER_CHROME_PARITY_H_
#define REMOTEKIT_BROWSER_CHROME_PARITY_H_

#include <string>

namespace blink {
struct RendererPreferences;
namespace web_pref {
struct WebPreferences;
}  // namespace web_pref
}  // namespace blink

namespace remotekit::browser {

inline constexpr char kChromeLocale[] = "zh-CN";
inline constexpr char kChromeLanguages[] = "zh-CN,zh,en-US,en";
inline constexpr char kTabletNavigatorPlatform[] = "Linux armv81";

std::string ChromeAcceptLanguage();
void ApplyChromeRendererPreferences(blink::RendererPreferences& prefs);
void ApplyChromeWebPreferences(blink::web_pref::WebPreferences& prefs);

}  // namespace remotekit::browser
#endif  // REMOTEKIT_BROWSER_CHROME_PARITY_H_
