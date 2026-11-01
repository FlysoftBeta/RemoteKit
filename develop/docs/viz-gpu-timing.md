# Viz paint 的真实 GPU 批次计时

2026-11-01。已补齐 child 页面 pass 和最终 offscreen root 的现有 paint flush GPU 计时，并完成两租户固定40fps实播。两者都有实际 GPU 成本：child 每批次中位数约1.49ms，root约1.04ms。最终root没有Present，仍执行一次全尺寸绘制；它是下一轮有界优化对照的合理候选。当前数据没有发现DPI放大或MSAA，也不能把100ms左右的完成回调等待解释为100ms绘制。

## 已落实的测点

沿用默认关闭的 `RemoteKitCopyOutputProfile`，没有新开关、额外 flush、submit、同步等待、绘制或资源生命周期变化。

- child：`SkiaOutputSurfaceImplOnGpu::FinishPaintRenderPass` 的第一处 `gr_context()->flush(surface, ...)`。这是 paint ops 的 flush；随后 `ApplyBackendSurfaceEndState` 和第二次 cleanup/semaphore flush 保持原逻辑。
- root：`FinishPaintCurrentFrame → ScopedPaint::Flush → SkiaOutputDevice::Flush` 的原 flush，在 Vulkan/`on_finished` cleanup 组合之后附加 stats。原 plain/stats finished callback 与 submitted callback 各自转发一次，独立管理上下文；保留 abandoned 快路径 plain callback。
- 每批记录 scope ID、output/context/surface 身份、实际 SkSurface 宽高/色型/sample count、backend、stats支持、semaphore数量，以及 CPU flush begin/return、submitted/finished trace 时间戳和 GPU elapsed。sample count来自 `SkSurface::characterize`，没有使用会隐式flush的backend-handle接口。
- 同一 output 的 frame 序号在 `SwapBuffers[Skipped]` 收尾；child另记序号/mailbox/update rect。它是本地关联身份，不等于Viz numeric render-pass ID。CopyOutput flush事件也带同一frame/context，可关联同帧的捕获批次。
- Graphite paint和Vulkan secondary-CB明确记录不支持此paint测点；GPU elapsed不支持、零值或没有finished均为缺测。默认关闭时不取surface characterization/stats、不分配callback、不读计时时钟。

改动属于 `0002-copy-output-profile.patch`。只替换该补丁拥有的 `on_gpu.{cc,h}` 片段，原有其他片段（包括与0001重叠的capturer）保留，新增device/helper/BUILD片段。没有错误地以完整HEAD diff追加成新补丁。本次计时版本0002 SHA256为 `67f7b490d05b5c679fd0c63be667526ed6fadb80f62257c9b382ad58536d796c`；后续root捕获批次修正abandoned分支仅转发原plain callback，最终hash及再次重放结果见[root捕获报告](root-capture-runtime.md)，本报告计时证据仍对应原指纹。

## 固定40fps实播

有效组为 `develop/tmp/viz-gpu-fixed40-t2-r2`。两租户，原Canvas fixture、1920×1080/DPR1、1936×1088 atlas/编码，CRC 1Hz；TU7/VBR/depth1/LowPower ON、36/max44Mbps，每peer48Mbps/RTT10ms；receiver Chromium157.0.8103.15、精准fake60、默认video/snapshot。source固定40fps、adaptive关闭，暖机1秒、测量10秒，OfficialTrace/CopyOutputProfile/ServerTrace/ResourceProfile开启。没有并发构建、GPU实验或桌面操作。

source JS39.63/39.94FPS；实际canvas28.85/27.56FPS，marker p95 287/247ms，CRC invalid均0。这是诊断profile组，不能替换profile-off的性能成绩。两份官方JSON完整，覆盖10016.4/10014.8ms的整个实际测量窗。

实际DrawRenderPass：Session1页面id2/6quad和root id1/1quad各396次，Session2各400次，没有额外60/120Hz重复整帧。trace未发现NativeViewGLSurfaceEGL/SwapChainPresenter/Present输出。

### 实际 GPU 目标

|scope|两个Session的实际SkSurface|sample count|context|
|---|---|---:|---|
|child|1920×1088、BGRA8888（SkColorType=6）|1|每Session与其root相同的GrDirectContext|
|root|1920×1080、RGBA8888（SkColorType=4）|1|每Session独立context|

child有8行分配padding，面积比1920×1080多0.74%；没有150%宿主DPI造成的大图、F16或MSAA。网页和capture的有效内容尺寸仍是1920×1080。

### 每批次耗时

表中为毫秒p50/p95；只纳入flush begin和finished callback都落在测量窗内的完整批次，因此child/root样本数为395/395、400/400，边界晚回调不会拿来估帧率。CopyOutput完整请求为395/398。

|阶段|Session1|Session2|
|---|---:|---:|
|child GPU elapsed|1.491 / 1.911|1.499 / 1.898|
|root GPU elapsed|1.039 / 1.347|1.046 / 1.356|
|CopyOutput GPU elapsed|1.001 / 1.532|1.009 / 1.531|
|child CPU flush调用|1.110 / 2.320|1.225 / 2.163|
|root CPU flush调用|0.590 / 1.873|0.649 / 1.826|
|child submitted→finished回调|17.673 / 110.601|16.730 / 100.897|
|root submitted→finished回调|28.157 / 120.237|26.673 / 110.253|
|CopyOutput Created→SendResult|30.522 / 136.553|27.977 / 120.475|

child GPU elapsed均值1.522/1.511ms，root1.046/1.072ms，CopyOutput1.055/1.096ms。Ganesh elapsed是现有flush批次的GPU timer区间，可含之前未flush的工作和依赖等待；并非shader指令纯busy时间。CPU callback时间也不提供GPU硬件起止锚。

renderer device query仍存在：MainThread各469/473段，p50/p95=0.987/1.912ms、0.972/1.724ms；RasterWorker p50约0.015/0.016ms。它们和Viz/CopyOutput属于不同计时边界，可能重叠或含上游依赖。**不将这些时长机械相加、不从进程占用减出“剩余Viz耗时”**。两个paint测点分别证明了实际批次成本，足以否定“root不Present就没有GPU绘制成本”。

## 总3D与未归属PID

全机3D98.593%，source GPU41.331%、source browser8.154%、Endpoint11.147%、receiverGPU24.004%。新采样把原来不明的差额落实到PID：主要为dwm10.732%、WUDFHost2.636%，另System0.293%、Code0.239%，本组均有10个记录样本。不把别组未保存的差额追认为这些进程。

资源分析字段已从 `windowMeanPercent` 改为 `observedContributionPerRecordedWindowPercent`，明确是已观察贡献除以记录窗口样本数；缺实例/采集失败区间不是测得的零，也不估算缺失期间的真实利用率。原 `presentSamplesPercent` 继续保留。

## 构建、复现与产物

- 复用out/dev增量构建 `remotekit_browser` 通过，全部16逻辑核，最后一轮93 steps/47.13秒；没有动out/rel、SDK ABI或endpoint产品代码。源码组件构建使exe hash仍可不变，实际新 `components_viz_service.dll` SHA256为 `0A233C7CF2178CFC52249A1AE21FD4F385916CA94976AE6B0D64C8DBEE0A8B01`。完整指纹保存在case。
- patchset status六项applied。独立临时树从官方HEAD应用六patch、全部25路径与live源码一致、逆序撤回精确恢复，通过。日志 `develop/tmp/viz-gpu-patch-replay.log`。
- `tools/analyze-viz-gpu-profile.py --case CASE` 输出逐批关联与完整窗/全trace统计，旧trace无新事件时返回空scope，不伪造零耗时；Python编译检查通过。资源工具在有效case分析通过。
- case含 `viz-gpu-summary.json`、`copy-output-summary.json`、`device-summary.json`、`draw-summary.json`、`official-trace-summary.json`、`resource-summary.json`、原metrics/trace与指纹。
- 首组 `viz-gpu-fixed40-t2` 在官方trace大JSON仍导出为.tmp时停止，trace不完整，保留为失败组，不用于上述计时结论。重跑等待两份.json完成后再停止。

所有自有Control/source/Endpoint/receiver已关闭，host browser_close已执行，CPU/GPU窗口已释放。未commit/push，由主Agent统一收尾。
