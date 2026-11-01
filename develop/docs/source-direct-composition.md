# Source DirectComposition auto/off 对照

**关闭DComp保留了真实GPU捕获与H264，但把阻塞转移到传统窗口呈现，未改善最终canvas FPS。默认保持auto。** 下一轮改为真正offscreen root output，不能把此次开关作为完成优化。

## 实现及固定条件

Endpoint新增 `--browser-direct-composition=auto|off`，默认auto，其他值立即报错退出1；off只给Session source browser追加标准 `--disable-direct-composition`。`prepare-streaming-case.ps1 -BrowserDirectComposition auto|off`记录配置、endpoint参数、指纹；service日志记录真正browser启动命令。接收端Chrome89和native demo不加该开关。不改Present flags、poll、GPU完成、capture lease或Fence。

本轮新Release service统一SHA256 `7463352be205c3315f565d387f5e525dccfa3dac8e8308e3daa730e1ee36023e`。所有组用同一service；browser/SDK/fixture/client来源见各组fingerprints。4×1920×1080/DPR1，d1/TU1/VBR，snapshot，capture cap/ready gate off，各peer独立24Mbps/双向5ms，默认client flags，5秒暖机+20秒采样。未改宿主DPI、viewport或source根物理尺寸。

## 结果与停止条件

先跑 `dcomp-off-profile1080x4`（marker0、OfficialTrace+CopyOutputProfile）。四Session均收到video/H264、QSV编码，GPU Ganesh/OpenGL计时有效；4份trace的DXGISwapChainImageBacking::Present均为0，开关路径生效。

S4 trace与正式窗口有交集的完整request154个，Created→SendResult p50/p95 **240.507/341.428ms**；GPU dispatch前11.183/47.185ms，flush CPU1.107/14.323ms，flush return→submitted1.440/2.703ms，submitted→finished201.281/330.696ms，batch elapsed0.846/1.190ms。它不与此前不同service/marker配置合并成性能收益。

再跑profile关闭的同binary首对 `dcomp-auto1080x4-a` → `dcomp-off1080x4-a`，marker1Hz。每租户19–20个CRC有效同RTP marker；全部visible。下表为租户范围，并非置信区间。

| 阶段 | auto | off |
|---|---:|---:|
| Source renderer render/s | 20.2–20.5 | 23.1–23.6 |
| Browser capture callbacks/s | 19.7–21.6 | 22.2–23.7 |
| Endpoint atlas copies/s | 20.2–20.4 | 23.0–23.4 |
| Encode/s | 12.1–12.8 | 13.0–14.6 |
| Decode/s | 12.0–12.7 | 12.9–14.4 |
| 实际canvas绘制提交/s | 8.29–9.74 | 8.15–8.89 |
| 同RTP marker延迟p95 ms（client原分位算法） | 992–1082 | 864–1009 |
| 同步marker读回p50 / p95 ms | 157–237 / 318–365 | 149–237 / 272–389 |
| 整机CPU p50 / p95 | 58.9% / 71.0% | 48.6% / 59.8% |

两组物理3D engine busy均约99%，不等同shader算术占用。off有上游吞吐和CPU方向收益，但单对最终FPS没有改善，marker p95也未接近目标；同步读回本身占用大量共享GPU资源，因此这些值不能冒充marker0常态或无读回延迟。

已达到预定“首对无最终吞吐收益且仍被另一同步Present占住”的停止条件。未跑剩余ABBA、单720性能组，避免继续花费在同类窗口呈现等待上。后续应针对真正offscreen root，不改变DPI作为第二变量。

## 替代阻塞的同request证据

`dcomp-off-profile1080x4/official-trace/session-4-16451152814.json`，counter170。完成回调仍在CommandBufferStub::PerformWork内，其任务到期→运行 **447.980ms**，其中 **447.929ms**被已有RunTask scope覆盖；最长RunNextTask为448.920ms、线程CPU3.776ms。内部：

`SkiaOutputSurfaceImplOnGpu::SwapBuffers` → `NativeViewGLSurfaceEGL:PostSubBuffer`，后者墙钟 **447.879ms**、线程CPU2.836ms，尺寸2880×1620。

S3 counter279对应PostSubBuffer **463.626ms**、线程CPU2.849ms，due→run508.949ms也几乎全被既有任务占据。详见该case的 `finished-enclosing-scopes.json`、`observation-task-queue.json`。S2任务delay字段出现uint64形式的负微秒值，本轮不使用其due统计，不能把溢出值解释成超长requested delay。

这不是丢失唤醒或单纯低优先级观察任务能解决的问题；独立同线程高优先级任务无法抢占正在执行的窗口Present。现有GPU硬件计时仍只描述flush batch，不能把submitted→finished余量全部算成观察延迟。

## 功能和视觉验证

`dcomp-off-input-retry` 在Chrome89上真实mouse click获得activation marker60001，连续IME commit获得81/82，最终静态frame5/stimulus82可见；RTC close200，客户端随后peer=false。Sol检查 `visual.png`，静态最终变化、输入区域与H264画面正常，无错误横幅。前一次临时verifier把tenantId放入metrics顶层，被现有API拒绝400；删去这个测试报告字段后重跑成功，不是串流输入故障。两次证据均保留。

## 分析与验证

Release增量构建通过，非法endpoint值实测退出1；真实命令明确只有off包含DComp开关。正式源码默认仍auto，没有Chromium新patch。结束后本次Control/source/browser/资源进程已清理。

各case的 `summary.json`、`resource-summary.json`、`server-trace-analysis.json`保留分层数据；`dcomp-pair-summary/matrix-layer-check.json`为汇总。旧matrix工具此版本没有paintFps字段，表中“实际canvas”直接取原benchmark的displayFps。

stop之后有一条服务日志末尾JSON截断；原文件保留。临时分析器只忽略这一个不完整末行，未忽略中间错误；详情 `dcomp-analysis-discarded-tails.json`。两个case正式20秒客户端报告均完整。client与server分析器分位取整算法不同，所以各报告的p95可略有差异，本文marker p95使用client原始报告。
