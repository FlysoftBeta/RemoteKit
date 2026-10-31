# Release Chromium：捕获纹理、同步与帧租约接口调查

日期：2026-10-31。源码根 `C:/src/chromium/src`，官方 Release tag `157.0.8103.15`，当前 `remotekit` 分支 HEAD `1aa07b638799e59656559ae6c6649d4b197f555e`。本文只读调查现有 Chromium capture/GPU 文件；没有修改或编译实现，没有读取旧 `C:/Users/Flysoft/Desktop/remotekit`、rb 旧实现或旧项目 patches。单独参照了用户明确允许的 `C:/src/tmp/electron-investigation/cef`，该 CEF 目录仅作外部调用方式对照，不替代 Release 机制证据。行号用于定位对应声明附近。

边界前提来自本次任务：**Viz → browser 内部可以逐帧 Mojo；browser → 独立 CMake endpoint 边界不能逐帧 Mojo。** 本文列出现有 API、已存在的保证、缺失的接口，不决定外部传输或池架构。

## 1. 一帧实际从哪里到哪里

`services/viz/privileged/mojom/compositing/frame_sink_video_capture.mojom:20,56,119`：

```text
interface FrameSinkVideoConsumerFrameCallbacks {
  Done();
  ProvideFeedback(media.mojom.VideoCaptureFeedback feedback);
};

OnFrameCaptured(media.mojom.VideoBufferHandle data,
                media.mojom.VideoFrameInfo info,
                gfx.mojom.Rect content_rect,
                pending_remote<FrameSinkVideoConsumerFrameCallbacks> callbacks);

FrameSinkVideoCapturer.SetFormat(VideoPixelFormat format);
FrameSinkVideoCapturer.Start(pending_remote<FrameSinkVideoConsumer> consumer,
                            BufferFormatPreference buffer_format_preference);
```

Browser 现成包装为 `components/viz/host/client_frame_sink_video_capturer.h:37,106`：

```cpp
class ClientFrameSinkVideoCapturer;
void Start(mojom::FrameSinkVideoConsumer* consumer,
           mojom::BufferFormatPreference buffer_format_preference);
void StopAndResetConsumer();
```

该 wrapper 按单一 sequence 使用，处理 Viz 断开后的重连；这不意味着旧资源、旧 HANDLE 或旧帧租约跨 GPU/Viz 重启仍有效。

GPU 捕获流程：`FrameSinkVideoCapturerImpl` 从 pool 取得 `media::VideoFrame` → 将其 `ClientSharedImage` 与 acquire SyncToken 填入 `BlitRequest` → 发 `CopyOutputRequest(kSharedImage)` → Skia 向目标图像渲染/缩放/letterbox/叠加 → `DidCopyFrame()` → `MaybeDeliverFrame()` 克隆 GMB handle，发送 consumer callback。主要位置：

- `components/viz/service/frame_sinks/video_capture/frame_sink_video_capturer_impl.cc:1156`，选择 SharedImage copy 路径，`:1185` 建立 BlitRequest，`:1212` 建立 CopyOutputRequest。
- 同文件 `:1374` 起，ARGB/RGBAF16 mappable 结果已写入 pool texture，不再 ReadRGBAPlane；`:1415` 起 NV12 同理。
- 同文件 `:1565` 起克隆交付 handle、组装 info、绑定帧释放回调，`:1607` 调 OnFrameCaptured。

默认 I420/default preference 是 shared-memory 捕获；不能只看到 FrameSinkVideoCapturer 存在就推定输出为 GPU texture。`SetFormat(PIXEL_FORMAT_ARGB)` 的注释明确允许实际结果为 BGRA 或 RGBA，必须读取回调的 pixel_format，不能硬编码通道排列。

## 2. Consumer 收到的类型，不等同于 ClientSharedImage

`media/capture/mojom/video_capture_buffer.mojom:19,54,59` 定义：

```text
struct VideoFrameInfo {
  TimeDelta timestamp;
  VideoFrameMetadata metadata;
  VideoCapturePixelFormat pixel_format;
  Size coded_size;
  Rect visible_rect;
  Size natural_size;
  bool is_premapped;
  ColorSpace color_space;
  PlaneStrides? strides;
};
struct SharedImageBufferHandleSet {
  gpu.mojom.ExportedSharedImage shared_image;
  gpu.mojom.SyncToken sync_token;
};
union VideoBufferHandle {
  UnsafeSharedMemoryRegion unsafe_shmem_region;
  ReadOnlySharedMemoryRegion read_only_shmem_region;
  SharedImageBufferHandleSet shared_image_handle;
  gfx.mojom.GpuMemoryBufferHandle gpu_memory_buffer_handle;
};
```

**当前 FrameSink mappable pool 实际选的是最后一个 `gpu_memory_buffer_handle` 分支。** `components/viz/service/frame_sinks/video_capture/mappable_shared_image_video_frame_pool.cc:59`：

```cpp
media::mojom::VideoBufferHandlePtr CloneHandleForDelivery(
    const media::VideoFrame& frame) {
  gfx::GpuMemoryBufferHandle handle = frame.GetGpuMemoryBufferHandle();
  return media::mojom::VideoBufferHandle::NewGpuMemoryBufferHandle(
      std::move(handle));
}
```

不是因为 union 包含 `shared_image_handle` 就会在这条路径自动收到 ExportedSharedImage、mailbox、acquire token 或 managed tokens。pool 内有 `ClientSharedImage`，但其当前 consumer 交付不是这个 C++ 对象。`media/base/video_frame.cc:1280` 的 `GetGpuMemoryBufferHandle()` 转到 `ClientSharedImage::CloneGpuMemoryBufferHandle()`。

`ui/gfx/gpu_memory_buffer_handle.h:64,155` 的 Windows 形状：

```cpp
enum GpuMemoryBufferType { /*...*/ DXGI_SHARED_HANDLE /*...*/ };
class DXGIHandle {
 public:
  DXGIHandle Clone() const;
  HANDLE buffer_handle() const;
  const DXGIHandleToken& token() const;
  const base::UnsafeSharedMemoryRegion& region() const;
};
struct GpuMemoryBufferHandle {
  GpuMemoryBufferType type;
  uint32_t offset;
  uint32_t stride;
  const DXGIHandle& dxgi_handle() const&;
  GpuMemoryBufferHandle Clone() const;
};
```

DXGI payload 是 texture NT HANDLE、标识同一资源的 token、可选 CPU-copy shared-memory region；**不含 D3D ready fence HANDLE、fence value、adapter LUID 或完整 D3D texture descriptor**。见 `ui/gfx/mojom/native_handle_types.mojom:68` 的 DXGIHandle，及 `ui/gfx/mojom/buffer_types.mojom:39` 的 GMB handle。DXGI token 不是 Windows HANDLE，不是 GPU 完成时间线；两个重复 HANDLE 值也不能用数值判断是否为同一纹理。

`DXGIHandle::Clone()`（`ui/gfx/gpu_memory_buffer_handle.cc:63`）在当前进程内部 DuplicateHandle，并保留 token。**它不自动将 HANDLE 复制到任意外部 endpoint。** 交付到另一进程需对应的跨进程句柄复制/转移及所有权约定，不能把 browser 本地 HANDLE 整数写进 metadata 后让 endpoint 直接使用。Viz → browser 的 Mojo platform handle 序列化会完成该内部边界的转移；不能将此误当成 browser → endpoint 已接通。

## 3. Windows 这类捕获 GMB 如何创建，是否必然有 fence

已确认的专用 pool 链路：

1. `media/gfx/renderable_mappable_shared_image_video_frame_pool.cc:216`：Windows buffer usage 初值为 `SCANOUT_CPU_READ_WRITE`；建立 GLES2/raster/display 读写 usage，根据 capability 选择性添加 scanout。
2. `components/viz/service/frame_sinks/gmb_video_frame_pool_context_provider_impl.cc:61`：`CreateSharedImage(...)` 使用 SII-in-process 创建，并返回 `GenVerifiedSyncToken()`。`:103` 的初始化特意设 `always_create_native_gmb_handle=true`。
3. `gpu/command_buffer/service/shared_image_interface_in_process.cc:184`：该模式调用 `SharedImageFactory::CreateNativeGpuMemoryBufferHandle(size, format, usage)` 后导入原生 GMB。
4. `gpu/command_buffer/service/shared_image/shared_image_factory.cc:818`：Windows 转 `D3DImageBackingFactory::CreateGpuMemoryBufferHandle(...)`。
5. `gpu/command_buffer/service/shared_image/d3d_image_backing_factory.cc:351`：创建单 mip、单 array slice、DEFAULT usage、shader-resource/render-target 的 `ID3D11Texture2D`，MiscFlags 明确为 **SHARED_NTHANDLE | SHARED_KEYEDMUTEX**，再用 `IDXGIResource1::CreateSharedHandle(READ|WRITE)` 导出 NT handle。

因此这条已定位的 Windows capture-native-GMB 分配路径使用 keyed mutex；不能把另一个通用 D3D SharedImage 分配分支（同文件约 `:718`，根据 D3DSharedFence 支持在 SHARED 与 SHARED_KEYEDMUTEX 间选择）误当成 capture pool 一定提供共享 fence 的证据。

打开现有 texture 的 Chromium 示例在 `gpu/command_buffer/service/dxgi_shared_handle_manager.cc:21`：先 QueryInterface 得到 `ID3D11Device1`，调用 `OpenSharedResource1(shared_handle, IID_PPV_ARGS(&texture))`。该 handle 对应具体 device/adapter 支持的纹理，不是任意 adapter 都可互操作的承诺。`gpu/config/gpu_info.h:255` 已有 Windows GPU LUID，但当前 capture callback 没附带它；若外部要求精确 adapter 绑定，需另外取得/核对实际分配 device 的 adapter，而非假设默认设备相同。

`GpuMemoryBufferHandle` 的“mappable”也不表示 endpoint 可以直接 Map GPU memory：DXGI region 注释明确 CPU Map 需要 GPU process 拷贝到 shared memory。保持 GPU 纹理路径时不能以 Map()/shared-memory copy 冒充零 readback。

## 4. 写完成：当前 Windows callback 的 ready 保证到底是什么

**当前 mappable capture 路径在交付结果前等待 GPU finished callback；不是仅等待 CPU 命令提交，也不是向 consumer 输出共享 D3D fence。**

ARGB/RGBA：`components/viz/service/display_embedder/skia_output_surface_impl_on_gpu.cc:1068`：

```cpp
const bool should_wait_for_gpu_work =
    request->has_blit_request() &&
    request->blit_request().populates_mappable_shared_image();
```

成立时构造 `ReadbackContextTexture`，调用 `FlushAndSubmitCopyOutput(..., readback_context)` 后返回，不立即 SendResult。NV12 同文件 `:1492` 有相同判断与延迟交付。

`FlushAndSubmitCopyOutput()`（`:1205`）在 Ganesh 时设置 `ReadbackContextTexture::OnMailboxReady` 为 `GrFlushInfo.fFinishedProc`；在 Graphite 时注册 finished callback，进入相同 OnMailboxReady。`FlushSurface()`（约 `:1158`）将回调装入 GPU flush/recording，随后执行对应 submit。`CheckReadbackCompletion()` / `CheckAsyncWorkCompletion()`（`:2530,2730`）定时触发 Skia 完成检查，推动异步回调。

`components/viz/service/display_embedder/skia_render_copy_results.cc:179`：

```cpp
static void ReadbackContextTexture::OnMailboxReady(GrGpuFinishedContext c);
void ReadbackContextTexture::OnMailboxReadyInternal() {
  // ReadbackDone bookkeeping...
  request_->SendResult(std::make_unique<CopyOutputSharedImageResult>(...));
}
```

Skia 自身的契约在 `third_party/skia/include/gpu/ganesh/GrTypes.h:132`：finished proc 正常表示当前及先前 flush 的 GPU 工作已完成；flush 失败而未提交也会执行回调。Graphite 的 `GraphiteTypes.h:123` 同样区分完成/失败。当前 viz Graphite lambda 没把 CallbackResult 输出给 consumer。因此“正常成功交付前已有 GPU completion”等于当前路径的同步保证，不等于故障后内容仍有效；GPU/device loss 必须使资源 generation 失效，不能用单个 callback 的到达证明无故障图像内容。

内部使用 GL/ANGLE 时，原生 GPU completion 也不必是 ID3D11Fence。`third_party/angle/src/libANGLE/renderer/d3d/d3d11/Fence11.cpp:25` 的 GL sync 实现使用 D3D11_QUERY_EVENT、context End(query)、GetData 查询完成。故不能从“D3D11 后端”推出每帧都存在可导出的 ID3D11Fence。

`kPreferSharedImageWithNativeHandle` enum 虽在 Mojo 存在，Windows 当前不能直接用它省去上述完成等待：`frame_sink_video_capturer_impl.cc:1162` 只在 Linux 将该 preference 计入 `prefer_shared_image`；非 Linux 只认 kPreferMappableSharedImage，后续 DidCopyFrame 的非默认 ARGB 分支也 CHECK 该值。更改此路径需要配套保证传到 consumer 的写依赖，不是换一个枚举就完成。

## 5. Done、断连和 pool 真正复用时点

`OnFrameCaptured` 的契约：图像内容只保证可读到 consumer 调 Done 为止。它不是“HANDLE 仍 open 就不会覆盖”的契约。

具体链路：

- `FrameSinkVideoCapturerImpl::MaybeDeliverFrame()` 创建 self-owned `InFlightFrameDelivery`，其 `post_delivery_callback` 捕获 `scoped_refptr<VideoFrame>`（`:1588`）。
- `components/viz/service/frame_sinks/video_capture/in_flight_frame_delivery.cc:19,23`：Done 执行一次 callback；**该对象析构也调用 Done**，因此 callbacks pipe 断开也会释放这个租约。
- `FrameSinkVideoCapturerImpl::NotifyFrameReleased(scoped_refptr<VideoFrame>)`（`:1672`）递减 in-flight 计数，函数结束释放该引用；不接收任何 GPU fence，也不等待 endpoint GPU。
- 若还有 `marked_frame_`、队列或其他 VideoFrame 引用，实际析构可能延后。所以 Done 使 pool *有机会*回收，而不是保证同一行代码立即覆盖纹理。
- 真正归还底层资源在 `media/base/video_frame.cc:1653` 析构执行 ReleaseMailboxCB，转 `media/gfx/renderable_mappable_shared_image_video_frame_pool.cc:365` 的 `InternalRefCountedPool::OnVideoFrameDestroyed(...)`。它保存 release SyncToken；若资源未丢失、pool 未 shutdown，就 push 到 `available_frame_resources_`，最多保留两个空闲项。
- 下一次 `MaybeCreateVideoFrame()`（同文件 `:317`）取兼容 size/color-space 的 FrameResources，或新分配；pool 的 VideoFrame destruction observer 另在 `mappable_shared_image_video_frame_pool.cc:94` 更新 reserved count/generation。

内部 VideoFrame release SyncToken 可以保护 Chromium GPU consumer 的后续使用；**FrameSink callbacks.Done() 当前无 SyncToken/fence 参数，外部 endpoint 的 GPU read 不会自动进入这个 token。** Browser 只保留/复制 native HANDLE，不保留 callbacks 租约，不能阻止 Viz pool 复用内容。

Browser 标准 capture-device adapter 可参照 `content/browser/media/capture/frame_sink_video_capture_device.cc:455`：保存 callbacks remote，将 `ScopedFrameDoneHelper` 传给 receiver；在 `OnFramePropagationComplete()`（`:631`）执行 Done/reset。这个完成必须有真实下游生命周期含义，不能替换成“描述符已发出”。

## 6. D3D 同步工具中哪些确实存在，哪些不在这个 callback 上

### 6.1 Keyed mutex

`gpu/command_buffer/service/dxgi_shared_handle_manager.cc:129,163`：

```cpp
bool DXGISharedHandleState::AcquireKeyedMutex(
    Microsoft::WRL::ComPtr<ID3D11Device> device);
void DXGISharedHandleState::ReleaseKeyedMutex(
    Microsoft::WRL::ComPtr<ID3D11Device> device);
```

内部按 device 记录递归使用计数，实际 AcquireSync/ReleaseSync 都用 `gpu::kDXGIKeyedMutexAcquireKey = 0`（`gpu/command_buffer/common/constants.h:100`）；并非一帧递增 key 的现成协议。`D3DImageBacking::BeginAccessD3D()` / `EndAccessD3D()`（`.cc` 约 `:1715,:1756`）在需要时配套 acquire/release。外部直接打开 capture texture 若使用其 keyed mutex，必须遵循现有 key 和互斥访问规则；不能自行用另一组 key 假定 producer 配合。Chromium 内部 acquire 为 INFINITE，外部持锁失败/崩溃需明确处理，不能由普通 CPU slot state 消除这类 GPU/driver 等待。

### 6.2 共享 D3D fence

`ui/gfx/win/d3d_shared_fence.h:32` 已有：

```cpp
static scoped_refptr<D3DSharedFence> CreateForD3D11(ComPtr<ID3D11Device>);
static scoped_refptr<D3DSharedFence> CreateFromD3D11Fence(
    ComPtr<ID3D11Device> signal_device, ComPtr<ID3D11Fence>, uint64_t value);
static scoped_refptr<D3DSharedFence> CreateFromScopedHandle(
    base::win::ScopedHandle fence_handle, const DXGIHandleToken& fence_token);
static bool IsSupported(ID3D11Device*);
HANDLE GetSharedHandle() const;
base::win::ScopedHandle CloneSharedHandle();
uint64_t GetFenceValue() const;
void Update(uint64_t fence_value);
bool WaitD3D11(ComPtr<ID3D11Device> wait_device);
bool IncrementAndSignalD3D11();
```

同文件还支持 D3D12。实现 `.cc:250` 的 WaitD3D11 通过 Device5::OpenSharedFence、GetCompletedValue、DeviceContext4::Wait；`:303` 的 IncrementAndSignal 用 DeviceContext4::Signal。**WaitD3D11 是在 GPU context 上排队 wait，不是 CPU 等到 fence 完成的 API。** `.h` 也没有公开 CPU wait/get-fence 方法，因此 browser/endpoint 若要 CPU 确认 read-complete，需使用实际 ID3D11Fence 的 completion query / event 接口或另一个确实代表 GPU 完成的机制，不能把成功返回 WaitD3D11 当作 CPU 已完成。

现有 CPU completion 对照：`media/gpu/windows/d3d12_fence.cc:60` 的 WaitCPU 用 GetCompletedValue、SetEventOnCompletion、WaitableEvent；其具体等待实现无 timeout，不可未经处理直接当有界外部等待。这里列出已有 API，未选择 endpoint 的同步实现。

### 6.3 SharedImage 的外部 fence 回传面

`gpu/command_buffer/client/shared_image_interface.h:264`：

```cpp
virtual void UpdateSharedImage(
    const gpu::SyncToken& sync_token,
    scoped_refptr<gfx::D3DSharedFence> d3d_shared_fence,
    const gpu::Mailbox& mailbox);
```

`gpu/ipc/client/shared_image_interface_proxy.cc:260` 首次注册 fence HANDLE/token，随后发送 fence value；`gpu/ipc/service/shared_image_stub.cc:426,452` 要求该 channel/factory 已拥有对应 mailbox，最后调用 SharedImageManager::UpdateExternalFence。`D3DImageBacking::UpdateExternalFence()`（`.cc:1198`）把 fence 插入 write_fences_。普通 backing 的 read_fences_ 在后续 write 前等，write_fences_ 在后续 read/write 前等（`.h:503` 及 `.cc:GetPendingWaitFences`）。

**它不是 FrameSink Done(fence) 的替代签名。** 当前 FrameSink GMB callback 没有原始 mailbox，也不授予 browser 该 SII channel 的 factory 所有权；随意用同一 texture handle/token 创建另一个 backing，并不证明外部 fence 已影响原始 pool backing 的复用。若要接通 GPU-side release fence，而不是先在外部确认 read-complete 再 Done，需要明确增加 mailbox/授权与正确 backing 的同步入口，或修改 capture completion API/实现。这里没有发现开箱即用的 FrameSink 外部 read-fence 回传路径。

### 6.4 不可混淆的工具

- `ClientSharedImage::Export(bool with_buffer_handle=false)`、ImportUnowned（`gpu/command_buffer/client/client_shared_image.h:274`）操作 Chromium 的 mailbox/token ownership；不能交给没有 Chromium GPU channel 的 CMake endpoint 当原生 fence 使用。
- `CreateGpuFenceForSyncTokens(... GLES2Interface*, ContextSupport*, callback)`（同头 `:286`）需要现有 GL/GPU context 与真实 SyncTokens。当前 GMB capture consumer 没收到原始 mailbox/token；不能凭纹理 HANDLE 合成该依赖。
- `SyncToken` 不是 D3D11Fence；SII WaitSyncToken、GenVerifiedSyncToken 的 command ordering 不自动等于实际 GPU 完成。
- `gfx::GpuFenceHandle` 在 Windows 可以持有 HANDLE，但 `gfx::GpuFence::Wait()`（`ui/gfx/gpu_fence.cc:40`）Windows 分支是 NOTREACHED。不能调用这一通用 Wait 替代 Windows D3D completion wait。
- CPU metadata 的 ready 位、事件、序号只证明 CPU 发布顺序；只有发布点已经晚于 GPU 写完成，才同时表示纹理内容可消费。CPU 回收消息也只有在它晚于 GPU 读完成时才能安全触发 Done。

## 7. 对外共享时，当前已满足与必须补齐的接口事实

| 要核对的要求 | 当前现成事实 | 尚需实现/修改的边界 |
|---|---|---|
| 捕获到 Windows 原生共享纹理 | 当前 mappable pool 克隆 DXGI native handle；不需要先 ReadRGBAPlane | consumer 必须实际请求合适 GPU format/preference，检查返回 type/format/device loss |
| 写完成后发布 | 当前 Windows mappable path 正常交付前已经跑 GPU finished callback | 若保留此路径，无需凭空发明 producer ready fence；若取消等待，则需要实际 GPU producer signal/fence 输出，不是单改metadata |
| endpoint 打开 texture | OpenSharedResource1 有源码示例；texture 是 NT shared handle | browser→endpoint 的合法 HANDLE 复制/注册、descriptor/format/adapter/epoch信息没有现成 FrameSink 外部协议 |
| endpoint GPU 读完成后复用 | callbacks remote 可以由 browser 持有并延迟 Done | 对外 read-complete 证据、有限等待/断开处理及回 browser 的租约完成发布需要实现；Done 本身不带 fence |
| 不逐帧外部 Mojo | Chromium 内部逐帧 OnFrameCaptured/Done 是既有正常机制 | 不将这些 callback remote 转交外部；外部 metadata、slot状态、ack/fence value 的非逐帧Mojo边界仍需实现 |
| GPU/Viz重启 | ClientFrameSinkVideoCapturer 会重连；pool context loss 会重建 generation | 对外旧资源/旧句柄/未完成读租约不得被当成新generation或直接复用 |

如果 endpoint 仅把 capture texture 拷贝到自己拥有的 GPU texture，源租约所需的是**该次源读取/拷贝真实完成**；若直接持续消费源纹理，则需覆盖其全部 GPU read。CPU 的 CopyResource 调用返回或“已提交编码命令”都不是这个完成事实。无论之后 root 选择何种数据面，不能在 GPU 尚读源纹理时先 Done，也不能靠保留一份 native HANDLE 延长像素内容有效期。

## 8. 用户允许的 CEF 对照

`C:/src/tmp/electron-investigation/cef/libcef/browser/osr/video_consumer_osr.cc:50` 选择：Windows shared texture 用 kPreferMappableSharedImage；Linux 才用 kPreferSharedImageWithNativeHandle。`:20` 的 ScopedVideoFrameDone 析构调用 Done，`:96` 的 OnFrameCaptured 开始即持有这个 scope；Windows 分支约 `:177` 将 GMB 的 `dxgi_handle().buffer_handle()` 传入 OnAcceleratedPaint。

对应 `include/cef_render_handler.h:151` 明确要求 handle resource 不缓存、不在 callback 外访问，应在 callback 内拷贝到客户端自有 texture，callback 返回后归池。它印证“当前已完成写入的池纹理 + callback lease”这一调用契约；**不是长期对外共享池租约、ready/return fence 或非逐帧外部传输方案的已实现证据**。

## 验证边界

本次仅逐文件阅读/rg 交叉定位，没有做硬件 GPU capture、跨 adapter 或 endpoint texture-open 实测，没有修改代码或 patches。结论针对已定位的 Release Windows mappable capture 路径；不将其他 capture backend、普通 SharedImage、Linux native-handle 优化或 CEF callback 契约混为同一个已完成接口。root 后续逐项核对与决策以这些明确边界为输入。

## 补充：root 指定 GPU bridge 方向的机制核对

root 随后指定的核对对象为：browser 独立 D3D11 bridge 读取 capture texture，GPU copy 到自有有界输出资源；ready fence 保护该 copy，consumed fence 保护 endpoint 读取输出资源；Viz 源租约在 browser copy 的真实 GPU 读取完成后 Done。以下只核对与该指定方向相关的现有事实。

### 两个完成域与 source keyed mutex

- capture-source 的寿命与自有 atlas-slot 的寿命不同。ready fence signal 若确实排在同一 bridge immediate context 的 copy/read 之后，其完成值可以覆盖该次 source read；它不是 endpoint 的 consumed 完成值。Done 必须晚于 source-read GPU completion，输出 slot 复用必须晚于该 slot 的 endpoint GPU-read completion。
- capture native texture 的创建 flags 和 key 已在第 3、6 节确认：NTHANDLE + KEYEDMUTEX；Chromium acquire/release key 都为 **0**。bridge 的 source import 需检查实际 texture desc、QueryInterface IDXGIKeyedMutex，再匹配该协议，不能用应用输出 fence 值当作 source mutex key。
- source handle/token 可以缓存打开对象以减少 OpenSharedResource1 的开销，但 **资源引用缓存不是像素租约**。pool 再次交付相同 token 代表同一底层 texture；每次交付仍是独立帧租约，必须重新关联 callbacks、capture counter 与实际 source-read completion。GPU/Viz/pool generation 重建后不能沿用旧映射。
- `DXGIHandle::Clone` 保留 token；`DXGISharedHandleManager::GetOrCreateSharedHandleState`（`.cc:222`）以 token 为 key，已有 entry 还用 CompareObjectHandles 验证对应同一 kernel resource。HANDLE 的数值变化不影响 token 标识。
- `D3DSharedFence::IncrementAndSignalD3D11()` 只在 Signal 成功后更新逻辑 fence value，并不在 CPU 等完成，也不主动 Flush。独立 bridge 不能把其返回值当成 ready-complete，必须安排实际 command submission 与 completion 检查。若用 GetCompletedValue 轮询，device-removed、接口不支持和等待超时都不能当作普通完成；不要在失败后归还 source lease/复用 slot。
- CopyResource/CopySubresourceRegion 本身不承担色彩/通道/缩放转换；本次 capture 会报告 pixel_format、coded_size、visible/content rect，native texture 的真实 DXGI format/尺寸还可从已打开 ID3D11Texture2D::GetDesc 取得。root 的 copy 参数需满足这些实际限制，不能仅因 metadata 都叫 ARGB 就推定两个 texture 兼容。

### 公共 capturer 创建与 FrameSinkId

无需为普通主 view capture 直接使用 content 内部 manager。`content/public/browser/render_widget_host_view.h:267`：

```cpp
virtual std::unique_ptr<viz::ClientFrameSinkVideoCapturer>
CreateVideoCapturer() = 0;
```

实现 `content/browser/renderer_host/render_widget_host_view_base.cc:382`：

```cpp
auto capturer = GetHostFrameSinkManager()->CreateVideoCapturer();
capturer->ChangeTarget(viz::VideoCaptureTarget(GetFrameSinkId()),
                      /*sub_capture_target_version=*/0);
return capturer;
```

这里获取的是**该 view**的 FrameSinkId，Start 前已经绑定 target。另一公共访问点为 `RenderWidgetHostView::GetRenderWidgetHost()`、`RenderWidgetHost::GetFrameSinkId()`（`content/public/browser/render_widget_host.h:128`）；若脱离当前主 view、处理嵌入/特殊 target，不应未经核对就假定任意 host 的 id 与要捕获的 view target 完全等价。

若明确已有 HostFrameSinkManager，`components/viz/host/host_frame_sink_manager.h:248` 两种签名为：

```cpp
void CreateVideoCapturer(
    mojo::PendingReceiver<viz::mojom::FrameSinkVideoCapturer> receiver,
    uint32_t capture_version_source = 0);
std::unique_ptr<viz::ClientFrameSinkVideoCapturer> CreateVideoCapturer(
    uint32_t capture_version_source = 0);
```

裸 Mojo 用 `ChangeTarget(VideoCaptureTarget?, uint32_t sub_capture_version)`；wrapper 用 `ChangeTarget(const std::optional<viz::VideoCaptureTarget>&, uint32_t)`。`content::GetHostFrameSinkManager()` 在 `content/browser/compositor/surface_utils.h:21`，属于 content 内部头，活在 UI sequence；不要为可以走公共 view 方法的代码增加这个内部依赖。

一个 wrapper 自动恢复 Viz 连接不代表它自动跟随 WebContents 的跨站 renderer/view 替换。`content/public/browser/web_contents_observer.h:240` 有 `CaptureTargetChanged()`，同时有 RenderFrameHostChanged/RenderViewHostChanged；原生 capture tracker 在这些通知时 `OnPossibleTargetChange()`（`content/browser/media/capture/web_contents_frame_tracker.cc:350` 起）。它取得当前实际 CaptureTarget，并重新 ChangeTarget。root 的 view-specific consumer 应核对 view 更换与旧 lease 的处理，不能一次绑定旧 id 永久使用。

### WebContents capture lease 与隐藏渲染

`content/public/browser/web_contents.h:933` 当前签名是 **四个参数**，返回 RAII closure：

```cpp
[[nodiscard]] virtual base::ScopedClosureRunner IncrementCapturerCount(
    const gfx::Size& capture_size,
    bool stay_hidden,
    bool stay_awake,
    bool is_activity) = 0;
```

调用方持有返回值直到停止 capture；通过析构或 RunAndReset 释放，不再调用一个公共 DecrementCapturerCount 方法。`WebContentsImpl::IncrementCapturerCount`（`.cc:2831`）在 `stay_hidden=true` 时 **DCHECK(capture_size.IsEmpty())**。语义为：

| 参数/状态 | 源码行为 |
|---|---|
| stay_hidden=false | 增加 visible_capturer_count；页面按 visible 处理，即使宿主未实际前台可见 |
| stay_hidden=true，capture_size为空 | 增加 hidden_capturer_count；保留页面隐藏语义，但允许 hidden-but-painting |
| stay_awake=true | 获取防系统休眠 WakeLock；不是 GPU completion/texture lease |
| is_activity=true | 将 capture 当活动更新对应状态；不等同于键盘焦点 |
| 非空 capture_size | 临时 preferred-size 提示，**不是**view实际尺寸设置，也不是输出分辨率约束 |

`WebContentsImpl::CalculatePageVisibilityState()`（`:5291`）对 visible capture 返回 kVisible，对 hidden capture 返回 kHiddenButPainting；`SetPrimaryMainFrameViewVisibility()`（`:5447`）对非 kHidden 的 view 调 ShowWithVisibility，因此 capture lease 确实禁止通常的隐藏停止渲染优化。

Aura 接入也已存在：`WebContentsViewAura::OnCapturerCountChanged()`（`content/browser/web_contents/web_contents_view_aura.cc:1120`）在正在 capture 且 window 已挂到 host 时自动持有 `window_->GetHost()->CreateVideoCaptureLock()`；同文件 `:565` 在窗口加入 root 时补建，离开 root 时释放。无需把这个锁与每帧 Done lease 混为一个对象。

`aura::WindowTreeHost::CreateVideoCaptureLock()`（`ui/aura/window_tree_host.h:298`）返回 `std::unique_ptr<VideoCaptureLock>`，用于 native occlusion/compositor 的 capture 保活。它并不保证任意从未显示的 HWND 都已具备非零尺寸、可见 compositor 与有效 surface：

- `ui/aura/window_tree_host.cc:707` 更新 native-occlusion compositor visibility 前要求 `accelerated_widget_made_visible_`；`:532` 的 OnAcceleratedWidgetMadeVisible(false) 直接更新 compositor invisible。
- 同文件 `:727` 的 native hidden/occluded 分支在有 capture lock 时允许 compositor visible，但保留 Windows iconified HWND 可能尺寸为 0×0 的 TODO。
- `WindowTreeHostPlatform::OnVideoCaptureLockCreated()` 调 platform_window->SetVideoCapture（`.cc:190`）；这个 hook 不是“自动创建有效 renderer surface”或强制恢复任意隐藏 host 的通用接口。

因此保持 Aura 本身与取得 WebContents capture lease 是已有事实；“从未 Show 的 hidden native host 仍稳定持续捕获”需要实际 host 生命周期验证，不能从锁名直接推出。实际 view/viewport 要非零，renderer 已创建并提交有效 surface，FrameSinkId 必须 valid。

### 源码签名匹配的最小 setup 片段（未编译实施）

此片段只展示 API 接线；consumer、帧租约与 bridge 由调用方提供，未实现任何传输/池策略。UI sequence 上使用：

```cpp
#include <memory>
#include "base/functional/callback_helpers.h"
#include "base/time/time.h"
#include "components/viz/host/client_frame_sink_video_capturer.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "media/base/video_types.h"

struct CaptureSetup {
  base::ScopedClosureRunner capture_count;
  std::unique_ptr<viz::ClientFrameSinkVideoCapturer> capturer;
};

bool BeginCapture(content::WebContents* contents,
                  viz::mojom::FrameSinkVideoConsumer* consumer,
                  const gfx::Size& capture_pixels,
                  bool stay_hidden,
                  CaptureSetup& setup) {
  if (!contents || !consumer || capture_pixels.IsEmpty())
    return false;
  auto* view = contents->GetRenderWidgetHostView();
  if (!view)
    return false;
  setup.capture_count = contents->IncrementCapturerCount(
      stay_hidden ? gfx::Size() : capture_pixels,
      stay_hidden, /*stay_awake=*/false, /*is_activity=*/false);
  setup.capturer = view->CreateVideoCapturer();  // target already bound
  setup.capturer->SetFormat(media::PIXEL_FORMAT_ARGB);
  setup.capturer->SetMinCapturePeriod(base::Seconds(1) / 30);
  setup.capturer->SetMinSizeChangePeriod(base::TimeDelta());
  setup.capturer->SetResolutionConstraints(capture_pixels, capture_pixels,
                                            /*use_fixed_aspect_ratio=*/true);
  setup.capturer->SetAutoThrottlingEnabled(false);
  setup.capturer->SetAnimationFpsLockIn(false, 0.0f);
  setup.capturer->Start(
      consumer, viz::mojom::BufferFormatPreference::kPreferMappableSharedImage);
  return true;
}
```

capture_pixels 是视频输出物理尺寸。view 自身可用公共 `RenderWidgetHostView::SetSize(const gfx::Size&)` / SetBounds 设置布局大小，但它与 device scale/屏幕信息相关，不能无条件把 pixels 当 DIP。30fps 是 `SetMinCapturePeriod` 的上限约束，不是保证每 33ms 一帧；静态内容、damage、动画检测、backpressure 都能影响实际交付。`RequestRefreshFrame()` 可以请求重复/刷新最近帧，不能绕过池容量或生产出尚未存在的 surface。

GN 依赖对应头文件的候选最小面：`//base`、`//content/public/browser`、`//components/viz/host`、`//components/viz/common`、`//services/viz/privileged/mojom/compositing`、`//media/capture/mojom:video_capture_buffer`、`//media/capture/mojom:video_capture_types`、按 media/base 头需要 `//media`。处理 native DXGI handle / D3DSharedFence 的 browser bridge 可再依赖 `//ui/gfx`，使用 `gpu::kDXGIKeyedMutexAcquireKey` 时依赖 `//gpu/command_buffer/common`。自写 D3D11/DXGI device 操作需相应 Windows system libs（d3d11/dxgi）；这些只是 API/target 对应关系，本次未新增 GN target 或运行 gn check。
