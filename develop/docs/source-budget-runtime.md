# 自适应源准入实播：三租户与两租户

2026-11-01，三项配置完成。自适应确实消除了大部分源积压，并提高真实canvas吞吐；两租户同组Pixel marker p95为91/99ms，canvas为35.11/31.33FPS，仍未达到每租户50FPS的完整目标。三租户为21.17–23.74FPS、p95 152–156ms。没有将降低后的源预算当作达标。

## 条件与验证

使用host-managed Playwright及browser-use skill，没有操控桌面鼠标键盘。没有CPU构建或其它实验重叠。代码为已构建的a228cb9，未改产品、正式工具或fixture。接收端Chromium157.0.8103.15，精准synthetic `--fake-vsync-rate=60`，continuous-rVFC关闭、默认video、MSTP关闭。模拟刷新结果不代表物理扫描输出；Chrome89支持未变。

所有组保持原canvas fixture、source请求60、1920×1080 DIP/DPR1、source/encoded/video 1936×1088、mediaScale1、CRC marker1Hz、external VPP、SinglePlaneDirect、alignment16、snapshot/after-work、RTP0/0、VBR/TU7/depth1、请求36/max44Mbps、每peer独立48Mbps/RTT10ms。三租户on和两租户on均10秒暖机+45秒统计；两租户off为5秒+30秒。

Endpoint SHA256 `BFFE36417FBCF2445F73CA5BC0A0330F51F15FD87F0007346D9ABA48645A9CF4`；source browser `7AD9D280B570EAF9B2C439C64550CB230AE3083940DE0878917600512A2BC168`；receiver exe `F833F59831E7D428E1527BF1E12C0D4A2B338A0CBD4239A050F280C1C62EA62A`、DLL `20C0F298D2012B6841BA8ACB7AF7F62DC6DF23A40F899073C9D74DD0FC034FCC`；fixture `4CB517D8BD239E64C79C6D26D66E8FA0E374062046B43EF9813089A2874585F1`。每组fingerprints保留Client bundle及全部文件hash。

功能检查在首组运行期间检查实际snapshot，并在结束后遍历全部snapshot：on三租户54/52/49份、on两租户47/45份，target/applied/browser `configuredFps`完全一致，错误字符串为空。实际TU全程7，LowPower requested/queried/initialized/GetVideoParam均16，init/get状态0、query警告5。renderHost controllerGeneration保持1，页面1920×1080、nativePageWindow=false；fixture导航后document为2。正式窗口marker epoch与output generation始终1、displayReady全true，没有因调速改变几何或重建输出。worker已通过真实output.configure调用改变源pacer，而非只改统计字段。

## 同组结果

source为JS实际render，atlas为Endpoint实际copy，canvas为成功paint。decode使用同窗RTC累计差；不用metadata presentedFrames代替canvas。

|组|peer|source|atlas|encode|decode|canvas|marker p50/p95 ms|CRC有效/无效|
|---|---:|---:|---:|---:|---:|---:|---:|---:|
|三租户on|0|24.41|24.35|24.19|24.24|23.41|87/156|44/0|
||1|21.75|21.64|21.62|21.57|21.17|106/155|44/0|
||2|25.08|24.91|24.84|24.77|23.74|114/152|44/0|
|两租户off|0|59.94|40.09|26.66|26.66|22.99|328/444|30/0|
||1|59.77|42.12|26.56|26.56|23.42|348/401|29/0|
|两租户on|0|38.62|38.45|37.92|37.90|35.11|71/91|45/0|
||1|33.64|33.59|33.30|33.19|31.33|66/99|44/0|

三租户此前同条件off为约12.5FPS、p95 852–921ms；本轮on使实际吞吐增加且显著降低延迟。两租户off依然饱和，所以继续唯一授权的两租户on，没有再扩模式矩阵。最佳on仍离50FPS有15–19FPS差距，未追加没有达标依据的重复组。

## 控制时间线与分段

完整每秒target/applied/原因/feedback age以及browser配置变化见各组 `budget-details.json`。snapshot约1.5秒一次，会跳过中间控制决策，不能用相邻snapshot间隔反推RPC精确频率。

三租户起始预算60，约首10–12秒各peer降到16/16/24，随后健康恢复与pipeline_pressure降速交替，peer0最高恢复31，peer1约16–25，peer2约19–30；所有observed target和applied相同。两租户on起始60，约前4–6秒降到30，随后逐步恢复：peer0最高46后降36、又恢复42后降33；peer1多次恢复到38–40后降到27–32。原因只出现reset、pipeline_pressure、healthy_recovery，没有network_pressure或控制错误。off保持60。

|组|capture→ready p95 ms|private GPU copy p95 ms|encode p95 ms|queue均值 ms|pendingReplaced|marker readback p95 ms|
|---|---:|---:|---:|---:|---|---:|
|三租户on|20.2–27.9|16.1–24.4|16.4–16.8|0.78–1.29|7/2/4|50.7–55.5|
|两租户off|44.0–45.3|38.8–40.1|25.2–30.3|8.45–8.61|402/468|94.0–100.6|
|两租户on|16.6–23.0|13.0–21.7|11.1–15.3|1.10–1.33|24/14|15.7–19.4|

capture/copy/encode为秒级last-value快照分布，不是全部帧trace。两租户on的RTC decode均值1.38–1.39ms，processing均值2.78–2.85ms；off为decode8.02–8.13ms、processing9.57–9.59ms。on接收后到callback p95约17.4–17.7ms；延迟较大marker仍主要发生在到达前，例如peer0最差102ms中render→receive94.7ms、receive→canvas7.3ms。

marker验收终点继续为canvas提交，CRC读回完成耗时另列。两租户on读回下降说明总GPU压力减少，但同步读回仍占共享GPU。所有组endpoint error/errorDrops0、RTC framesDropped/packetsLost增量0；frameGate missed/wrongEpoch/missingRtp均0。两租户off atlasPoolDrops为9/5，其余0。正式窗口没有displayReady=false。

## GPU、网络与资源

引擎平均占用%，不同引擎不相加。VideoDecode是驱动计数器名称。

|角色/引擎|三租户on|两租户off|两租户on|
|---|---:|---:|---:|
|3D总计|90.54|99.80|86.95|
|3D source GPU|33.70|50.27|31.37|
|3D source browser|7.30|8.14|6.73|
|3D Endpoint|10.67|10.56|9.92|
|3D receiver GPU|29.66|19.57|25.95|
|VideoDecode总计|44.65|34.81|39.80|
|VideoDecode Endpoint|34.02|26.42|29.97|
|VideoDecode receiver|10.63|8.38|9.83|
|VideoProcessing Endpoint/总计|11.48|9.41|10.27|

整机CPU p50/p95依次54.96/73.46%、52.77/72.77%、41.43/56.04%。资源采样45/30/45份，GPU errors0，resource.err为空；采集器平均约0.068/0.113/0.080核。

实际receiver码率三租户on1.73–1.92Mbps、两租户off2.00–2.19Mbps、两租户on2.55–2.82Mbps；sender分别1.71–1.91、2.00–2.11、2.52–2.84Mbps。请求高码率已经生效，实际VBR未用满预算。appliedBitrate中位约35.61–37.34、37.27–37.58、36.45–37.70Mbps。网络配置/累计整形数据完整保留于budget-details及原metrics，不把请求值当作实际吞吐。

## 产物与后续判断

目录为 `develop/tmp/source-budget-on-t3`、`source-budget-off-t2`、`source-budget-on-t2`。每组保留config/run/fingerprints、原metrics、source-trace、endpoint-responses、resource-samples/summary、stage-summary、segments-summary、budget-details。完整metrics loader重组并校验所有7个benchmark成功。通用工具paint列仍有frameCountStage兼容问题，本文直接使用完整报告displayFps，没有缺数据。

本轮证明源准入有效，当前剩余差距包括源预算/源吞吐与接收video→canvas的帧损失；两租户on的平均GPU仍86.95%，瞬态压力与每Session独立恢复会影响预算。本轮没有改变策略阈值，也没有证明进一步提高预算必定能在100ms内达到50FPS；下一项应由主Agent据此选择。

三个case自有Control/source/Endpoint/browser均已停止；3001/3013无监听，host browser_close完成，GPU实验窗口已释放。两租户两组pageerror为空、RTC close均HTTP200。三租户host调用正常完成并关闭浏览器，完整指标已落盘；其host结果未另存JSON，功能/性能证据以原metrics和snapshot为准。没有commit/push。
