# Headless接收端真实运行

2026-11-01。已完成的两租户45秒headless组，实际canvas为 **51.6926/51.7349FPS，Pixel marker p95 76/79ms**，每路45个有效CRC；该组同时满足FPS≥50和p95≤100ms。用户取消了后续120秒稳定复验及额外单租户复验，因此没有完成长期稳定或单租户验收。

本报告仅离线整理磁盘现有产物，没有启动浏览器、测试、构建或新实验。

## 配对与条件

顺序配对case为 `develop/tmp/headed-worker-fixed52-t2` 与 `develop/tmp/headless-worker-fixed52-t2`。两组fingerprints逐键一致，只切换receiver的headed/headless运行方式；页面、Worker、Browser/SDK/Endpoint、码率、尺寸和fixture不变。

共同条件：两租户、10秒暖机+45秒测量，原1920×1080/DPR1，实际atlas/编码1936×1088、mediaScale1、CRC1Hz；source固定52/adaptive off，CaptureToAtlas+CaptureRoot+SinglePlaneDirect、Endpoint shared输入；QSV TU7、LPon、VBR目标36/最大44Mbps、depth1、external VPP/alignment16；每peer48Mbps、RTT10ms、RTP0/0。Receiver为Chromium157.0.8103.15、官方fake60、MSTP immutable opaque snapshot、fifo2/rAF，ProcessorProfile=false、callbackRegistration=not-applicable；MarkerReadback=worker。intrusive profile关、ResourceProfile开。

|指纹|SHA256|
|---|---|
|receiver chrome.exe|F833F59831E7D428E1527BF1E12C0D4A2B338A0CBD4239A050F280C1C62EA62A|
|receiver chrome.dll|20C0F298D2012B6841BA8ACB7AF7F62DC6DF23A40F899073C9D74DD0FC034FCC|
|Endpoint|1607E34B1EBD08F489B89F1DB978BD6DC95CA360E1D413366939426B9ADCE14C|
|source Viz service|E58BC7C0990341B2CA84B7C6A1D0570C28EB0E7D4132DCF409B0FF00821D1A8B|
|Viewer bundle index-BI4yf---.js|F86A2BA691C5C54A07EFF0D08E362ECB34B5D040EDADFFBC0B05C15DB3F38CD1|
|marker Worker（每job clear版）|689510C6604D04DAB054FFE8073CAD63C443274E7DC0E462C153ABB29AE59DFB|
|fixture test-pattern.html|4CB517D8BD239E64C79C6D26D66E8FA0E374062046B43EF9813089A2874585F1|

完整组件和工具指纹在各case的fingerprints.json；没有用旧Worker残留污染版或其它Endpoint的历史性能替代本组。

## 45秒结果

|模式/peer|source render|delivery|encode|RTC decode|实际canvas|marker p50/p95 ms|
|---|---:|---:|---:|---:|---:|---|
|headed/0|51.98|49.48|49.48|49.43|48.9560|73/90|
|headed/1|52.00|37.52|37.52|37.52|37.3554|91/108|
|headless/0|52.00|52.03|52.06|52.01|51.6926|62/76|
|headless/1|52.00|52.04|52.06|52.01|51.7349|64/79|

Delivery/encode/decode为保存summary中的采样端点差值率。Headless成功paint2327/2329，测量窗口45016.1/45018ms；headed2204/1682，窗口45020/45026.9ms。每路CRC45、invalid0，RTP+epoch重复0、missingPaintSnapshot0。离线重新校验所有chunk的长度和SHA256，兼容直接保存的完整report；两个case均取得两路完整报告。

|15秒段（成功paint计数/15秒）|headed0/1 FPS|headless0/1 FPS|
|---|---|---|
|0–15|49.20/36.87|51.60/51.67|
|15–30|49.20/37.73|51.87/51.80|
|30–45|48.53/37.47|51.60/51.80|

Headless三个短分段均超过50，完整45样本p95用于本轮延迟判断；这些短分段不替代被取消的120秒复验。

## 实际backend和完成口径

保存的CDP SystemInfo显示receiver使用Intel UHD Graphics630，ANGLE Direct3D11、driver30.0.100.9805，glImplementationParts为egl-angle/d3d11。2d_canvas、GPU compositing、rasterization、video_decode均enabled；不是以软件backend替代原像素负载。功能case还保留gpu-process-args.json，实际带headless和fake-vsync-rate60，完整launch/backend在metrics。

实际完成口径仍为Viewport canvas成功paint；Worker只从同paint通知中截取已经画过的plane ROI，E2E终点为原paint时间，非Worker完成时间。每路45个Worker job的RTP/epoch/paintedAt与正式paint逐一匹配，mismatch0、CRC全有效。此处的模拟刷新与canvas提交不代表物理显示扫描输出。

`headless-receiver-functional`保存初次输入CRC6000、invalid0、原尺寸布局，以及Worker不可变性/所有权检查、backend gate和关闭记录。关闭后read/close2045/2045、ownerClosed2045，source/pending/latest清空、ownersHeld0、displayReadyfalse。功能截图与原始指标在该case，未重新启动复测。

## Worker和帧所有权

Headless每路submitted/completed/bitmapCreated/transferred/workerClosed均45，failed0、mainClosed0、workerTerminated1、maxPending1，无容量覆盖或缺CRC样本。所有job保留原paint身份。

|headless耗时p95 ms|peer0|peer1|
|---|---:|---:|
|capture同步调用|0.8|0.6|
|bitmap兑现|1.1|0.9|
|异步周转|18.1|16.8|
|Worker readback|14.8|14.2|
|Worker total|15.2|14.5|

MSTP read/close2343/2343、2344/2344，invalid/stale0，fifo2满队列替换14/12，atlasSnapshotCopies0。末latest各1，pending0/1；诊断canvas2330/2331含正式窗口外事件，正式FPS只用窗口内2327/2329。实际TU7、LP initialized16、mediaScale1，Endpoint private copies0。

## 资源与配对解释

|资源|headed|headless|
|---|---:|---:|
|有效Resource samples|45|44|
|Intel3D均值 %|93.55|64.33|
|VideoDecode均值 %|58.80|50.31|
|VideoProcessing均值 %|14.57|13.48|
|整机CPU均值 %|63.76|35.95|
|3D sourceGPU %|44.06|38.69|
|3D receiverGPU %|36.26|25.37|
|3D sourceBrowser/Endpoint %|0/0|0/0|
|unowned3D观测贡献 %|13.231|0.268|

两组gpuErrors均空。Headless同时减少接收端和系统图形合成负载，原headed系统图形负载并未作为无关噪声删除。不同GPU引擎不相加；完整所有进程与unowned归因保存在resource-summary。此结果属于headless接收端路径，不写成相同headed环境已经达标。

## 用户取消和清理状态

`headless-worker-fixed52-t2-stable120`配置原计划为10秒暖机+120秒、两租户。用户取消时仅保存receiver-backend和resource-process-root两条metrics，没有完整streaming-benchmark report或report manifest，因此**不能报告稳定120秒通过，也不能将部分在途采样作为完整结果**。用户同时取消了额外单租户复验，未生成其完成结论。

Root已执行该在途case的stop及host browser_close，并确认无chrome/remotekit_browser/endpoint_service残留，3001/3013无监听。当前离线收尾未启动任何测试、浏览器、构建或GPU进程，未改代码或提交。取消case及已完成45秒原始产物均保留。
