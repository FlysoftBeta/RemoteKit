# Capture 直接写共享槽：源码可行性审计

2026-11-01。只读调查，本轮没有改产品代码、Chromium patch、ABI，没有构建或运行 GPU 实验。下面是机制与实施边界，最终方案由主 Agent 决定。

**结论：现成 CopyOutput 的 RGBA BlitRequest 能直接写进调用者提供的 SharedImage，包括 atlas 内偏移和 padding 清黑。无需新 SkiaOutputDevice。现成 FrameSinkVideoCapturer API 却不能接收固定外部三槽；需小范围 Chromium 扩展固定池配置、导入和生命周期，不能只在 gpu_atlas.cc 换一个函数。**

## 可选机制

|机制|源码证据与效果|必须补的部分|判断|
|---|---|---|---|
|浏览器已有三槽导入为 capturer 固定目的池|`BlitRequest` 已携带 `ClientSharedImage`、offset、acquire SyncToken；GPU RGBA 路径按 mailbox `ProduceSkia`，直接 RenderSurface 到该图像|一次/重建的 browser→Viz 配置；固定池 import/reserve/return；浏览器按 DXGI token 识别槽；lease 延长至 endpoint consumed|可行候选，保留原 atlas 大小/布局/endpoint ABI，改动最集中|
|capturer 自建固定池，提前导出三槽|现有池底层确有 DXGI native handle，但懒分配，返回队列最多留2个，外层容量11；没有预分配导出协议|新的固定池/预分配导出响应；尺寸/offset扩展；browser 输出建立时序；同样的消费退役|可行，但比导入既有三槽增加初始化和资源归属变化；并非直接复用现有池就能稳定导出|
|不改 Chromium，观察最先出现的3个捕获 handle 当共享槽|现有每帧 handle 可 clone，DXGI token 可识别资源|池可能继续分配、淘汰；捕获尺寸与atlas不一致；没有固定三槽建立点|不成立；即使短时只见3个handle，也不是API保证|
|自定义 SkiaOutputDevice 导出 root render target|不属于现成 capture destination 通路|需要重做输出设备、buffer池与同步/失效，且不能假定capture blit自动消失|本审计没有发现为省 browser copy 必须走这条路；现成 BlitRequest 更直接|

这里省的是 **capture 输出纹理→browser 共享槽** 的一次整幅 copy。CopyOutput 本身从 root surface 向目的纹理绘制仍存在，不声称消除所有 capture GPU 工作。

## 精确调用链与线程边界

本节 Chromium 路径均相对 `C:/src/chromium/src`。

1. `browser/gpu_atlas.cc:404–416`：browser UI sequence 创建 `ClientFrameSinkVideoCapturer`，ARGB、固定原分辨率、mappable SI；root候选只改 target，仍走同一捕获器。
2. `components/viz/host/client_frame_sink_video_capturer.h:43` 的 wrapper 保存配置并在 Viz crash 后重放。新固定池配置必须进入此重连流程，不能只临时调用一次 remote。
3. `services/viz/privileged/mojom/compositing/frame_sink_video_capture.mojom`：目前只有格式、分辨率、target、start/stop等，没有 external buffer/pool setter、预分配导出或目的offset方法。browser→Viz 的 Mojo 配置扩展不可省；它不是 browser↔endpoint 每帧通信。
4. `components/viz/service/frame_sinks/video_capture/frame_sink_video_capturer_impl.cc:941–966`：Viz capturer sequence 从 `frame_pool_->ReserveVideoFrame(format,capture_size)` 取 VideoFrame。无帧则限流，不继续写；`1064` 用 frame visible_rect 计算 content_rect。
5. 同文件 `1238`：现成 `BlitRequest(content_rect.origin(), kLetterbox, frame->shared_image(), frame->acquire_sync_token(), true)`；`1290–1303` 的 area/scale/result_selection 保留源尺寸，result_selection 为 content_rect.size。
6. `components/viz/service/display_embedder/skia_output_surface_impl.cc:986–1001`：收集目的 SI 的同步令牌，GPU scheduler 等这些令牌，然后派发 `SkiaOutputSurfaceImplOnGpu::CopyOutput`。SyncToken 是调度顺序，不自动等于硬件执行完成。
7. `.../skia_output_surface_impl_on_gpu.cc:1079–1165`：GPU sequence 对目的 mailbox `ProduceSkia(...DISPLAY_WRITE)`，验证 offset+output size 包含于目标图像；`BeginScopedWriteAccess`；`kLetterbox` 时清整个目标黑，再在 offset 绘制。尺寸不是 BlitRequest 的独立参数，由 CopyOutput result_selection/scale决定。
8. `FrameSinkVideoCapturerImpl::DidCopyFrame` (`1335`, `1448–1478`) 对 mappable ARGB 非空结果标记成功，不再拷贝像素；`1655–1692` clone GMB handle 和发 `OnFrameCaptured`。GPU/Viz→browser逐帧回调保持现有机制，允许存在。
9. 回调 `Done()` 经 `InFlightFrameDelivery`、`NotifyFrameReleased` 释放持有的 VideoFrame；底层 frame destruction/release callback 才把资源归还池。不能把交付回调或 handle 关闭当作已经归池。

`GmbVideoFramePoolContextProviderImpl` 中 Context 的创建者在 capturer sequence，实际 SI GPU操作经 `SchedulerSequence` 调度到 `GpuServiceImpl::main_runner()`。`InitializeOnGpu` 创建 `SharedImageInterfaceInProcess`，共享图像管理器与 Viz output GPU 路径相同。可以在这里增加“从传入 GMB handle 创建 SI”能力，而非从 browser 持有任意GPU线程指针。

## 固定池与 DXGI 导入

现有池不是3槽池：

- `FrameSinkVideoCapturerImpl` 常量 (`.h:175–176`) 为 design limit10、capacity11。
- `viz/.../mappable_shared_image_video_frame_pool.cc:35–57` 负责 reserved计数；`CloneHandleForDelivery:63` 通过 `frame.GetGpuMemoryBufferHandle()` clone。
- 实际分配由 `media/gfx/renderable_mappable_shared_image_video_frame_pool.cc` 的 `FrameResources::Initialize:196` 和 `InternalRefCountedPool::MaybeCreateVideoFrame:315` 完成；没有空闲项才分配。
- 同文件 `OnVideoFrameDestroyed:358–380` 只保留最多2个 available资源，兼容性失配直接销毁。`InvalidateBuffers`/context lost 重建池。不能靠预热3帧保证资源集合固定。

导入现有槽有现成下层 API：

- `gpu/command_buffer/client/shared_image_interface.h:143`：`CreateSharedImage(si_info, surface_handle, buffer_usage, GpuMemoryBufferHandle)`，保留客户端可 clone GMB handle 的能力；`:157` 另有较简的import重载。
- `GmbVideoFramePoolContextProviderImpl::GmbVideoFramePoolContext::CreateSharedImage:61` 当前只用“分配新native GMB”重载，需为外部池增加import入口或专用 Context 方法。
- `gpu/command_buffer/service/shared_image/d3d_image_backing_factory.cc:834–900` 支持 `DXGI_SHARED_HANDLE`：按DXGI token取得 shared handle state，Open纹理并核对实际大小、DXGI格式，建立D3D backing。导入不是像素copy。
- `ui/gfx/gpu_memory_buffer_handle.h:64–132`：`DXGIHandle::Clone` 复制HANDLE但保留token；token标识同一资源。browser已有自己的固定token表即可把 `OnFrameCaptured` 对应到slot，无需在现有逐帧回调新增slot字段。
- `media/base/video_frame.cc:476` 的 `WrapMappableSharedImage` 可用SI的coded size及单独visible rect/natural size包装目的资源。

为避免扩大通用媒体pool影响，可新增 Viz 专用 fixed external `VideoFramePool` 实现，保持普通 pool 原样。固定池持有三个 SI；只从没有VideoFrame lease的项reserve，不额外分配。此处是实施切分建议，并未替主Agent确定类/API设计。

### ExportedSharedImage 形式的具体 owner 边界

主Agent提出一次传入三个预注册 `ClientSharedImage`，同样可行；它比直接传GMB handles更少涉及 Context，但须选对import入口：

|传递形式|实际入口|owner与必要条件|
|---|---|---|
|browser拥有CSI，经ExportedSharedImage给Viz|browser SII用带`surface_handle,buffer_usage,GMB handle`的CreateSharedImage重载注册原槽；`CSI->Export(true)`；新Mojo配置可直接用已有`gpu.mojom.ExportedSharedImage`类型；Viz `ClientSharedImage::ImportUnowned`|browser保留原CSI **及SII**；Viz这份CSI不是backing owning reference；必须直到所有Viz写与Endpoint读都完成后才能释放browser owner|
|Viz拥有CSI，一次传入3个GMB handles|Context中调用in-process SII同一CreateSharedImage import重载；fixed pool/VideoFrame持有owning CSI|无需browser创建mailbox；CSI lifetime自然跟随pool generation/在途FrameCapture。但Context需补import接口；也要保证SII Context比所有CSI活得久|

证据：

- `gpu/command_buffer/client/client_shared_image.cc:743–771` 的 `Export(true)` 带clone的buffer_handle和buffer_usage，`ImportUnowned`重建同mailbox的客户端包装；`.h:277` 明文要求原始backing outlive unowned reference。
- 不可使用默认 `Export()`：它不带buffer，后续 `WrapMappableSharedImage`/clone delivery所需的stride/GMB会缺失。也不能用只收`si_info,GMB`的CreateSharedImage简单重载创建browser CSI后假定Export(true)一定带buffer；应使用保留 `GpuMemoryBufferHandleInfo` 的buffer_usage重载（`gpu/ipc/client/client_shared_image_interface.cc:160–180`）。
- **不可在Viz调用 `sii_in_process_->ImportSharedImage(exported)`**：`gpu/command_buffer/service/shared_image_interface_in_process_base.cc:503–509` 为`NOTREACHED`。owning ExportedSharedImage import只由client SII支持，其实现通过AddReferenceToSharedImage保留backing (`gpu/ipc/client/client_shared_image_interface.cc:300–310`)；不能把这个行为套到Viz。
- browser取得SII有可参考现例：`content/browser/media/capture/desktop_capture_device.cc:1150–1174` 从BrowserGpuChannelHostFactory的现有channel创建并缓存 `CreateClientSharedImageInterface`，loss时重建；本次没有把该依赖接入RemoteKit。对应Browser BUILD依赖也需按实际include补齐。

**Stop/OnStopped不能当作GPU drain。** `FrameSinkVideoCapturerImpl::Stop:523–554` invalidate weak ptr、清delivery_queue后马上发OnStopped；已经交给CopyOutput的FrameCapture仍由回调持有，GPU可能还在写。如果采用browser-owner+ImportUnowned，除了Endpoint consumed，还要有专用pool-generation的在途capture/VideoFrame归零和GPU完成证据，才能回收原CSI/SII。可通过fixed pool state的显式drained控制响应通知browser；如果不补这个barrier，该owner方案不完整。仅让旧pool析构、OnStopped或关闭Mojo管道都不够。

相同问题也适用于失败取消：取消交付不代表GPU写已经停止。owning CSI方案仍需让旧pool state/Context存活至FrameCapture销毁和写访问完成，不用裸pool指针作VideoFrame释放回调；可以参照现有`InternalRefCountedPool`强引用+post回原sequence。不能在重新配置同一组三纹理时让旧GPU请求和新pool同时写同slot。

slot回传无需改opaque callbacks或VideoFrameInfo：Export(true)/GMB clone均保留DXGI token，`CloneHandleForDelivery`本来已交付GMB。browser用配置时三token对照识别slot，拒绝未知token；`Done`仍是原接口，区别是等待**consumed实际完成**才调用。新Mojo配置可一次携带pool generation和slot身份用于校验，但不必在每帧扩字段。

## 像素几何与 padding

需要先纠正输入假设：**当前 ARGB capture 不是 coded1920×1088。**

- `media/gfx/renderable_mappable_shared_image_video_frame_pool.cc:168–177`：ARGB/ABGR的coded size直接返回visible size。
- `browser/gpu_atlas.cc:655–663,749–755` 当前要求coded、content、texture均等于WebView metadata的1920×1080，否则掉帧/报错。
- `source-gpu-cost.md` 中实测capture requested/coded/natural/content/texture也是1920×1080；1936×1088是外侧atlas/编码分配。若后续某binary测到1088 capture，应单独保留其trace，不倒推为当前源码行为。

**保留 atlas1936×1088，在(8,0)写满1920×1080，API支持。** 使用SI size1936×1088、VideoFrame visible_rect=(8,0,1920,1080)、natural_size1920×1080。capturer的 `GetContentRectangle(frame->visible_rect(),source_size,ARGB)` (`.cc:621,1065`) 可得到同一1920×1080 content_rect。BlitRequest offset由它自然取得，scale仍1920×1080→1920×1080，`kLetterbox` 清除左右与底部padding。offset应来自实际布局metadata，不硬编码8；这也支持当前布局的其它正确偏移。

必须补的几何处理：

- 外部池创建时校验atlas包含viewport rect，绝不将 `SetResolutionConstraints` 改为atlas大小，否则oracle可能改变缩放或letterbox。
- `gpu_atlas.cc` 为此模式单独验证coded=atlas、visible/content=metadata viewport、natural=viewport、GMB token属于本generation池。保留旧capture/fallback的严格检查。
- `CanResurrectFrame` (`capturer .cc:1750`) 现用 `marked_frame_->coded_size()==capture_size`。coded atlas大于capture_size时永远不匹配，静态refresh不能直接沿用；专用模式应按visible size/目标pool generation判定，或明确禁用resurrection并重新copy-output。不能盲目改全局比较。
- `ShouldMark` 的几何兼容与 pool generation/target binding也需纳入专用模式，旧layout或旧document资源不能进入新代次。
- 每次 `kLetterbox` 清整atlas会多做padding清除；已有官方实现就是这样，首轮可保留正确性，再独立评估只清一次。直接换 `kDoNotLetterbox` 要先证明目的已经清黑且布局不变，不能靠import的SetCleared标签证明像素已初始化。

因此**不必为目的通路取消guardband**。若主Agent另选native capture池直接导出且不扩目的几何，才需要单plane layout改为原点0、atlas宽1920；为QSV alignment16保留高1088又仍需底部padding目标支持。改动位置会包括`browser/harness.cc`的布局/metadata、`endpoint/include/remotekit/atlas_dimensions.hpp`分配、browser几何检查及viewer映射。DPR2/multi-plane必须保留原布局路径；不能全局把PackAtlas padding改0。本候选无需这些layout改动。

## 初始化与重建

现有时序也应精确描述：`GpuAtlas::State::Import` (`gpu_atlas.cc:574–611`) 收到**首个捕获handle**后选择能够Open该handle的adapter/device，随即 `CreateOutput` 建stage、3槽及ready/consumed fences。`Describe:1054–1094` 在device/ready存在后才一次向endpoint复制3个纹理handle；此前返回“waiting for first GPU capture”。不是输出handle建立后才开始第一个capture。

导入方案可以保留一次普通capture做adapter bootstrap，随后停止旧capturer、配置外部3槽并启动新capturer。首次普通capture不必进入性能窗口；必须有capture binding/generation gate屏蔽旧回调。也可在起始时取得正确adapter LUID预建资源，但该取值路径不在本审计中完成验证，不宜当作已存在机制。

browser↔endpoint可继续使用同一mapping+3 handles+2 fences，无新逐帧IPC。一次 browser→Viz固定池配置需包含generation/3个GMB handles/atlas size/viewport rect（以及必要颜色格式）；Viz crash、resize、slot池替换时重放/重建。ClientFrameSinkVideoCapturer重连要避免把已失效旧pool无条件重放成新成功输出。

reset边界应明确：配置失败不启用该generation；unsupported DPR2/multi-plane在开始前选原capture路径并记录原因。运行中GPU loss、未知token或几何错误停止该generation并走既有资源重建；不能在旧lease未退役时把同槽悄悄切回copy写入。若允许候选失败回到旧capture，必须在新generation显式记录mode/fallback原因。无论哪种回退，均保留Fence路径，不能跳到native窗口输出。

capturer自建导出方案则需“预分配完成返回三handle”控制响应，在该响应之后再向endpoint Describe。通过首3帧逐个收集handle会改变启动语义，且若把这3帧一直lease住就没有可用输出，不能以此代替预分配控制面。

## 真实GPU完成、ready和consumed

### 可复用的完成通路

保留 `populates_mappable_shared_image=true` 有真实GPU完成证据，不是把普通CPU回调当完成：

- `SkiaOutputSurfaceImplOnGpu::CopyOutputRGBA:1177–1199` 在该标志下建立 `ReadbackContextTexture`，延后SendResult。
- `FlushAndSubmitCopyOutput:1390–1421` 将 `ReadbackContextTexture::OnMailboxReady` 交给 `GrGpuFinishedProc`。
- `third_party/skia/src/gpu/ganesh/gl/GrGLFinishCallbacks.cpp:25–57` 的 `add` 插入sync；`check` 必须 `testSync` 成功才消费callback。`GrGLGpu.cpp:4440–4490` 实际为 `FenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE)` / `ClientWaitSync(...,0)` 完成检测（不支持sync的submit分支使用glFinish）。
- `components/viz/service/display_embedder/skia_render_copy_results.cc:181–207` 完成后才 `request_->SendResult`，随后capturer交付browser。

因而成功GPU完成结果抵达browser后，可以在既有browser immediate context上只 `Signal(ready,value)` + Flush，发布同一slot metadata，省掉像素copy。此signal通过硬件队列执行，前提是上述成功GPU完成已得到证实；它不需要假装browser自己的空队列包含了Viz写入。代价是继续经过现有completion观察与回调，首轮不消除这一段延迟。

**必须补失效判定：** `GrGLFinishCallbacks::callAll` 在context abandon/destructor也消费callback；Graphite wrapper目前也忽略 `CallbackResult`。现有 `ReadbackContextTexture::OnMailboxReadyInternal` 即使impl失效仍SendResult。直写候选不能把这些回调都视作成功。可在这里使用现有 `impl_on_gpu_->was_context_lost()` (`skia_output_surface_impl_on_gpu.h:224`) 和impl有效性丢弃结果；若支持Graphite，继续传递真实CallbackResult。当前实测GL/Ganesh可先限制该backend。需同时检查失败flush不发布成功、generation失效不发布ready。这是最小同步patch面之一。

### lease改变

目前browser在 `CopySubresourceRegion` 后Signal ready，等ready实际完成才 `callbacks->Done()` (`gpu_atlas.cc:1019–1026`)，因为此后capture纹理已不再被读取。**直写之后capture纹理就是Endpoint读的共享槽，必须等consumed实际完成再Done。**

可复用browser的 `consumed_->GetCompletedValue()` 与endpoint已有真实GPU退役协议：endpoint所有future read owner释放、实际VPP读取排队后，在其context Signal(consumed,prefix)，browser观察完成后才归还该capture VideoFrame。丢弃且未被发布/读取的帧可立刻Done；已发布帧不得因新帧、stop、导航而提前Done。重建保留旧generation资源直到读完或设备确实removed。

固定池reserve必须由VideoFrame lease决定，而非只看browser publication位。marked/resurrected frame可能额外持有VideoFrame；同一不可变帧重复交付可以多lease，但最后一个Done/marked持有者结束前不可重写。现有首帧3→skip前缀2→生产4的启动退役逻辑仍需验证，不能引入pool/last-frame互等。

### 更早导出原生fence的可选后续

现成Windows原语：`ID3D11Device5::OpenSharedFence`、`ID3D11DeviceContext4::Signal/Wait`；Chromium包装为 `ui/gfx/win/d3d_shared_fence.h` 的 `CreateFromScopedHandle`、`Update`、`WaitD3D11`、`IncrementAndSignalD3D11`。其中Signal真正调用context4->Signal (`.cc:299–318`)。

但没有现成“此CopyOutput结果的D3D ready fence”字段：CopyOutputSharedImageResult保存SI和release callback，不带该GPU原生完成fence/value；`VideoFrameInfo`也未交付它。若要跳过GPUfinished CPU观察，需额外明确的 producer-queue signal/export 扩展，并在正确ANGLE/Skia提交和EndWriteAccess之后signal；不能在另一个browser D3D设备空队列直接signal代替。

已有D3D backing跨设备同步也不能直接拿来当完整协议：

- `D3DImageBacking::BeginAccessD3D/EndAccessD3D` (`.cc:1660–1810`) 内部支持cross-device fences；只在访问它的shared-image representations之间跟踪，外部Endpoint不是该管理器的访问者。
- `SharedImageInterface::UpdateSharedImage(SyncToken,D3DSharedFence,mailbox)` 确实有Windows入口；`SharedImageInterfaceProxy:260` 的实现一次register fence、逐次送value，GPU stub `OnUpdateDxgiFence` 调用manager `UpdateExternalFence`。这是browser→GPU内部通信，允许存在。
- **Viz使用的InProcess SII没有该Windows专用override**；基类实现是 `NOTIMPLEMENTED_LOG_ONCE` (`shared_image_interface.cc:148–154`)。`D3DImageBacking::Update(gfx::GpuFenceHandle)` (`.cc:792`) 还是no-op。不能给in-process普通Update传个fence就宣称已等待Endpoint consumed。
- `D3DImageBacking::UpdateExternalFence` 有真实write_fences入口；若后续要GPU内直接wait consumed，需在受控GPU sequence上正确注册/更新，并验证read/write依赖。这比首轮CPU观察consumed后才归还池增加patch面。

## 最小文件/ABI面与建议切分

|阶段|文件面|完成判据|
|---|---|---|
|A：固定外部目的池|`frame_sink_video_capture.mojom`；`viz/host/client_frame_sink_video_capturer.{h,cc}`；`frame_sink_video_capturer_impl.{h,cc}`；Viz专用pool新文件+BUILD；GMB owner路线补`gmb_video_frame_pool_context_provider{,_impl}.{h,cc}`导入接口，或Export路线补browser CSI/SII与显式drain|一次导入3槽；原visible1920×1080，coded atlas1936×1088，offset来自布局；reserve耗尽不分配第4槽；GPU崩溃重建明确失败/重新配置|
|B：完成成功性|`skia_render_copy_results.{h,cc}`，必要时`skia_output_surface_impl_on_gpu.cc`回调result传递|仅真实成功GPU完成才给非空结果；lost/abandon/flush failure不发布ready；不改变现有提交/轮询节拍|
|C：browser接入|`browser/gpu_atlas.cc`，必要时.h/feature记录|按token识别slot；不调用source→slot CopySubresourceRegion、slot初始化copy；成功结果后signal ready；consumed完成才Done；停机/重建不提前回收|
|D：有界功能与性能验证|现有tools和临时case；根据实际产品变化更新正式状态|先CRC/四角/输入/静止尾帧/背压/resize/root重建/GPU crash，再同binary/profile-off固定52两租户45s对照；原viewport、链路、CRC、QSV参数不变|

共享mapping、browser↔endpoint协议、SDK C ABI、Endpoint/VPP本身无需因“导入既有三槽”改变；源码若真的不触及这些面便不需要增加ABI版本。所有Chromium tracked文件改动仍须按现有patchset清单/hash管理；本审计未生成patch。

真正阻碍只有固定池API/生命周期与失败完成判定；目的图像格式、offset和尺寸已有直接通路。性能收益仍待测：本次没有硬件验证“1936×1088外部非keyed槽作为Skia目的”以及零copy后的吞吐，不能把sourceBrowser约11.5%全数预记为节省，也不能保证这一步就达50FPS。
