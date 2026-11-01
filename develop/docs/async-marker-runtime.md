# 异步Pixel marker真实运行

2026-11-01。清画布修复后的Worker功能门通过，157和Chrome89均不再跨job残留CRC。正式sync→worker两组各取得45个有效CRC/路，但未达FPS/延迟目标；同时出现约13.7–13.9%的额外系统3D负载，不能将两组性能差直接归因Worker。未启动120秒或单租户追加组，已清理并交主Agent决定是否安排干净窗口重测。

## 版本和测试条件

本次正式两组fingerprints逐键一致：Endpoint `1607E34B1EBD08F489B89F1DB978BD6DC95CA360E1D413366939426B9ADCE14C`，Control bundleF86A…不变；source新transport-recovery版，patch7 `123f00fe254e66fa27223a6783798a9c023ab2a559922f89ddb3db2f07e57144`、Host33214F2D…、ServiceE58BC7C0…。

Worker为clear修复后的 `689510C6604D04DAB054FFE8073CAD63C443274E7DC0E462C153ABB29AE59DFB`；readback模块75A0CF1A…、benchmark48730DE0…。旧Worker8C7096FB…只有修复前功能证据，没有正式性能组。

case `async-marker-sync-fixed52-t2`→`async-marker-worker-fixed52-t2`，各全新启动，暖机10秒+测量45秒，两租户。唯一变量markerReadback sync→worker。其余为source52/adaptive off、fifo2/rAF、ProcessorProfile=false、MSTP callbackRegistration=not-applicable、原1920×1080/DPR1、实际atlas/编码1936×1088、mediaScale1、CRC1Hz、CaptureToAtlas+CaptureRoot+SinglePlaneDirect、shared、TU7/LPon/VBR36max44Mbps/depth1/external/alignment16、每peer48Mbps/RTT10ms/RTP0/0、receiver157官方fake60/immutable opaque snapshot。intrusive profile全关，ResourceProfile开；没有并发构建、改fixture或降低像素。

## 清画布修复后功能

`async-marker-clear-functional`的实际plane paint通知同栈立即submit bitmap，随后改画原plane，并交错第二独立canvas job再改画。首job仍得到原frame244/stim6000、RTP3366069863/epoch1、paintedAt6225ms；第二job保持改画前frame999002/stim9192。没有把Worker完成时刻替代paint。实际sourceKind=plane、alpha=false。

连续valid→透明空canvas后，第二job返回marker=null，旧CRC不再串入。invalid-source显式reject；有pending时close使Promise拒绝，迟到bitmap在主线程关闭。submitted5、completed3（包括明确invalid CRC结果）、failed2、created4、transferred3、workerClosed3、mainClosed1、terminated1，资源总数闭合，无fallback。

Chrome89.0.4389.90独立API再验：module Worker、OffscreenCanvas、createImageBitmap可用，frame890001/stim8901提交后改画890002仍返回890001；随后透明job返回null，created/transferred/workerClosed各2、failed0。这是独立Canvas API验证；Chrome89默认video返回atlas，当前worker明确拒绝atlas，串流仍使用sync，没有扩写成Chrome89默认video worker已支持。

修复前`async-marker-functional`暴露透明/空canvas与未实绘alpha:false canvas的旧CRC残留，主Agent暂停正式组并修Worker每job先clear。旧失败保留，未以opaque假设放过。实际黑色实填canvas当时可返回null，但不替代透明测试。两版证据和hash分开。

## 正式结果

|模式/peer|source|delivery均值|encode均值|RTC decode|实际canvas|marker p50/p95 ms|
|---|---:|---:|---:|---:|---:|---|
|sync/0|52.00|50.04|50.04|50.05|49.46|76/94|
|sync/1|52.00|38.67|38.69|38.68|38.45|90/106|
|worker/0|52.00|43.18|43.11|43.19|43.02|85/105|
|worker/1|52.00|40.12|40.12|40.08|39.85|83/108|

Delivery/encode为47个秒级Endpoint报告均值，decode为RTC采样端点差值。sync成功paint2227/1731，worker1937/1794；RTP+epoch重复0、missingPaintSnapshot0、epoch1，各路CRC45、invalid0。marker job 1–45严格顺序，job身份与正式paint的RTP/epoch/paintedAt全部对应，crcValid全true，sourceKind全plane。原始chunk长度/hash验证通过。

|15秒段|sync canvas0/1|worker canvas0/1|worker marker p95 0/1|
|---|---|---|---|
|0–15|48.47/38.27|46.20/40.73|105/91|
|15–30|50.00/38.53|41.67/39.07|99/94|
|30–45|50.00/38.60|41.20/39.80|103/125|

两组均未同组达标，因此不跑稳定/轻载追加。系统负载变化的具体来源见下节，结果保留，不能假称候选收益已确定。

## Worker耗时和所有权

|耗时，p50/p95 ms|peer0|peer1|
|---|---|---|
|capture同步调用|0.3/1.2|0.4/0.9|
|bitmap兑现|0.5/1.5|0.5/1.2|
|异步总周转|12.4/31.6|14.7/27.5|
|Worker draw|0.1/0.4|0.1/0.3|
|Worker readback|10.7/29.0|13.6/25.5|
|Worker decode|0.1/0.4|0.1/0.5|
|Worker total|10.8/29.4|13.8/25.7|

每路submitted/completed/bitmapCreated/transferred/workerClosed均45，failed0、mainClosed0、terminated1、maxPending1；timeout/error/容量失败0，job序列无覆盖或缺失，drainMs0。Worker自身耗时用自身时钟差，不跨realm减绝对时刻。

E2E终点保持原paintedAt/paintedWallTime；每个样本job身份已与正式paint匹配，额外report markerCompletedAt和异步周转没有替换E2E终点。sync原marker getImageData p95 20.7/24.8ms，worker主线程该同步读回项为null；不能仅据此宣称整条管线变快。

## 资源和系统图形负载

|资源|sync|worker|
|---|---:|---:|
|有效Resource samples|44|43|
|Intel3D均值 %|91.13|89.26|
|VideoDecode均值 %|55.04|52.60|
|VideoProcessing均值 %|14.05|13.40|
|整机CPU均值 %|56.53|57.38|
|3D sourceGPU %|42.541|41.926|
|3D receiverGPU %|34.907|33.402|
|3D sourceBrowser/Endpoint %|0/0|0/0|
|unowned3D观测贡献 %|13.684|13.929|

主要unowned为WUDFHost PID8732约2.72/2.73%、dwm PID8756约10.83/11.06%；此前干净FIFO组同项约0.002%。这是实际系统图形负载变化，不是本实验可忽略的零头，已报告主Agent；未停止系统进程或自行改变显示环境。gpuErrors/resource.err均空，独立引擎不相加。

sync MSTP read/close2249/2249、1738/1738，queue满替换20/7；worker1947/1947、1809/1809，替换6/8。两组invalid/stale0、atlasSnapshotCopies0，末latest1/pending0。Endpoint pendingReplaced/encodeDropped增量全0，private copy0。低paint与上游delivery/decode同时下降，不能把所有减少归因Marker或FIFO。

## 产物和清理

原始case都有config/run/fingerprints、summary/details、marker-details、presentation-raw、segments、resource-summary/compact/segments。报告中的系统负载和失败结果完整保留，没有缺CRC样本的达标声明。所有自有receiver157/89、case服务和host browser_close完成，3001/3013无监听、无source残留，GPU已释放。未修改源码、构建或提交。

source GPU自动恢复门另见capture-to-atlas-runtime.md末节：reason0分类reconfigure，同RTC新generation CRC8201恢复，正常close不复活；后续没有重复GPU kill矩阵。
