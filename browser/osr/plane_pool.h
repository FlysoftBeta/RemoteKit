#pragma once
#include "remotekit/browser/osr_renderer.h"
#include "remotekit/browser/osr/device.h"
#include "remotekit/browser/offscreen_host.h"
#include "remotekit/browser/view_model.h"
#include <array>
#include <map>
namespace remotekit::browser::osr {
class Generation;
struct Work;
inline constexpr size_t kPlaneTargets = kRenderSlotCount + 1;
uint64_t NextPlaneGeneration();
struct Target {
  ComPtr<ID3D11Texture2D> texture;
  ComPtr<ID3D11ShaderResourceView> srv;
  ComPtr<ID3D11Fence> ready;
  base::win::ScopedHandle texture_handle, ready_handle;
  uint64_t value = 0;
  bool writing = false;
};
struct Plane {
  SharedAtlasView metadata{};
  base::WeakPtr<OffscreenHost> host;
  gfx::Size size;
  uint64_t generation = 0, binding_epoch = 0;
  uintptr_t host_identity = 0;
  bool enabled = false, configuring = false, configured = false, retired = false;
  bool retirement_probe_registered = false;
  base::TimeTicks configure_deadline, next_configure_attempt;
  std::array<std::shared_ptr<Target>, kPlaneTargets> targets;
  std::shared_ptr<Target> latest;
};
struct PlaneRead {
  std::shared_ptr<Plane> plane;
  SharedAtlasView metadata{};
  std::shared_ptr<Target> target;
  bool enabled = false;
};
struct PlanePool {
  explicit PlanePool(Generation& owner) : owner_(owner) {}
  using View = OsrRenderer::View;
  void SetViews(std::vector<View> views);
  bool Configure(const std::shared_ptr<Plane>& plane);
  void Configured(std::shared_ptr<Plane> plane, bool ok);
  void PlaneResult(std::shared_ptr<Work> work,
                   size_t index,
                   std::shared_ptr<Target> target,
                   uint32_t target_index,
                   viz::mojom::RemoteKitFrameResultPtr result);
  void OnDemandChanged(base::WeakPtr<OffscreenHost> notified_host);
  void StopView(uint64_t id);
  base::DictValue RenderStatus(uint64_t id) const;
  std::map<uint64_t, std::shared_ptr<Plane>> planes_;
  std::vector<uint64_t> order_;
  uint64_t revision_ = 1;

 private:
  Generation& owner_;
};
}  // namespace remotekit::browser::osr
