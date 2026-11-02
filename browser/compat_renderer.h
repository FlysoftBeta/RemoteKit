#ifndef REMOTEKIT_BROWSER_COMPAT_RENDERER_H_
#define REMOTEKIT_BROWSER_COMPAT_RENDERER_H_

#include "content/public/renderer/content_renderer_client.h"

namespace remotekit::browser {
class CompatRendererClient : public content::ContentRendererClient {
 public:
  void WebViewCreated(blink::WebView*, bool, const url::Origin*) override;
  void RenderFrameCreated(content::RenderFrame* render_frame) override;
  void PrepareErrorPage(
      content::RenderFrame* render_frame,
      const blink::WebURLError& error,
      const std::string& http_method,
      content::mojom::AlternativeErrorPageOverrideInfoPtr alternative_error_page_info,
      std::string* error_html) override;
};
}  // namespace remotekit::browser
#endif  // REMOTEKIT_BROWSER_COMPAT_RENDERER_H_
