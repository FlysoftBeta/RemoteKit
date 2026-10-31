#ifndef REMOTEKIT_BROWSER_COMPAT_RENDERER_H_
#define REMOTEKIT_BROWSER_COMPAT_RENDERER_H_

#include "content/public/renderer/content_renderer_client.h"

namespace remotekit::browser {
class CompatRendererClient : public content::ContentRendererClient {
 public:
  void WebViewCreated(blink::WebView*, bool, const url::Origin*) override;
  void RenderFrameCreated(content::RenderFrame* render_frame) override;
};
}  // namespace remotekit::browser
#endif  // REMOTEKIT_BROWSER_COMPAT_RENDERER_H_
