# 三租户 TU7 / VDEnc / Hybrid 实播

2026-11-01，四组完成，均未达到每租户 canvas≥50FPS、Pixel marker p95≤100ms。全ON比全OFF吞吐稍高，两个混跑没有额外收益；全部3D占用约99.8%。源GPU进程占3D约60%，source JS绘制约57–59FPS时，实际到Endpoint的atlas只有约17–20FPS。下一项应针对源GPU负载与积压，不继续扩编码预设矩阵。

## 固定条件与身份

host-managed Playwright执行既有正式harness，不使用桌面鼠标键盘。receiver Chromium157.0.8103.15、精准synthetic `--fake-vsync-rate=60`、continuous-rVFC默认OFF；此刷新为模拟刷新。source/render60、原canvas fixture、1920×1080 DIP/DPR1，所有peer实际source/encoded/video1936×1088、mediaScale1、level42。snapshot/after-work/default video、external转换/alignment16、SinglePlaneDirect source、adaptive OFF、VBR/TU7/depth1、请求36/max44Mbps、每peer独立48Mbps/RTT10ms、RTP0/0、marker1Hz、暖机5秒+正式30秒。没有构建或其他实验重叠，没有降低分辨率或关闭CRC。

关键SHA256：Endpoint `BFFE36417FBCF2445F73CA5BC0A0330F51F15FD87F0007346D9ABA48645A9CF4`；source browser `7AD9D280B570EAF9B2C439C64550CB230AE3083940DE0878917600512A2BC168`；receiver exe `F833F59831E7D428E1527BF1E12C0D4A2B338A0CBD4239A050F280C1C62EA62A`、DLL `20C0F298D2012B6841BA8ACB7AF7F62DC6DF23A40F899073C9D74DD0FC034FCC`；fixture `4CB517D8BD239E64C79C6D26D66E8FA0E374062046B43EF9813089A2874585F1`；Client index-CRYdFxcc.js `671BFB69691A98C380AC025112755F77F9EA2D9422823B541139FC8BF0708D31`。各组完整fingerprints一致。

目录依次为 `develop/tmp/three-fast-off-t3`、`three-fast-on-t3`、`three-fast-oon-t3`、`three-fast-onn-t3`；oon指on/on/off，onn指on/off/off。混跑按Session1/2/3实际选择，index0/1/2，比例正确。每个Session appliedTargetUsage=7；GetVideoParam LowPower全程ON=16、OFF=32，与requested/queried/initialized一致，init/get状态0，query警告5保留在原记录。引擎命名不能单独证明不同物理编码引擎并行。

## 同组各层结果

FPS按每peer自身30秒窗口计算。source是JS提交次数；atlas是Endpoint实际拷贝次数；decode是RTC累计差；canvas是独立成功paint次数，不用metadata presentedFrames替代。

|模式|peer|source render|atlas|encode|decode|canvas|marker p50/p95 ms|CRC有效/无效|
|---|---:|---:|---:|---:|---:|---:|---:|---:|
|OFF/OFF/OFF|0|52.11|15.00|13.16|13.20|11.36|853/1054|29/0|
||1|48.81|13.46|11.90|11.80|10.56|950/1200|29/0|
||2|52.75|14.83|12.33|12.36|10.53|890/1097|28/0|
|ON/ON/ON|0|58.24|19.73|16.13|16.09|12.59|653/852|29/0|
||1|56.60|16.76|15.00|15.50|12.46|718/899|29/0|
||2|59.03|19.61|16.28|16.32|12.68|627/921|29/0|
|ON/ON/OFF|0|57.28|18.00|15.43|15.50|11.86|694/947|29/0|
||1|58.03|18.46|16.40|16.43|12.46|697/881|29/0|
||2|56.40|16.50|13.80|13.83|11.73|800/938|29/0|
|ON/OFF/OFF|0|58.00|18.86|15.36|15.90|12.03|689/857|29/0|
||1|57.43|18.23|14.63|14.63|12.46|707/942|29/0|
||2|56.63|18.26|14.79|14.79|11.83|709/843|29/0|

接收端RAF约54.9–56.6Hz，GPU满载时精准fake60也不能让所有回调按时执行。OFF组整机CPU p50/p95为68.8/88.5%，ON52.7/62.7%，两混跑53.0/64.6%、48.9/59.8%。前置空载CPU3.2–5.3%，两组间空载7.1–14.5%，未发现并发构建；OFF与后续组的host CPU差异使全ON改善不能全部归因LowPower。

## 分段、排队和读回

下表capture/encode/copy为32个约秒级last-value快照的p95范围，RTC为同窗累计差/帧数的平均值；不是异常帧完整trace。private copy统计字段为lastGpuCopyMs。

|模式|capture→ready p95|private copy p95|encode p95|RTC decode均值|RTC processing均值|worker queue均值|marker readback p95|
|---|---:|---:|---:|---:|---:|---:|---:|
|全OFF|71.2–85.5|66.2–81.9|51.4–71.3|18.4–18.5|22.5–23.5|12.1–13.5|145.6–178.8|
|全ON|52.8–62.9|48.8–53.3|15.7–19.3|19.3–20.8|21.6–23.1|6.6–7.9|126.9–210.1|
|ON/ON/OFF|56.0–65.9|53.2–63.1|20.0–57.7|19.8–21.8|23.7–24.5|7.0–13.1|171.5–210.2|
|ON/OFF/OFF|63.8–73.0|61.4–70.4|16.2–62.0|18.9–20.8|21.7–24.5|6.4–12.5|147.8–178.4|

同RTP marker大延迟主要在render→receive，例全ON peer0的854ms为到达前835.8ms、receive→canvas18.2ms；peer1的916ms为904.3+11.7ms。满载源GPU可让JS提交与真正栅格化/合成形成积压，但本轮没开逐帧server trace，不能量化全部到达前延迟的所属。同步读回发生在canvas提交之后，当前marker终点不包含读回完成；读回仍阻塞后续工作并占同GPU，不能视为零开销。

正式窗口pendingReplaced：OFF67/62/91、ON118/75/113、oon93/80/95、onn120/125/117；atlasPoolDrops分别3/0/0、2/1/2、0/0/0、3/1/0。Endpoint error/errorDrops全0；RTC framesDropped全0。OFF peer2 packetsLost累计差79，其他peer/组均0；全OFF peer0 frameGate missed1，其他均0，wrongEpoch/missingRtp全0。新旧统计时间点可能让encode/decode计数相差小量，不用同秒快照反推严格逐帧顺序。

## 实际码率与网络

请求36/max44Mbps已正确进入Endpoint。码率会受WebRTC反馈更新，appliedBitrate快照中位数见表；VBR在此源负载和实际编码FPS下没有用满目标。sender列为同SDK时钟的bytesSent差；receive列为同窗RTC bytesReceived差，包含各自统计口径的开销。不能把请求36Mbps写成实际36Mbps。

|模式|peer|applied中位Mbps|编码字节Mbps|sender视频Mbps|receiver Mbps|
|---|---:|---:|---:|---:|---:|
|全OFF|0|36.001|1.82|1.92|2.00|
||1|35.905|1.56|3.69|3.61|
||2|12.417|1.32|1.78|1.89|
|全ON|0|36.645|1.56|1.62|1.68|
||1|35.236|1.77|1.96|1.92|
||2|37.527|1.54|1.63|1.65|
|ON/ON/OFF|0|35.819|1.80|1.82|1.84|
||1|35.140|1.69|1.79|1.81|
||2|37.574|2.31|2.40|2.44|
|ON/OFF/OFF|0|36.312|1.79|1.93|2.00|
||1|37.408|2.27|2.36|2.35|
||2|37.077|2.28|2.38|2.39|

OFF peer1编码字节与sender累计差口径出现较大差异，完整计数保留在details.json，不将两者混为同一指标。所有组整形器drop/sendError/socketError0；downlink最大排队约64–103KB，未触300KB上限。downlink scheduler lateness最大OFF102–121ms、ON9.8–34.4ms、oon34.7–50.0ms、onn11.1–44.3ms，包含启动/暖机；同机调度噪声仍影响实际RTT，配置10ms不能当作每包恰好10ms。每peer初始rejectedPackets1为候选通路建立记录，完整networkSimulation保留。

## GPU引擎与角色

平均占用%，独立引擎不相加。VideoDecode为驱动引擎名称，Endpoint没有因此被解释为只做解码。

|引擎/角色|全OFF|全ON|ON/ON/OFF|ON/OFF/OFF|
|---|---:|---:|---:|---:|
|3D总计|99.83|99.84|99.77|99.82|
|3D sourceGPU|59.46|62.48|61.34|60.07|
|3D sourceBrowser|4.59|5.63|5.18|5.36|
|3D Endpoint|12.22|7.65|9.37|11.53|
|3D receiverGPU|15.39|15.52|15.26|14.67|
|VideoDecode总计|17.31|30.01|26.34|21.73|
|VideoDecode Endpoint|11.36|23.14|19.66|15.25|
|VideoDecode receiverGPU|5.95|6.87|6.68|6.49|
|VideoProcessing Endpoint/总计|6.93|8.13|7.81|7.55|

全ON将Endpoint部分3D负载转向驱动报告的媒体引擎，但腾出的3D被源使用，整体仍满载。未观测到混跑让总链路突破GPU瓶颈。资源完整样本30/29/29/29，采样器CPU平均0.078/0.070/0.121/0.106核，collection平均217/185/199/185ms，GPU errors0、resource.err均空。

## 产物与结束

每组config/run.js/fingerprints、完整metrics、source-trace、endpoint-responses、host-result、resource-samples、resource-summary、stage-summary、segments-summary均保留。正式loader对全部12个benchmark报告重组校验成功；汇总在 `develop/tmp/three-fast-comparison/details.json`。通用matrix工具的paint列在新Client记录中为null，因此本文直接使用完整报告displayFps；完整数据没有缺失。此工具兼容问题不影响本文结果，留给后续修复。

四组无pageerror，RTC close均HTTP200；所有自建receiver/source/Control已停，3001/3013无监听，正式host browser_close完成，GPU已交还主Agent。未修改产品、fixture、参数默认值或正式工具；没有构建、commit或push。四组均远离目标，没有追加无价值重复或自行扩两租户。
