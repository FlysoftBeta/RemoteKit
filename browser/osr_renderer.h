#ifndef REMOTEKIT_BROWSER_OSR_RENDERER_H_
#define REMOTEKIT_BROWSER_OSR_RENDERER_H_

#include <cstdint>
#include <memory>
#include <string_view>
#include <vector>

#include "base/memory/raw_ptr.h"
#include "base/values.h"
#include "mojo/public/cpp/system/message_pipe.h"
#include "remotekit/shared_render_slots.h"

namespace remotekit {
struct InputEvent;
}
namespace remotekit::browser {
class OffscreenHost;
namespace osr {
class Generation;
}

// UI-sequence-only GPU producer. Borrowed hosts must be stopped or reported
// through SetViews before their execution instances are replaced.
class OsrRenderer final {
 public:
  struct View {
    // Both output pixels/DIP and the independent page DPR are published unchanged.
    SharedAtlasView metadata{};
    bool render_enabled = false;
    // Explicit service-host identity. Native-window output is unsupported.
    raw_ptr<OffscreenHost> offscreen_host = nullptr;
  };
  OsrRenderer(uint32_t width_pixels, uint32_t height_pixels, uint64_t generation);
  ~OsrRenderer();
  OsrRenderer(const OsrRenderer&) = delete;
  OsrRenderer& operator=(const OsrRenderer&) = delete;
  static bool IsGpuFaultSealed();
  void SetViews(std::vector<View> views);
  void StopView(uint64_t webview_id);
  base::DictValue DescribeForConsumer(uint32_t pid);
  mojo::ScopedMessagePipeHandle TakeRenderEndpoint(std::string_view token, uint32_t consumer_pid);
  base::DictValue Status() const;
  base::DictValue RenderStatus(uint64_t webview_id) const;
  void TraceInput(const char* stage, const InputEvent& input, int status = 0);
  // Nonblocking. Submitted source reads are retained asynchronously until GPU
  // completion or confirmed device removal, including after this owner dies.
  void Stop();

 private:
  std::shared_ptr<osr::Generation> state_;
};
}  // namespace remotekit::browser
#endif
