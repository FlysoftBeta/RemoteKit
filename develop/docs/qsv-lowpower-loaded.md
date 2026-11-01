# QSV LowPower 四1080满载对照

2026-11-01，主 Agent 独占GPU窗口授权；全部构建结束后运行。结论：auto在本机实际选择OFF；显式ON成功生效，但没有改善真实canvas与marker。两组3D仍接近100%，不建议因编码器某引擎变化切换默认。

## 配置与真实生效值

组目录 `develop/tmp/qsv-lowpower-auto-loaded` / `qsv-lowpower-on-loaded`，正式prepare/benchmark/resource工具。四租户，每peer1920×1080 DIP/DPR1，真实source/encoded/video1936×1088、mediaScale1；external16/direct、render30、QSV TU1/VBR/d1、RTP0/0、独立24Mbps/RTT10ms、marker1Hz、snapshot、after-work，5+30秒，两组ResourceProfile开启、媒体/ServerTrace关闭。

客户端Chromium157.0.8103.15，官方 `--fake-vsync-rate=120`，显式 `h264-level42-experimental`。本轮是synthetic120满载诊断，不混同60Hz验收。新fixture SHA256 `4CB517D8BD239E64C79C6D26D66E8FA0E374062046B43EF9813089A2874585F1`；不是旧fixture矩阵。source browser `7AD9D280B570EAF9B2C439C64550CB230AE3083940DE0878917600512A2BC168`，receiver exe `F833F59831E7D428E1527BF1E12C0D4A2B338A0CBD4239A050F280C1C62EA62A` / dll `D26882E6555C6A970A79DE3F91B7DCD003F5681976EE0A168E8A061396026F1F`，Client bundle C64R1vkN。两组fingerprints全部相同。

auto先运行，四peer都实际 `requested0 → queried32 → initialized32`，MFX_CODINGOPTION_OFF=32，所以执行显式on配对；on四peer均 `requested16 → queried16 → initialized16`，MFX_CODINGOPTION_ON=16。两组Query status5，Init/GetVideoParam均0。实际参数日志均TU1、RC2(VBR)、AsyncDepth1、nominal60/1、GOP120/RefDist1、Profile578、Level42；没有TU被驱动改写或静默fallback。

## 同组各环节

| 路径/peer | source render FPS | atlas | encode | decode | canvas | marker p95ms | CRC有效/无效 | 队列/帧ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| auto/0 |30.00|25.01|12.57|12.64|6.91|984|28/0|13.66|
| auto/1 |29.99|25.40|12.50|12.53|6.90|1055|27/0|17.36|
| auto/2 |29.99|25.06|12.86|13.10|7.10|932|27/0|16.81|
| auto/3 |29.96|25.13|12.90|12.90|6.83|1114|26/0|16.37|
| on/0 |29.85|20.83|13.60|13.56|7.03|1023|27/0|14.67|
| on/1 |29.98|20.43|12.63|12.50|7.53|1122|28/0|18.50|
| on/2 |30.02|22.06|12.93|12.93|6.96|1138|27/0|18.88|
| on/3 |29.99|21.40|13.06|12.16|6.00|1318|26/0|17.76|

source RAF与render在各peer相同；实际客户端RAF auto78.20–84.07、on80.29–82.36Hz，没有把flag120当实测120。实际rVFC≈canvas，metadata.presentedFrames约auto12.57–13.01、on12.31–13.63FPS。两组没有接近≥50FPS/p95≤100ms目标。

## GPU与采样成本

每组测量窗口30个完整资源样本，metricsReadErrors0、resource.err空、GPU collection errors0。没有CPU编译或其他GPU实验重叠。物理引擎均值如下，独立引擎不相加：

| 引擎/角色 | auto % | on % |
|---|---:|---:|
| 3D总计 |99.88|99.85|
| 3D sourceGPU |50.96|55.88|
| 3D sourceBrowser |9.62|9.40|
| 3D endpoint |21.04|15.29|
| 3D receiverGPU |11.80|12.79|
| VideoDecode总计 |20.96|46.07|
| VideoDecode endpoint |13.80|38.29|
| VideoDecode receiverGPU |7.15|7.78|
| VideoProcessing endpoint/总计 |8.79|10.13|

其他已枚举引擎均值0。驱动counter命名VideoDecode不等于该进程只做解码；仍以实际QSV编码输出计数判断编码。

LowPower ON降低endpoint3D占用，但sourceGPU占用升高且3D总计不下降，实际atlas供给下降；没有释放出终端呈现收益。采样器auto/on为0.0818/0.1388 CPU核、collection207.98/367.78ms；各组实际采样成本已报告，未视为零。CPU endpoint0.887/0.978核、sourceGPU1.407/1.840核、sourceRenderer1.495/2.010核、receiverGPU0.339/0.455核。

## 丢帧、网络和生命周期

auto正式窗口atlasPoolDrops增量9/10/4/5，pendingReplaced382/388/368/368；RTC packetsLost增量2/0/0/0，framesDropped1/1/0/0。on对应atlasPoolDrops38/2/4/0、pendingReplaced223/234/255/257，RTC packetsLost0/0/18/82、framesDropped0/0/0/14。on peer2有一次晚到metadata miss，其他各peer没有持续frameGate miss。**ON组实际丢包/掉帧已保留，不能拿其延迟差全部归为编码器。**

整形器两组droppedPackets0、Endpoint error/errorDrops0、pageerror0，各peer显示可用；服务端关闭均HTTP200，无drain timeout。同步marker读回p95 auto381–441ms、on385–456ms，反映四个本机接收端与GPU争用成本，没有关闭marker替换正式结果。

原始metrics、endpoint responses、fingerprints、resource-summary和逐peer stage-summary均在各组目录。完成后所有自建进程、3001/3013监听与managed host已清理并正式browser_close，GPU交还主 Agent。未修改fixture、codec参数、默认值、生产源码、构建或提交。
