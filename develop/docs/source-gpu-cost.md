# 源GPU负担：普通动态页面、两次Viz绘制与未覆盖的GPU区间

2026-11-01。页面属于普通的1080p动态Canvas绘制，没有复杂3D、滤镜或大范围像素读回。现有“source GPU进程占3D约60%”不能解释为“网页本身需要60% GPU”。本轮已测到renderer命令上下文和CopyOutput批次的实际GPU计时，但尚未覆盖Viz页面render pass及最终offscreen root绘制。下一步应补这两个现有flush的计时和实际目标尺寸，再决定删哪一步；不继续凭进程占用猜测。

## 本轮固定40fps诊断

唯一串流组 `develop/tmp/source-gpu-fixed40-t2`：两租户，原fixture、1920×1080/DPR1、1936×1088 atlas/编码、CRC 1Hz、TU7/VBR/depth1/LowPower ON、36/max44Mbps，每peer48Mbps/RTT10ms，receiver157.0.8103.15精准fake60。只将源pacer固定40、adaptive关闭，启用已有OfficialTrace/CopyOutputProfile/ServerTrace/ResourceProfile。暖机1秒、统计10秒；两个Session官方trace都覆盖完整统计窗口。没有CPU构建、并发实验、桌面操作或fixture修改。

Endpoint SHA256 `BFFE36417FBCF2445F73CA5BC0A0330F51F15FD87F0007346D9ABA48645A9CF4`；source browser `7AD9D280B570EAF9B2C439C64550CB230AE3083940DE0878917600512A2BC168`；fixture `4CB517D8BD239E64C79C6D26D66E8FA0E374062046B43EF9813089A2874585F1`。完整指纹见case。

source JS实际40.05/39.96FPS，canvas27.06/26.47FPS，marker p95 251/239ms、CRC无效0。全3D99.41%，其中source GPU42.10%、source browser9.07%、Endpoint12.12%、receiverGPU25.14%。profile显著加重负担，不能用该组替换此前profile-off的35/31FPS、p95 91/99ms成绩；本组用来定位工作与等待。

## fixture和像素尺寸

`control/public/test-pattern.html`每帧清填1920×1080一次、画一个200×220移动矩形、约20行含变化帧号的文字、112个marker小矩形，并更新一个短label。scene.width/height只在viewport/DPR变化时赋值；DPR1时没有隐含重复resize。源端没有getImageData、toDataURL或逐帧CPU像素传输。接收端另有每秒一次256×112 CRC同步读回，它会占共享GPU，不能算作源网页绘制。

trace存在RendererMainThread和RendererRasterWorker的非零GPU query区间，以及GPU进程RasterCHROMIUM解码；这证实源渲染使用GPU命令路径。现有trace未给两个Canvas各自的resource身份，不能进一步将每个query命名为scene或marker专属。

58份实际renderHost快照全部为hostDeviceScaleFactor=1、hostWidthPixels=1920、hostHeightPixels=1080、configuredFps=40。ServiceScreen固定DSF1；OffscreenHost::SetBoundsInPixels经OnHostResizedInPixels/WindowTreeHost::UpdateCompositorScaleAndSize向compositor传1920×1080/DSF1。capture实际requested/coded/natural/content/texture全部1920×1080，BGRA格式87，atlas在外围加padding到1936×1088。

因此当前没有宿主DPI放大证据。官方trace没有最终SkSurface分配尺寸字段，下一测点仍应记录实际root/child surface宽高、sample count、render-pass output_rect和scale，闭合到GPU目标。

## 实际每帧工作

两个Session统计窗内Viz DrawRenderPass分别为：页面pass id2、6个quad，401/400次；root pass id1、1个quad，400/400次。实际JS约40FPS、两个pass各约40FPS，没有额外60/120Hz重复画整帧的证据。两个pass不代表各自都很贵；当前CPU scope不能替代GPU执行计时。

源码中CreateVideoCapturer瞄准RenderWidgetHostView的子FrameSink；每WebView还有自己的Aura root/offscreen输出。当前页面pass、CopyOutput目标绘制和最后root单quad输出确实是不同步骤。是否能通过捕获每WebView root、让child合并来消除独立页面pass，是候选方向，尚未做对照，不能先宣称收益。

browser bridge实际处于SinglePlaneDirect：source_stage_copies=0、stage_slot_copies=0、direct_metadata_copies=0；source_slot_copies为628/535（含正式窗外），三槽分别初始化一次。正常每个成功发布帧只做一次1920×1080 BGRA capture→共享槽CopySubresourceRegion，再发GPU ready Fence；不是旧staging再整atlas拷贝。该工作归source browser的D3D设备进程，不属于source GPU进程62%那个计数。

随后Endpoint仍有共享槽→私有cache GPU copy、外部VPP BGRA→NV12、QSV编码。它们属于Endpoint计数。没有发现源端额外BGRA↔NV12转换，亦没有旧NativeViewGLSurfaceEGL/DXGI Present/SwapChainPresenter事件。

## GPU计时覆盖与等待

每Session都有399个Created和SendResult完整落在统计窗内的CopyOutput请求。以下为同请求p50/p95，毫秒。

|阶段|Session1|Session2|
|---|---:|---:|
|Created→GPU dispatch|2.481 / 4.111|2.271 / 3.976|
|dispatch→FlushBegin|0.874 / 1.581|0.804 / 1.458|
|flush CPU调用|1.115 / 2.140|0.876 / 1.840|
|flush返回→submitted callback|1.375 / 2.589|1.112 / 2.292|
|submitted→finished callback|20.350 / 69.368|18.792 / 80.378|
|GPU flush-batch elapsed|1.028 / 1.438|1.021 / 1.370|
|Created→SendResult|26.103 / 75.154|24.295 / 86.220|

batch elapsed均值1.158/1.033ms，Ganesh/OpenGL、semaphore0；全部有submitted callback，没有新增强制submit。它只覆盖CopyOutput那个flush批次，可以包含之前未flush工作；没有CPU时间轴上的硬件起止锚，不能直接将其与renderer query相加或用差值算纯等待。

`disabled-by-default-gpu.device`另提供renderer上下文的query起止。Session1 RendererMainThread共466段、Session2共470段：Session1 b/e464段合计669.126ms，X2段2.065ms；Session2 b/e470段合计795.234ms。RasterWorker为S1 b/e405段8.432ms加X1段0.012ms，S2 b/e405段19.745ms。每段main p50约1.04–1.06ms，raster p50约0.016–0.017ms。

这些是GPU timer区间，可能包含区间内依赖等待/调度，不是shader指令纯执行。它们覆盖renderer命令上下文，当前没有Viz输出上下文的同类计时。每个Session累计区间长度约占各自10秒窗口6.70%/7.94%（main），0.084%/0.197%（raster）；这是timer长度比，不能视为物理GPU占用分摊，不能据此把剩余42.1%减出来叫Viz耗时。CopyOutput batch与这些区间是否重叠/包含上游依赖，现有计时无法完全消除。

明确能判断的是：CopyOutput的75–86ms尾部不是同批次75–86ms纯GPU执行。submitted→finished含GPU排队、执行和完成检查；完成callback本身并不提供硬件ready时刻。既有PerformWork任务迟到证据仍适用其原组，本组没有把全部余量归为completion poll。

## 最小下一测点与可落实改进

由主Agent决定实施，仅建议新增默认关闭的profile，不改变submit、poll、lease或Fence语义：

1. 在SkiaOutputSurfaceImplOnGpu::FinishPaintRenderPass记录render-pass id、SkSurface尺寸/色型/sample count、GrDirectContext及output-surface身份，并在其**第一处**`gr_context()->flush(surface,{})`附加GPU elapsed stats。该处先flush paint ops，后续带cleanup/semaphore的第二次flush可能已没有实际绘制；只测第二处会遗漏主要GPU工作。保留第二flush的原callback/所有权。
2. 在FinishPaintCurrentFrame→SkiaOutputDevice::Flush这条现有root flush附加同样的GPU elapsed stats，记录实际root SkSurface尺寸。使用同一frame序号/输出身份连接child pass、CopyOutput request和root；回调必须转发原cleanup且只消费一次。不要额外flush或同步等待来方便计时。
3. 保留现有renderer query、CopyOutput request stats。通过context身份和原有flush边界说明覆盖，报告独立批次，不把重叠时间机械相加。若需要定位硬件开始时刻，应另用同context timer/query锚；仅新增finished CPU时间仍不能拆排队与观察。

若root/child实际目标大于1920×1080，应先修该放大。若最终root单quad有明显GPU耗时而输出只被丢弃，再做捕获root/合并pass的有界对照，保持网页、CRC、BF cadence和分辨率。若CopyOutput批次才是主耗时，可考察现有mappable shared-image blit直接写共享输出槽，从而省browser bridge一次copy；这需要同时设计GPU完成/lease与consumed Fence，不是简单提前返回callback。现有证据尚不足以选定这项较大改动。

纯capture ablation必须保持源BF/renderer继续40FPS；当前output stop与render demand关联，不能把它作为“关capture但保留渲染”的对照。

## 总3D与role差额

原两租户adaptive on：总86.949642%，owned73.965770%；sourceGPU31.365559+sourceBrowser6.730768+Endpoint9.916669+receiverGPU25.952774恰等于owned。差12.983873个百分点（每秒11.72–14.62）来自本case未归属PID的计数器，不是receiverBrowser漏列，也不是聚合分母问题。三租户全ON对应差8.551077个百分点；本次profile差10.979364。

旧采集器只保存owned逐PID及全机engine总数，不能事后识别差额具体PID，也不能把它自动称作用户程序/DWM/宿主。已补诊断工具：watch-streaming-resources.ps1另存unownedGpu逐PID/engine/占用、可读取的进程名及名字观察时间；读取失败保留PID和null名字。analyze-streaming-resources.py输出逐PID汇总、出现样本统计和全窗口均值。旧结果不回填，不改原role字段，不读取命令行、不停止未知进程。

PowerShell语法解析、Python py_compile、两样本聚合（含缺名字/缺实例）、已有case兼容分析通过。另做5秒空闲counter smoke：5份样本、无GPU采集错误，全部engine的unowned逐PID和+owned精确闭合到total（误差<1e-6）。新数据保存在 `develop/tmp/source-gpu-cost-toolcheck`，不属于串流性能组。

## 产物与结束

case保存config、fingerprints、原metrics、source/browser/server trace、CopyOutput分析、官方trace分析、device-summary.json、draw-summary.json和resource-summary。源码、Chromium补丁、fixture及产品配置均未改；仅修改两个诊断工具和本文。所有自有Control/source/Endpoint/browser已结束，host browser_close已执行，没有build、commit或push。

