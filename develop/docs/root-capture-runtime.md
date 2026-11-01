# Root capture 有界实现与运行结果

2026-11-01。`RemoteKitCaptureRoot` 已实现并完成运行验证，默认关闭。开启后，DPR1独立离屏WebView的页面quads实际合并进最终root：原child六quad + root单quad两pass变为root六quad一pass。两租户adaptive实播有约2.4/3.6FPS收益，但37.50/34.89FPS、marker p95 104/108ms仍未达目标；固定55使GPU饱和，不能作为默认方案。

## 实现与边界

只改本项目browser路径与prepare通用开关，没有新增Endpoint/SDK协议。`WebView`明确提供其独立`OffscreenHost`，`GpuAtlas::SetViews`在UI序列逐次核对真实compositor尺寸/DSF、RWHV requested renderer pixels/compositor viewport、实际capture scale override及content窗口region。仅page DPR=1、实际RWHV DSF=1、override=1、root DSF=1、root和页面预期backing像素完全一致且content覆盖root时，使用现有`ClientFrameSinkVideoCapturer::ChangeTarget(VideoCaptureTarget(rootFrameSink))`。不是凭JS DPR推断backing。

未知、HiDPI及native/demo保留原child target。`snapshot`现有compositor字典与`output.status`新增effective target、原因和root物理尺寸诊断；Endpoint已透传snapshot，不改通信定义。resize、DPR、RWHV/root身份或document变化经既有StopAndResetConsumer、重建capturer、新geometry binding及ClearStage；旧consumer消息被断开，旧pending capture被清除，已提交GPU读取继续按原Fence/lease完成。Viz重连仍由官方ClientFrameSinkVideoCapturer维护。

native GPU capture、三槽、SinglePlaneDirect、ready/consumed Fence、GPU源租约、正常帧率/静态refresh/背压路径均保留。没有新逐帧browser↔endpoint IPC，没有改fixture、Control呈现、编码器、自适应阈值或out/rel。

prepare新增`-BrowserEnableFeatures RemoteKitCaptureRoot`，与已有CopyOutputProfile/SinglePlaneDirect等feature拼接，config和实际Endpoint/browser args一致。

## 同配置profile-off比较

两租户，原Canvas fixture，viewport1920×1080/DPR1、atlas/编码1936×1088、CRC1Hz；TU7/VBR/depth1/LowPower ON，36/max44Mbps，每peer48Mbps/RTT10ms；外部VPP、alignment16、RTP playout 0/0；receiver Chromium157.0.8103.15精准fake60、默认video/snapshot。10秒暖机+45秒测量，resource采样开，browser/media/server/official profile关闭。CPU构建与GPU采样未重叠，未操作用户桌面。

|case|peer0 canvas FPS / marker p95|peer1 canvas FPS / marker p95|全机3D|
|---|---|---|---|
|既有child adaptive `source-budget-on-t2`|35.11 / 91ms|31.33 / 99ms|86.95%|
|root adaptive `root-capture-adaptive-t2`|37.50 / 104ms|34.89 / 108ms|88.15%|
|root固定55 `root-capture-fixed55-t2`|28.18 / 167ms|27.78 / 186ms|99.71%|

三组CRC invalid均0；root adaptive各45个marker，fixed55各44个marker。root adaptive源GPU3D28.69%（child31.37%），接收GPU30.16%（child25.95%）；更高呈现帧率把一部分释放的源端预算转为接收端工作。固定55源GPU39.96%，最终canvas只有约28FPS，强推源帧率不可取。

root adaptive配置browserRenderFps=0表示跟随encoding60；Endpoint adaptive初始化仍取60，行为与child配置的显式60等效，实际生效render上限逐秒保存在metrics。请求值和实际值分别记录，未把请求60写作源实测60。

## 固定40 profile：结构、实际像素与GPU时间

`develop/tmp/root-capture-fixed40-t2`，两租户固定40/adaptive off，暖机1秒、测量10秒，其余配置同上，开启OfficialTrace/CopyOutputProfile/ServerTrace/ResourceProfile。两份实际Session官方JSON完整导出（167/178MB）才停case，覆盖完整10133.2/10011.0ms测量窗。浏览器工具最初一次launch因临时driver反斜杠替换错误失败，纠正后才开始实播；初始host导航产生的空Session1 trace没有capture和正式测量窗，分析明确排除。

两实际Session测量窗的`DirectRenderer::DrawRenderPass`均只有id1/6quad，405/400次；没有child flush。实际root SkSurface1920×1080、RGBA8888（color_type4）、sample1。GPU elapsed p50/p95分别1.210/1.667ms、1.250/1.713ms；原child1.491/1.911和1.499/1.898ms，另有原root1.039/1.347和1.046/1.356ms。此处报告独立flush批次，不将不同计时边界机械相加。trace未发现NativeViewGLSurfaceEGL、SwapChainPresenter、SkiaOutputDeviceDComp或Present1事件。

本组canvas32.07/32.56、p95147/187ms、CRC invalid0，是profile诊断，不能替代上表验收结果。`draw-summary.json`、`viz-gpu-summary.json`、`copy-output-summary.json`和原trace保存在case。

## 输入、resize及HiDPI fallback

通过browser-use skill的host-managed Playwright执行，未使用Computer Use。`root-capture-functional`顺序为：

|阶段|实际目标|root物理像素|真实页面backing|output generation / layout epoch|CRC stimulus|
|---|---|---|---|---|---|
|1920×1080 DPR1|root|1920×1080|1920×1080|1 / 1|2001|
|resize 1280×720 DPR1|root|1280×720|1280×720|2 / 3|2002|
|1280×720 DPR2|child，unproven_device_scale|1280×720|2560×1440|3 / 5|2003|
|返回1920×1080 DPR1|root|1920×1080|1920×1080|4 / 7|2004|

每阶段先点击页面700,500使输入框失焦，再点击400,30，随后IME commit marker刺激。四次均从实际同RTP呈现plane读出对应CRC stimulus，invalid0。完整解码PNG中pointer均为`mouse 400,30`，文字、几何和画面边界正常，四张图已由Sol视觉核查。DPR2由既有Endpoint媒体上限等比下采样到1962×1104内容；这不参与1080p性能验收，且真实child backing仍为2560×1440，未走低分root放大。证据为`target-summary.json`、`metrics/client-metrics.jsonl`、四张`source-trace/*-decoded.png`及四张`*-ui.png`。

默认关闭`root-capture-off-smoke`的1080p实播通过，43.15FPS、p9558ms、CRC invalid0、4次输入响应、无输入超时（2秒暖机+5秒短测，不作正式验收）。native demo没有运行；其host身份为空，代码明确保留child。

本轮覆盖resize/DPR切换及新输出代次，没有新增GPU崩溃/跨browser恢复破坏性测试；沿用已有官方Viz重连和原实例生命周期机制。

## 构建、补丁与指纹

out/dev增量构建remotekit_browser通过，全部16逻辑核；最终6steps/22.51秒。没有clean/newout或out/rel构建。最终browser exe SHA256 `1295D21477A609F270F0A922C8C2A0FBEF80626F336AB7BEA5ACD74159AE5C7C`，组件`components_viz_service.dll`为`B3FB7021D3251BB955BE3345258F0100A52AC0D5268676D3F722DA514B161F8A`。每case保留实际运行时完整fingerprints；固定40组运行在helper修正之前，其Viz DLL仍为前版`0A233C7CF2178CFC52249A1AE21FD4F385916CA94976AE6B0D64C8DBEE0A8B01`。

应主Agent审阅修复profiling helper abandoned语义：plain Run只转发原plain，绝不补调原stats；normal WithStats仍原stats优先，各自一次回收。只替换0002独占新增header片段，最终0002 SHA256 `38a0b40c733f33a31492424d0f78d3d41d2bb280e7c95a2cb0ffbbc2563b1758`，manifest同步。修正时曾将patch整文件写为CRLF造成apply conflict，已恢复LF；独立临时树从官方HEAD正向六patch、全部25路径与live一致、逆序还原精确通过，日志`develop/tmp/root-capture-patch-replay.log`。patchset status六项applied，git diff check、prepare PowerShell解析通过。

最终所有自有Control/source/Endpoint/receiver已关闭，host browser_close已执行；CPU/GPU窗口释放。未commit/push，由主Agent统一审阅收尾。默认OFF保持，现有Chrome89客户端路径保留，当前优化没有达到同组≥50FPS/≤100ms目标。
