#ifndef REMOTEKIT_BROWSER_GPU_ATLAS_H_
#define REMOTEKIT_BROWSER_GPU_ATLAS_H_

#include <cstdint>
#include <memory>
#include <vector>

#include "base/memory/raw_ptr.h"
#include "base/values.h"
#include "remotekit/shared_atlas.h"

namespace content {
class WebContents;
}
namespace remotekit::browser {

// UI-sequence-only GPU producer. The borrowed WebContents must be stopped or
// reported through SetViews before its execution instance is replaced.
class GpuAtlas final {
 public:
  struct View {
    SharedAtlasView metadata{};
    raw_ptr<content::WebContents> contents = nullptr;
    bool capture_enabled = false;
  };
  GpuAtlas(uint32_t width_pixels, uint32_t height_pixels, uint64_t generation);
  ~GpuAtlas();
  GpuAtlas(const GpuAtlas&) = delete;
  GpuAtlas& operator=(const GpuAtlas&) = delete;
  void SetViews(std::vector<View> views);
  void SetFps(uint32_t fps);
  void StopView(uint64_t webview_id);
  base::DictValue DescribeForConsumer(uint32_t pid);
  base::DictValue Status() const;
  // Nonblocking. Submitted source reads are retained asynchronously until GPU
  // completion or confirmed device removal, including after this owner dies.
  void Stop();

 private:
  class State;
  std::shared_ptr<State> state_;
};
}  // namespace remotekit::browser
#endif
