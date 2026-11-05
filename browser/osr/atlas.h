#pragma once
#include "remotekit/browser/osr/scheduler.h"
#include "remotekit/browser/osr/plane_pool.h"
#include "remotekit/browser/render_channel.h"
namespace remotekit::browser::osr {
class Generation;
struct Slot {
  ComPtr<ID3D11Texture2D> texture;
  ComPtr<ID3D11RenderTargetView> rtv;
  ComPtr<ID3D11Fence> ready, consumed;
  base::win::ScopedHandle texture_handle, ready_handle, consumed_handle;
  uint64_t last_value = 0, read_value = 0;
  bool reserved = false;
  // These are released only after this slot's real ready GPU fence completes.
  std::vector<std::shared_ptr<Target>> reads;
};
struct Consumer {
  uint32_t pid = 0;
  base::win::ScopedHandle process;
  std::array<uint64_t, 1 + 3 * kRenderSlotCount> handles{};
};
struct Atlas {
  explicit Atlas(Generation& owner) : owner_(owner) {}
  void Initialize();
  bool RefreshCurrentWork(Work& work);
  void CompleteWork();
  void PublishLayout();
  base::DictValue Describe(uint32_t pid);
  mojo::ScopedMessagePipeHandle TakeRenderEndpoint(std::string_view token, uint32_t pid);
  base::DictValue Description() const;
  ~Atlas();
  std::array<Slot, kRenderSlotCount> slots_;
  SharedAtlasFrame latest_frame_{};
  uint64_t published_revision_ = 0, frame_id_ = 0;
  base::win::ScopedHandle mapping_handle_;
  raw_ptr<SharedRenderMapping> mapping_ = nullptr;
  std::unique_ptr<RenderChannel> channel_;
  mojo::ScopedMessagePipeHandle pending_render_endpoint_;
  bool render_endpoint_delivered_ = false;
  std::unique_ptr<Consumer> consumer_;
  std::string channel_token_;

 private:
  Generation& owner_;
};
}  // namespace remotekit::browser::osr
