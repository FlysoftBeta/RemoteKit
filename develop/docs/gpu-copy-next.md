# GPU copy 路径核查与下一步候选

2026-11-01，只读源码核查；没有改运行代码、构建或运行GPU实验。范围是当前离屏路径，参考本地Chromium 157及`C:/src/tmp/electron-investigation/cef/libcef/browser/osr/`，未读取旧RemoteKit仓库。这里给局部实现候选，最终路径由主Agent选择。

## 结论

当前一次正常新像素更新包含：官方capture输出一次Skia绘制；browser source→stage一次页面大小copy；stage→shared slot一次全atlas copy；Endpoint shared slot→private pool一次全atlas copy；private BGRA→NV12一次全幅VPP。browser正常不逐帧清空stage。单plane也走完整三次BGRA copy，并没有服务端单plane直写快路。

**AtlasPool没有每次media loop重复cache copy。** `Poll()`在新frame提交一次copy后记录`last_frame`，相同frame直接idle。VPP也不随1ms媒体轮询重复执行，它跟随RTC编码job；尾IDR/refresh会重新VPP，hardware busy后重试同job也会重新VPP。

最清晰的第一项局部实验是单plane source直接写共享slot，省掉一个全atlas copy；Endpoint直接消费共享slot的改动更大，当前长期保留latest帧和单调consumed fence使它不能靠删一行copy实现。

## 精确工作量

定义每个页面capture尺寸面积为`P_i`，源capture回调频率为`f_i`；atlas面积为`A`，browser发布频率为`f_a`，Endpoint接受的新发布频率为`f_c`，实际进入转换的编码job频率为`f_e`，编码NV12分配面积为`E=align16(w)*align16(h)`。同一Tenant多plane与四Tenant各单plane要分开计算。

| 阶段 | 每次像素范围 | 频率/条件 | 源码证据 |
|---|---|---|---|
| 官方capture | 整个capture输出`P_i`，不是damage范围 | 非resurrect的capture | Chromium `frame_sink_video_capturer_impl.cc:1238–1300`，`skia_output_surface_impl_on_gpu.cc:1030–1197` |
| 官方capture清屏 | `P_i`全幅黑色；非opaque源还可能在RenderSurface clip内透明clear | 同上 | `CopyOutputRGBAInTexture`的kLetterbox；`RenderSurface:1216–1226` |
| source→stage | `P_i`全幅，destination为该view的atlas x/y | 每个接受的capture，`Σf_i P_i` | `browser/gpu_atlas.cc:665`，没有source box |
| stage→shared | `A`全幅 | dirty且过输出节拍且存在consumed可用槽，`f_a A` | `gpu_atlas.cc:692–742` |
| shared→private | `A`全幅 | 新frame且private槽空闲，`f_c A` | `endpoint/src/media/atlas_pool.cpp:205–238` |
| private→NV12 | 读整个源atlas，按协商尺寸等比缩放并转换；写编码output target | 每个worker job，`f_e` | `gpu_device.cpp:34–109` |
| stage白色clear | `A`全幅 | 创建输出、view新增/删除/布局/文档或宿主identity变化 | `gpu_atlas.cc:235–346,407–435`；非每capture |

VPP无单独`CopyResource`或显式逐帧ClearRenderTargetView。它使用一个`VideoProcessorBlt`完成颜色转换、缩放、背景；分配尺寸16对齐，output target是实际编码尺寸。驱动内部读写/编码参考面不在这些源码API计数内。AtlasConsumer的window demo还有一次显示clear/draw（`endpoint/src/atlas_consumer.cpp:453`），`service.cpp`的串流路径使用AtlasPool，不调用该显示路径，不能将demo clear加到正式串流计数。

以现有单1080布局的`P=1920*1080=2,073,600`，`A=1928*1088=2,097,664`为例：每帧source copy 8,294,400B，两个atlas copy各8,390,656B。四Tenant各50FPS时，这三次copy合计约5.015GB/s单向payload，按每copy一读一写是约10.030GB/s逻辑流量；不含官方capture、VPP、编码和接收端。删去一个atlas copy对应约3.356GB/s逻辑读写。NV12编码1928×1088时分配1936×1088，约3,159,552B/面。这些是操作面积推算，不是实测DRAM带宽，不能据此断言内存带宽是瓶颈。

多plane每个回调只copy该plane到stage，但每次发布和Endpoint copy都覆盖整个atlas。多个不同步capture可能在不同输出节拍各触发全atlas发布；`fps_`限制的是atlas发布，不是每view都达到同频率后的一个联合快照。空白、padding和静态plane照样参与这两个全atlas copy及VPP。多个页面共用最大DPR采样密度时，`A`还可能包含放大后的低DPR页面。

## Context与完成边界

1. Chromium renderer/Viz/GPU负责合成与capture。`kPreferMappableSharedImage`的ARGB由官方pool直接写已有共享图像（`frame_sink_video_capturer_impl.cc:1468`）；DidCopyFrame不再复制一遍CPU像素。`MappableSharedImageVideoFramePool::CloneHandleForDelivery`导出GMB handle，不Map。虽然D3DImageBacking有staging readback函数，当前调用链没有调用它，不能额外计入一次CPU回读。
2. `browser/gpu_atlas.cc:440–478`创建bridge独立D3D11 device/immediate context，匹配能够导入source的adapter。每capture OpenSharedResource1并校验BGRA/尺寸/单面/keyedmutex，`AcquireSync(0,0)`不阻塞等待，失败会drop并为静态页10ms后RequestRefresh。
3. source→stage后`Signal()`写ready fence并Flush；同回调可能立即stage→slot、再次Signal并Flush。因此一个capture加一个publication有两次bridge Flush。source lease在`Poll():763–770`观察真实ready fence完成后才Done。ReleaseSync不代替该lease。
4. Endpoint每Session/AtlasPool首次创建一个带VIDEO_SUPPORT的D3D11 device，开启multithread protection；新generation复用同device，adapter变更明确要求peer rebuild（`atlas_pool.cpp:104–145`）。private cache、VPP和QSV使用这个device的**同一个immediate context**，不是三个独立GPU队列。
5. AtlasPool先GPU Wait(ready)，再copy、Signal(consumed)、Signal(private done)、Flush；CPU每次Poll观察done完成后才向SDK交frame。提前排入尚未ready的新帧Wait能阻挡同context上旧帧VPP，已有ready-gate实验已确认；现有试验没有稳定端到端收益，不能把它重新列成已有效优化。
6. VPP每job创建input/output view，Blt→Signal本地fence→Flush→新建event→SetEventOnCompletion→CPU等待最长5秒。只有真完成才返回`SafeToRelease=true`。因此编码worker不能在VPP未完时提交同job的QSV，async depth也不会并发多次Convert调用。
7. browser默认2ms timer轮询source lease和dirty发布，Endpoint约1ms轮询private done，QSV Poll用2ms SyncOperation。它们都是完成观察/任务节拍，不能当成GPU执行耗时。现有分段trace的private copy和VPP耗时包含排队及观察。

## 编码surface和静态帧生命周期

`EncoderWorker::Configure`建立`async_depth`个NV12 texture和free列表（当前实验d1）。Enqueue给BGRA texture AddRef并调用atlas lease retain；仅保留一个pending job，替换pending会release旧job。Convert完成后BGRA已不再被VPP读取，但目前job仍持有BGRA lease直到编码Complete。

QSV `Submit`用NV12 texture作为外部allocator MemId，不在RemoteKit代码里copy输入；`MFX_ERR_MORE_DATA`也算接受，放入held并保留texture。`Poll`完成SyncOperation，按timestamp找对应输入并检查Locked后才完成。worker Complete归还NV12 free槽并release BGRA（`encoder_worker.cpp:117–143`，`qsv_encoder.cpp:215–299`）。NVENC同样是注册/映射NV12后编码，完成event及unmap之后归还；没有这台硬件的性能证据。

`service.cpp:667–705`长期retain latest private BGRA。fresh帧更新latest，初次连接/refresh/一次tail会重新提交latest，旧capture时间与layout epoch保留，SDK分配新媒体/RTP时间。尾帧**不会再触发AtlasPool copy**，但会再次VPP和编码。`idle_sent`限制一次尾提交；`refresh_connected`有独立提交理由。更换generation时AtlasPool把旧State放retired，直到refs和GPU fence都安全才销毁。

## 候选顺序（最多五项）

### 1. 单plane source→shared slot，移除稳态stage→slot

收益明确：每个新发布少一次全atlas copy；source大小copy仍保留。最小文件归属`browser/gpu_atlas.cc`（必要时头文件trace字段），不改SDK/shared ABI。仅在一个有效view且几何固定时选择；shared slot的padding初始化一次，source按现有x/y直写，真实ready Signal在copy之后，capture callbacks仍等待其读取完成。

不能先写无空闲槽。节拍未到/槽满时最多retain一个尚未提交GPU读取的最新capture，替换尚未提交者可Done；提交者必须走真实GPU完成回收。不能把旧dirty逻辑直接套上：静态页不会必有下一callback，Poll必须负责把待处理最新capture发布。metadata/focus/text/stale变化需要保留最新像素：可以保留最新shared slot作browser自己的只读基底，罕见metadata-only发布时复制到另一个空闲slot，或明确回到stage路径。不得把当下last-frame像素的槽覆盖成新代元数据而让旧consumer继续读。多plane继续现有stage；1→2→1变化作为新generation/完整初始化边界处理。

验证：诊断counter确认单plane稳态source-copy=accepted capture、stage→slot=0、padding clear仅初始化，copy少一项而atlas/编码尺寸不变；静态首帧、slot全忙后最终最新帧、tail、metadata-only输入焦点/IME caret、关闭view、desktop↔tablet/mixed-DPR和device recovery回归；profile-off在相同四1080 render16及随后50/60Hz组对比GPU busy、真实canvas FPS、marker p95。保留同样Chrome89/marker/RTT/码率，不能只报告bridge CPU变短。

### 2. source→stage使用capture damage，保留掉帧后的全帧补齐

`VideoFrameMetadata.capture_update_rect`已存在，Chromium `frame_sink_video_capturer_impl.cc:1076–1092`生成；CEF `video_consumer_osr.cc:108–124`明确规定它相对紧邻CAPTURE_COUNTER，缺帧必须全帧。当前browser完全忽略它。最小文件仍`browser/gpu_atlas.cc`，为每Capture记录上次**实际写入stage**的counter和geometry；只有counter连续、damage合法、stage该plane已有效时使用D3D11_BOX copy脏矩形并加atlas偏移。任何drop、mutex busy、重启、clear、generation/geometry变化做完整copy。

收益只覆盖source→stage，两个全atlas copy和官方capture全幅不变；全屏canvas动画往往damage全幅，须先统计实际damage面积比例。验证局部marker+静态背景、滚动、全屏动画、故意drop与多plane异步更新，逐像素/marker确认无旧区域残留。若实际damage接近100%，不用继续这一候选做吞吐主线。

### 3. 官方capture exact-full-output免去冗余letterbox clear

当前官方BlitRequest一律`kLetterbox`，即使content_rect完全覆盖pool目标也全幅清黑；随后RenderSurface还可能透明clear。可有界测试仅当`content_rect==gfx::Rect(frame->coded_size())`时用`kDoNotLetterbox`，保留RenderSurface既有alpha语义。最小边界Chromium `frame_sink_video_capturer_impl.cc`和仓库patchset/manifest/hash；不改任何完成callback/同步机制。

省的是一次全capture面积clear的API工作，driver可能已优化clear，不能预估FPS收益。带letterbox、缩放、透明内容、capture overlay、重用pool面的新旧像素校验必须覆盖。直接把RenderSurface clear也一并删除不在此最小试验内，它有透明源混合和Chromium已注明的Skia兼容原因。

### 4. Endpoint共享slot直接VPP成自有NV12，替代private BGRA copy

理论上少一次`A`全幅BGRA copy，VPP可直接读取imported BGRA texture；当前共享texture带RENDER_TARGET/SHADER_RESOURCE，仍需真实CreateVideoProcessorInputView硬件验证。**不是AtlasPool::Poll返回shared texture就完成。** consumed fence应在VPP实际读完之后、并保持累积值可安全释放所有更早槽时才Signal；不能在SDK接受或CPU release时Signal。

最大现有冲突是latest长期lease：若保留共享slot N作为静态/latest，而Signal consumed>N，则browser会认为N已可重写；若不Signal更高值，三个slot很快全满。SDK/worker也会同时持有queued/inflight job，释放顺序不保证等同publication顺序。可实施方向是VPP完成后立刻归还共享slot，Endpoint保留自己的NV12作为tail/refresh像素，并为编码/最新NV12建立单独lease。它需要改变输入format边界、跳过已NV12的converter及latest管理，范围至少`atlas_pool.{cpp,hpp}`, `encoder_worker.{cpp,hpp}`, `service.cpp`，可能`remotekit_rtc.h`/SDK TextureBuffer格式标识；由主Agent先固定接口。新generation/peer close必须同时drain VPP、SDK leases与NV12编码引用。不是第一项小改。

验证除了第一项通用组，还需强制SDK迟持有、job替换、VPP busy/设备丢失、out-of-order CPU release、静态长时间多次refresh、尾IDR、重新协商/尺寸变化；shared槽在consumed前用不同pattern重写检测必须为零。真ready和consumed GPU完成都保持，不新增browser↔endpoint逐帧IPC。

### 5. 同job hardware busy重试复用已完成NV12，减少重复VPP/对象创建

`encoder_worker.cpp:164–201`先Convert再hardware Submit；busy把job放回queue，下一轮又Convert。可以增加converted状态和占用NV12 surface的明确所有权，busy时只重试Submit；新job取代它时释放converted槽。该现象是否频繁要先由existing trace统计`vpp_submit`/cookie与`hardware_submit=busy`，正常d1硬件空闲组可能为零。input/output view和completion event也可按texture/enumerator缓存，避免每job创建；这是CPU/API开销，不应称消除全atlas copy。

最小边界`encoder_worker.{cpp,hpp}`，若缓存view/event则`gpu_device.{cpp,hpp}`。验证busy注入/真实busy时VPP每cookie最多一次，queue替换和error退出不泄漏surface，全部lease仍在真GPU完成之后回收。此项不移除VPP CPU wait；QSV/NVENC对外部前置GPU写入的正式同步契约未核实前，不靠相同device的猜测删wait。

## 不建议混入本轮的捷径

Windows直接切`kPreferSharedImageWithNativeHandle`不能照抄Linux：当前Chromium仅Linux将它纳入`prefer_shared_image`，Windows ARGB DidCopyFrame也CHECK现有mappable枚举；更关键的是现有GMB路径在GPU完成后才交consumer，改为提前交handle必须建立真实跨context写入依赖。保留HANDLE或现有keyed mutex尝试都不自动证明Skia写入完成。该变更横跨官方capture与D3D同步，不能以省完成callback名义直接启用。

多plane共享slot若只更新dirty plane也需要按每个slot记录自己的content版本：三个slot不是同步的完整底图，直接把本次damage覆盖到任意空闲旧slot会丢掉中间更新。必须累计该slot遗漏的所有damage，遇generation/layout/metadata边界全量初始化；否则仍需复制最新全atlas基底。这个问题不影响候选2的单一stage增量更新。

本报告的操作清点是源码确认；GPU节省与目标达标仍需上述同组运行实验。此前render16分段报告已把接收端native播放等待列为主要延迟段，因此删copy有吞吐潜力，也不意味着单靠它能消掉接收端p95。
