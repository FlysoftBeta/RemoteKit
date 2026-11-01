# 精准 synthetic60 接收端实播

2026-11-01，全部CPU构建结束后的独占GPU窗口，host-managed Playwright，正式prepare/benchmark/resource工具。精准fake60把空页实际RAF恢复到60Hz；单1080两次实播仍未在同组同时达到canvas≥50FPS与marker p95≤100ms。四1080 compositor30仍把GPU占满，没有追加render60。

## 配置、指纹与空页检查

接收端Chromium157.0.8103.15，`out/rel/chrome.exe` SHA256 `F833F59831E7D428E1527BF1E12C0D4A2B338A0CBD4239A050F280C1C62EA62A`，`chrome.dll` `A0F2E596EB42FED41CCC69FAA53A97DB195E5ED971D04862CEE8F3002CBE6637`。该DLL含0005的绝对deadline与waitable高精度timer，官方有节拍`--fake-vsync-rate=60`；模拟刷新不代表物理扫描输出。

source browser `7AD9D280B570EAF9B2C439C64550CB230AE3083940DE0878917600512A2BC168`，Endpoint `B7FB545A05359417DA74A390ACD260D8C565004D3B1D6392D13199FF74C50208`，Client bundle C64R1vkN SHA256 `2F6EBB62386217D78702ACB942D498273222C1048C6F3773B6AC759EA8B75E5C`。canvas fixture `4CB517D8BD239E64C79C6D26D66E8FA0E374062046B43EF9813089A2874585F1`；compositor fixture `C042B5CFCAFE9F5E31D13CBC7F57A928F2CCCB597A7CBE2E897A113B9E08D6B1`。三组二进制、工具与bundle指纹相同，只有compositor组fixture不同。

所有组每peer1920×1080 DIP/DPR1，真实source/encoded/video1936×1088、mediaScale1、显式H264 level42；after-work/snapshot、external16/direct、TU1/VBR/d1/LowPower auto、RTP0/0、独立24Mbps/RTT10ms、marker1Hz、ResourceProfile开启、媒体及ServerTrace关闭，暖机5秒+采样30秒。单租户render60，四租户compositor组render30。未下采样、关闭marker或使用unlimited。

先运行10秒空页：602个RAF、首尾10016.2ms，对应60.0028Hz，interval p50/p95为16.7/17.1ms。旧官方fake60实播实际RAF约56.54Hz；精准timer修复了这项节拍误差。

## 单1080 canvas：FPS与延迟尚未同时稳定

目录：`develop/tmp/precise-fake60-canvas-t1`、`develop/tmp/precise-fake60-canvas-t1-repeat`。对比旧DLL但同一新phase fixture的`fixture-absolute-c157-60-t1`；旧fixture结果不混入此表。

| 同组指标 | 旧DLL/同fixture | 精准60首次 | 精准60同配置复测 |
|---|---:|---:|---:|
| source RAF/render FPS |60.00|60.03|59.98|
| atlas FPS |59.71|59.94|60.05|
| encode FPS |59.48|59.94|60.05|
| decode FPS |59.48|59.91|60.02|
| 接收端实际RAF Hz |56.54|59.96|59.98|
| rVFC metadata presentedFrames FPS |59.45|59.90|59.97|
| 实际rVFC/authorized/canvas FPS |48.94|54.86|45.25|
| marker p50/p95/p99 ms |61/73/81|72/122/138|57/74/124|
| CRC有效/无效 |30/0|30/0|30/0|
| 平均worker队列等候ms |1.035|0.147|0.038|

计数按各peer自己的30秒测量窗口对齐；source只取该窗口内RAF/renders，atlas/encode/decode取同窗RTC快照首尾差，canvas使用独立成功paint计数，不能用metadata累计帧数代替它。首次实际30019.5ms，复测30012.5ms。两组frameGate missed0，正式窗口atlasPoolDrops0、RTC packetsLost/framesDropped0、Endpoint error/errorDrops0；pendingReplaced增量1/0，网络整形丢包0。

首次30个marker中28个为47–74ms，两个122/138ms使p95超标。按同RTP的接收时间分解：122ms帧receive→canvas3.6ms、render→receive118.4ms；138ms帧分别17.7/120.3ms。138ms点rVFC间隔83.5ms，但到达接收端之前已消耗120.3ms，不能把这两个异常全部归于接收回调。复测124ms异常同样render→receive103.8ms、receive→canvas20.2ms。未开逐帧server trace，本组无法把异常的到达前时间精确拆成capture、编码、pacer和传输各段。

| 分段统计ms | 旧DLL/同fixture | 精准60首次 | 精准60复测 |
|---|---:|---:|---:|
| capture→ready快照p50/p95 |6.50/12.45|19.10/22.77|9.37/11.30|
| lastEncode快照p50/p95 |8.31/13.02|6.14/8.89|8.04/9.24|
| GPU copy快照p50/p95 |3.26/6.54|4.99/7.27|2.18/4.49|
| RTC平均decode |0.932|0.788|0.821|
| RTC平均jitter buffer |3.429|3.748|3.952|
| RTC平均processing |4.439|4.603|4.855|
| receive→rVFC p50/p95 |8.7/17.0|10.3/15.5|4.8/17.5|
| video presentation→rVFC p50/p95 |7.4/15.6|9.2/14.3|3.8/16.2|
| marker同步readback p95 |见原组|6.8|6.0|

capture/encode/copy是32个约秒级last-value快照分布，并非所有帧的耗时分布；RTC平均值取累计耗时/累计帧数差；receive/rVFC来自逐帧metadata。首次capture→ready快照升高、复测恢复，且两次canvas相差约10FPS；这支持继续检查稳定相位/调度，不能凭首次FPS宣布通过，也不能凭复测的较低p95认为回归已经消失。高精度timer是否改变同GPU进程其他延迟任务的计时请求，留给独立源码审查与下一单变量实验，本组不改binary。

## 四1080 compositor render30

目录：`develop/tmp/precise-fake60-compositor-t4-r30`。这是**不同动态绘制负载**，用于比较绘制与媒体复制成本，不能冒充原canvas负载。fixture仍有动态marker与完整媒体像素。

| peer |source render|atlas|encode|decode|真实canvas|marker p95ms|CRC有效/无效|平均队列ms|实际RAF Hz|
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|0|29.99|28.63|14.00|13.93|7.63|576|27/0|15.58|51.61|
|1|29.99|28.99|14.23|14.13|7.90|605|26/0|15.71|51.14|
|2|30.02|28.96|13.36|13.30|7.83|558|27/0|16.28|49.77|
|3|30.02|29.12|13.56|13.53|7.70|522|27/0|14.25|50.11|

GPU3D99.85%，因此没有追加compositor60。源绘制仍约30FPS，但atlas→编码已丢失约一半供给，不能说只是客户端marker读回导致。Endpoint capture→ready快照p95为71–83ms，GPU copy快照p95为59–70ms、lastEncode快照p95为56–70ms；RTC平均decode91.6–116.7ms、jitter13.1–13.8ms、processing104.9–130.7ms。接收receive→rVFC p95为214–316ms，而presentation→rVFC p95仍约15.5–16.4ms。

同步marker readback p95为331.5/370.6/408.2/339.4ms。它发生在记录canvas draw submission之后，因此不是直接相加到当前marker的记录延迟；它会阻塞同接收renderer的后续工作，并与四个接收端共享GPU，确实构成测量干扰和实际工作负载。当前数据没有关闭marker的配对组，不能量化其独立贡献，更不能把GPU满载、服务端编码吞吐下降及解码耗时全部解释为marker造成。

正式窗口atlasPoolDrops增量25/10/7/5、pendingReplaced440/439/466/466；RTC packetsLost均0、framesDropped为0/1/0/0，Endpoint error/errorDrops0、frameGate missed0，整形器丢包0。整形调度延迟有同机争用，保留在原始networkSimulation中，不能把所有端到端延迟归于GPU。

## 资源与结束状态

物理引擎不相加；驱动VideoDecode计数器名称不代表Endpoint只做解码。

| 引擎/角色平均占用% |旧DLL同fixture|精准单首次|精准单复测|精准四compositor30|
|---|---:|---:|---:|---:|
|3D总计|78.93|75.79|72.76|99.85|
|3D sourceGPU|24.39|23.47|24.99|41.71|
|3D sourceBrowser|5.03|5.12|4.94|11.83|
|3D Endpoint|18.39|18.18|18.25|26.68|
|3D receiverGPU|17.35|18.55|15.02|13.29|
|VideoDecode总计|18.83|16.49|16.78|23.59|
|VideoDecode Endpoint|11.68|9.81|9.60|15.41|
|VideoDecode receiverGPU|7.15|6.68|7.19|8.18|
|VideoProcessing Endpoint/总计|7.60|6.93|7.97|9.88|

三组完整资源窗口分别30/29/29个样本，GPU collection errors0、resource.err为空。采样器平均CPU0.05294/0.05295/0.07974核，collection84.78/85.05/247.69ms，采样开销没有当作零。没有构建或其他GPU实验重叠。

每组保留config、fingerprints、metrics/client-metrics.jsonl、source-trace、endpoint-responses.jsonl、resource-samples.jsonl、resource-summary.json，以及本轮派生stage-summary.json/segments-summary.json。复测无pageerror、RTC close200/63.4ms；四组peer无pageerror、close均200/57.8–156.3ms，未见drain timeout。

所有自建接收端、source与Control已关闭，3001/3013无监听，host-managed正式browser_close完成，GPU交还主Agent。未修改产品/fixture/默认参数、未构建或提交。
