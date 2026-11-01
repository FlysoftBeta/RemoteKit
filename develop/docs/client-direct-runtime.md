# 客户端 single-plane-direct 有界实播

2026-11-01。客户端 direct 路径确实省去 atlas snapshot 绘制，但本次两租户没有获得全链路收益：真实 canvas 37.16/33.85FPS，Pixel marker p95 116/132ms；原 snapshot 为37.50/34.89FPS、104/108ms。未接近每peer 50FPS，所以按实验停止条件不追加固定52或重复组。Chrome89 首帧、CRC输入和重连回归通过。

## 配置与指纹

性能case为 `develop/tmp/client-direct-root-adaptive-t2`，10秒暖机+45秒测量。唯一实验改变为客户端 `PresentationMode=single-plane-direct`；默认video接收，MSTP未启用，continuous-rVFC关闭。其余延续root adaptive：原动态canvas fixture、1920×1080 DIP/DPR1、actual atlas/编码1936×1088、mediaScale1、CRC1Hz；source root capture及source SinglePlaneDirect开启；adaptive on、TU7/LowPower ON/VBR/depth1、请求36/max44Mbps；每peer独立48Mbps/RTT10ms，external VPP、alignment16、RTP0/0、after-work。receiver Chromium157.0.8103.15，`--fake-vsync-rate=60`精准synthetic刷新。browser/media/server/official profile关闭，ResourceProfile保留。没有构建、其它实验或用户桌面操作。

两个feature用途不同：`RemoteKitCaptureRoot`选择source root；`RemoteKitSinglePlaneDirect`为source共享纹理路径；此次改变的是Control客户端呈现模式。各实际页面snapshot的 `compositor.capture.effective_target=offscreen_root`、`reason=pixel_preserving_root`、root1920×1080；无页面HWND，真实backing1920×1080。TU实际全程7，LowPower requested/queried/initialized/GetVideoParam均16，queryStatus5、init/get状态0。

每case完整fingerprints保留在case内。两组使用source browser SHA256 `1295D21477A609F270F0A922C8C2A0FBEF80626F336AB7BEA5ACD74159AE5C7C`，`components_viz_service.dll` `B3FB7021D3251BB955BE3345258F0100A52AC0D5268676D3F722DA514B161F8A`，Endpoint `BFFE36417FBCF2445F73CA5BC0A0330F51F15FD87F0007346D9ABA48645A9CF4`。新版receiver exe `F833F59831E7D428E1527BF1E12C0D4A2B338A0CBD4239A050F280C1C62EA62A`、chrome.dll `20C0F298D2012B6841BA8ACB7AF7F62DC6DF23A40F899073C9D74DD0FC034FCC`。fixture SHA256 `4CB517D8BD239E64C79C6D26D66E8FA0E374062046B43EF9813089A2874585F1`保持不变。

## 实际吞吐、延迟及路由

|模式|peer|source JS render|atlas|encode|decode|真实canvas|marker p50/p95 ms|
|---|---:|---:|---:|---:|---:|---:|---|
|原snapshot|0|42.34|—|—|—|37.50|70/104|
|原snapshot|1|37.69|—|—|—|34.89|72/108|
|direct|0|40.72|40.48|39.63|39.66|37.16|83/116|
|direct|1|36.10|35.95|35.57|35.57|33.85|90/132|

真实canvas计数为1673/1524，来自成功paint通知，未使用video metadata presentedFrames。各45个CRC marker、invalid0，paintedFrames中重复RTP+epoch0；epoch始终1、wrongEpoch/missingRtp/missed0、全部displayReady=true。Endpoint error为空。

directFrames为1672/1520；snapshotFrames为1/4，全部fallback原因metadata-unmatched；retainedPlaneRedraws0，skippedRenderer为空。videoSnapshot计时样本数恰为1/4，与fallback数一致。原snapshot计数不会被误算成direct。

只读核查调用次序：`control/client/transport.ts` startFramePump先observe真实RTP，然后调用tryDirectFrame；成功立即return，跳过 `pendingFrame.getContext` 和 `drawImage(video,0,0)`。tryDirectFrame调用paintPlane，将video直接draw进唯一viewport canvas；同步paint listeners再从已画canvas读marker。它没有提前为late metadata维护一次atlas snapshot。只有无法匹配metadata/布局等时才进入snapshot分支；授权snapshot通过交换canvas引用完成。源码次序与实际1/4个videoSnapshot样本相互印证，未改产品。

瞬时snapshot分布中capture→ready p95为18.06/20.33ms、private GPU copy p95 15.27/15.10ms、encode p95 14.59/16.79ms。正式窗口pendingReplaced增加37/17，adaptive target范围32–50/29–44；源与编码平均均低于45FPS，帧率损失不只发生在接收端。上述p95是秒级last-value分布，不是所有帧trace。

## GPU及非实验进程

45个资源样本、GPU errors0、resource.err为空。整机Intel 3D均值89.36%、p95 97.92%；VideoDecode47.06%、VideoProcessing12.19%。source GPU3D28.90%、source browser7.98%、Endpoint11.58%、receiver GPU28.23%；Endpoint VideoDecode35.86%、receiver VideoDecode11.19%，驱动引擎名称原样保留，不将它们相加。

新collector记录了非实验PID：dwm PID8756平均3D9.87%，WUDFHost PID23096为2.55%，System PID4为0.20%。这些是同窗已观测贡献，未停止任何非实验进程。整机CPU均值54.57%、p95 84.99%；collector平均0.47核、采样耗时均值579.8ms。原snapshot资源collector也已使用相同新实现，原组平均0.42核；没有把无关进程归进receiver。

与原snapshot的整机3D88.15%、receiver GPU30.16%相比，此次receiver GPU略低，但源/Endpoint及背景负载仍然占预算，最终source/encode均未达到45FPS；direct节省没有转化为50FPS。一次顺序比较不足以量化微小收益，但足以排除“已接近验收，适合固定52”的判断。本轮按授权只做一个性能组。

## Chrome89兼容

`develop/tmp/client-direct-root-chrome89` 使用已有 `C:/src/tmp/chrome89-google/app/chrome.exe`，实际UA为Chrome89.0.4389.90；原 `chrome89-h264-42` receive profile、默认video、无fake-vsync flag，source root/direct及客户端direct均开启。此组是短功能回归，不计入新版性能验收。

initial与reconnect均收到1936×1088 video/H264，profile-level-id=42e02a；真实framesDecoded分别148/80，packetsLost/framesDropped均0。点击页面400,30并IME commit后，实际同RTP plane解码出CRC stimulus3001/3002、invalid0，完整解码图pointer均为mouse400,30。重连换connectionId，layout epoch/generation由1变2，仍可输入和读出新刺激。direct累计69→145帧；snapshot25→27，主要是初次layout-transition，wrongEpoch/missingRtp/missed均0。

Sol检查 `initial-ui.png` 和 `source-trace/*-reconnect-decoded.png`：marker、输入框、动态色块、文字及画面边界正常；左下诊断文字覆盖滚动文字是原fixture现象，原fixture和图像保留。首连接和重连完整结果在host-result.json，另有两张UI和两张实际解码PNG。没有操控用户鼠标键盘。

## 产物与清理

性能case保留config/run/fingerprints、host-result、原metrics、source-trace、endpoint-responses、resource-samples/summary、summary和details.json。完整metrics loader重组校验成功，details.json明确给出paint及epoch重复检查。通用matrix工具仍有旧paintVersion识别问题，本报告直接使用完整streaming-benchmark.displayFps和paintedFrames计数。

两个case全部自有Control/source/Endpoint/receiver已关闭，3001/3013无监听，未剩余remotekit_browser.exe，host browser_close完成，CPU/GPU窗口释放。无产品或工具改动、无构建、无commit/push；本报告供主Agent统一收尾与决定下一项优化。
