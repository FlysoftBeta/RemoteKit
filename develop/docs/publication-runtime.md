# 绝对publication节拍与模拟60Hz接收端实播

2026-11-01，主 Agent 分配独占GPU/managed browser窗口，全部构建结束后开始。使用正式prepare/benchmark/resource工具；不修改fixture，不构建。

## 二进制与配置

- source browser `out/dev/remotekit_browser.exe` SHA256 `7AD9D280B570EAF9B2C439C64550CB230AE3083940DE0878917600512A2BC168`，含新绝对publication节拍。
- service SHA256沿用 `B7FB545A05359417DA74A390ACD260D8C565004D3B1D6392D13199FF74C50208`。
- 新客户端 `out/rel/chrome.exe` SHA256 `F833F59831E7D428E1527BF1E12C0D4A2B338A0CBD4239A050F280C1C62EA62A`，同目录chrome.dll `D26882E6555C6A970A79DE3F91B7DCD003F5681976EE0A168E8A061396026F1F`。
- 正式prepare新增指纹：客户端exe同目录chrome.dll存在时也记录SHA256。

单租户1080 DIP/DPR1，真实source/encoded1936×1088，external16/direct、render60、TU1/VBR/d1、snapshot、RTP0/0、RTT10ms/每peer24Mbps、marker1Hz、暖机5秒/采样30秒，ResourceProfile开启，媒体/ServerTrace关闭。真实版本通过Browser.getVersion记录；Chrome89默认客户端和新Chromium157/fake60分开报告。

## Chrome89默认组

`develop/tmp/publication-abs-c89-t1`，真实客户端 `Chrome/89.0.4389.90`，无模拟刷新flag。有效30秒、CRC30/0无效，HTTP200正常关闭，无Endpoint/pageerror、正式窗口RTC丢包增量0。

| 阶段 | FPS |
|---|---:|
| source RAF |60.01|
| source render |54.84|
| Endpoint atlasCopies |54.95|
| encodeCompleted |54.89|
| framesDecoded |54.72|
| 真实canvas paint |30.92|

Marker p50/p95/p99为57/82/116ms；worker平均队列等候0.565ms，pendingReplaced增量2、atlasPoolDrops增量0。发布后各环节已接近源render供给，原55→42的额外publication损失没有再次出现。客户端约32Hz显示限制仍在，不能把解码54.7当作呈现54.7。

GPU引擎均值：3D70.00%、VideoDecode17.82%、VideoProcessing7.65%；其他已枚举引擎0。3D角色sourceGPU23.32%、sourceBrowser4.83%、endpoint18.88%、receiverGPU11.63%；VideoDecode角色endpoint10.73%、receiverGPU7.09%；VideoProcessing为endpoint7.65%。角色之和不等于物理总计，其他进程占用仍会计入总计。

采样器均值0.0616 CPU核、collection87.19ms；Endpoint0.311核，sourceGPU0.298核、sourceRenderer0.354核、receiverGPU0.0556核。完整结果在resource-summary.json、stage-summary.json。

## 新客户端首次连接阻碍

`publication-abs-c157-60-t1`实际Browser.getVersion `Chrome/157.0.8103.15`，真实flag包含 `--fake-vsync-rate=60`，exe/dll指纹与新构建一致。正式driver在displayReady等待20秒超时；短诊断保存了 `/api/metrics` 的 `client-connect-failure`。

根因是客户端产品guard：`receive-profile.ts`在非89 UA使用 `chrome89-h264-42` 时直接拒绝，错误为“Chrome 89 实验接收档只适用于明确的 Chrome 89 测试客户端。”。连接尚未送出有效offer，服务端encodeSubmitted=0、renderHost disabled，因此这不是GPU/编码吞吐失败。

新客户端getCapabilities确有H264 constrained baseline/packetization-mode1（原生默认level31）；不能用native level31重试而静默降低分辨率，也不能伪装UA。已报告主 Agent，需泛化同等level42 preset并完成Control构建后再继续同条件新客户端组。首次失败组保留，不计入性能结果。

首次阻碍后全部进程清理，GPU交还主 Agent供修复窗口；新preset完成构建后，再按独占窗口恢复以下验证。

## Chromium157模拟60Hz正式组

`develop/tmp/publication-abs-c157-60-level42-t1` 使用新的显式 `h264-level42-experimental` 档，真实客户端仍157、未伪装UA；`--fake-vsync-rate=60` 为官方有节拍模拟刷新，不代表物理扫描输出。新bundle `index-C64R1vkN.js` SHA256 `2F6EBB62386217D78702ACB942D498273222C1048C6F3773B6AC759EA8B75E5C`。它泛化接收档检查，未改变呈现路径；旧Chrome89组bundle早于该新增档。

其余source binary、fixture、1080DIP/DPR1、external16/direct/render60/d1/TU1/VBR、RTP0/0、marker1Hz、RTT10/24Mbps、snapshot、ResourceProfile与前组相同。实际source/encoded/video1936×1088、mediaScale1、actualLevel42，未下采样；正式offer把42e01f改为42e02a，服务端记录receiveLevel/actualLevel42。不得因answer的本地最大能力42e033而把实际编码报为level51。

| 同组阶段 | FPS |
|---|---:|
| source RAF |59.97|
| source render |54.74|
| atlasCopies |54.85|
| encodeCompleted |54.85|
| framesDecoded |54.79|
| 接收端RAF |56.51|
| 实际rVFC callback |47.35|
| authorized frame |47.35|
| 真实canvas paint |47.35|

有效采样30012.8ms、CRC30个有效/0无效，Pixel marker p50/p95/p99=57/97/118ms；**未达到同组≥50FPS目标**。全部样本可见，无Endpoint/pageerror；worker平均队列等候0.276ms，pendingReplaced/atlasPoolDrops/RTC packetsLost/framesDropped均无增量，整形器丢包0。HTTP200关闭约39.3ms。

资源测量窗口29个完整样本，resource.err为空、metrics读取错误0。GPU3D均值69.98%、VideoDecode15.17%、VideoProcessing6.55%，其他已枚举引擎0。3D角色sourceGPU20.39%、sourceBrowser4.60%、endpoint16.60%、receiverGPU16.09%；VideoDecode角色endpoint9.07%、receiverGPU6.10%；VideoProcessing为endpoint6.55%。Endpoint CPU0.308核、sourceGPU0.281核、sourceRenderer0.336核、receiverGPU0.157核。采样器0.0525核、collection均值79.15ms。

source→编码→解码已接近55FPS，下一损失在接收video到真实回调：rVFC metadata的presentedFrames首尾差1644，时间差对应54.82FPS，但实际独立rVFC回调1421个，对应约47.35FPS。不能把metadata累计帧数当canvas呈现帧数。frame gate匹配1422、missed0，metadata多数早于video到达；每帧snapshot p950.7ms、viewport draw p950.1ms，callback total p951.3ms/max40ms，marker同步读回p9511.5ms/max38.1ms。当前为after-work重注册，下一次可有界比较既有before-work开关，维持marker和真实canvas计数，区分回调相位/主线程错过与绘制成本；不再盲目扩大编码矩阵。

## 新客户端功能补验与清理

`publication-functional-c157`：同新binary/preset/synthetic60/external16。change-stop最初停止后尾提交/完成恰1且submitted=completed100；重新输入CRC stimulus123成功。随后同连接desktop1280×720的source/video/layout1296×736，epoch3/generation2，再回1920×1080为1936×1088、epoch5/generation3；手动connect后epoch6/generation4、新video decoded5，仍有有效marker、displayReady=true。各阶段无Endpoint/pageerror。输入聚焦后光标产生真实damage，后续tail累计不作为单变化尾帧试验。

功能组资源与正式组分开；没有CPU构建/其他GPU采样重叠。全部自建Control/source及后代、Chrome157已退出，3001/3013无监听，所属managed默认host正式browser_close，GPU交还主 Agent。未改fixture、降采样、关闭marker、扩大四租户矩阵或提交。

## before-work单变量对照

`publication-c157-beforework-t1` 完全沿用上一正式157 synthetic60/level42组，唯一改变 `-CallbackRegistration before-work`，同样5+30秒、真实1936×1088、marker1Hz、ResourceProfile开启。实际elapsed30014.2ms，CRC30有效/0无效、无Endpoint/pageerror、RTC关闭HTTP200。

| 同组阶段 | after-work FPS | before-work FPS |
|---|---:|---:|
| source RAF |59.97|60.00|
| source render |54.74|54.31|
| atlas |54.85|54.45|
| encode |54.85|54.49|
| decode |54.79|54.29|
| 客户端RAF |56.51|56.44|
| rVFC/authorized/canvas |47.35|47.04|
| marker p50/p95/p99 ms |57/97/118|54/87/121|

before-work没有提高实际回调/呈现FPS，仍未达50；此次p95较低不证明注册策略有稳定延迟收益。worker平均队列等候0.140ms、pendingReplaced0、atlasPoolDrops增量1、RTC丢包/丢帧增量0、整形器丢包0。保持原默认的依据不变，不因一次延迟较低切换产品默认。

GPU3D71.71%、VideoDecode15.60%、VideoProcessing6.60%；3D角色sourceGPU20.87%、sourceBrowser4.56%、endpoint16.58%、receiverGPU16.50%，VideoDecode角色endpoint9.44%、receiver6.15%。完整测量窗口29样本，metrics读取错误0、resource.err为空；采样器0.0558 CPU核、collection102.12ms，Endpoint0.335核、sourceGPU0.334核、receiverGPU0.196核。原始数据和stage/resource-summary.json均保留。

`publication-beforework-lifecycle` 是独立功能组，before-work、同binary/preset/刷新模式。临时driver只包装正式paintPlane/authorizeFrame观察入口深度与成功paint的identity，未绕开保护或修改产品源码；当前snapshot使用同步drawImage，没有异步snapshot Promise。动态→静态、刺激123、同连接720→1080、重连均displayReady/CRC有效，无错误。观察106次成功paint，renderer/layout epoch与generation不一致0，paint/authorize最大嵌套深度均1；几何改变后明确把旧renderer再送正式paintPlane入口，返回false，没有旧epoch绘制。重连video身份确已改变，旧video paused=true、srcObject=null。

以上是实际运行的非重入与旧renderer拒绝证据；没有人为延迟GPU readback或注入异步Promise完成，不把它扩写成所有异步故障负例均覆盖。两个新组已清理全部自建进程、3001/3013与managed host，GPU交还主 Agent，不扩大其他参数或四租户矩阵。

## 120Hz模拟刷新定向诊断

主 Agent 授权将正式prepare的ClientRefreshHz可选值扩为0/60/120，其他工具行为不变。`publication-c157-synthetic120-t1` 与最初157/60组仅将官方flag改为 `--fake-vsync-rate=120`，保持after-work、marker1Hz、相同codec/source/fixture/网络/尺寸和ResourceProfile，5+30秒。**该组是120Hz诊断，不能写成60Hz验收通过；也不覆盖四租户目标。**

有效30014.2ms，实际客户端RAF102.35Hz（没有按flag值虚报实测120Hz）。真实source/encoded/video1936×1088，DPR1/mediaScale1、H264 actualLevel42，客户端157.0.8103.15，未下采样、关marker或改变编码参数。

| 同组阶段 | FPS |
|---|---:|
| source RAF |60.00|
| source render |54.21|
| atlas/encode |54.32|
| decode |54.22|
| rVFC metadata presentedFrames差值 |54.23|
| 实际rVFC / authorized / canvas |51.98|
| 客户端RAF |102.35|

Pixel marker p50/p95/p99=50/76/106ms，CRC30有效/0无效，**本诊断组同组真实canvas51.98FPS与marker p9576ms同时达到数值目标**。Endpoint/pageerror0，RTC packetsLost/framesDropped、atlasPoolDrops/pendingReplaced增量均0，整形器丢包0，平均队列等候0.246ms，HTTP200关闭约40.5ms。

与60Hz after-work的47.35FPS/p9597ms相比，上游render/编码供给仍约54–55，而实际回调/paint增长到51.98，支持接收刷新与跨线程采样节拍造成额外损失；不能再把这一差额归为编码吞吐或frame gate拒绝。单组不是对所有环境的稳定性保证，下一参数/验收口径由主 Agent 决定。

资源有效窗口29样本、读取错误0、resource.err为空。GPU3D72.41%、VideoDecode15.36%、VideoProcessing6.55%，其他已枚举引擎0。3D角色sourceGPU20.39%、sourceBrowser4.46%、endpoint16.36%、receiverGPU17.82%；VideoDecode角色endpoint9.32%、receiver6.03%；VideoProcessing为endpoint6.55%。CPU采样器0.0513核、collection均值85.02ms，endpoint0.329核、sourceGPU0.318核、sourceRenderer0.365核、receiverGPU0.215核。stage-summary/resource-summary、原始metrics和指纹完整保留在该组目录。

没有追加其他参数或四租户实验；结束后自建进程全部退出、3001/3013无监听、所属managed默认host正式browser_close，GPU已交还。

## 修复fixture相位后的60Hz新负载

`fixture-absolute-c157-60-t1` 在Control fixture build结束后、精准fake-vsync补丁尚未构建时运行。只换新fixture：`test-pattern.html` SHA256 `4CB517D8BD239E64C79C6D26D66E8FA0E374062046B43EF9813089A2874585F1`，bundle仍C64R1vkN，source browser仍7AD9D280…、receiver仍F833F598…/D26882E6…，实际指纹已核验。保持synthetic60、after-work、单1080、external16/direct/render60/d1/TU1/VBR、RTP0/0、24Mbps/RTT10、marker1Hz、snapshot、ResourceProfile、5+30秒。

这是fixture修复后的**新负载**，收益不能归于publication改动。有效30016.4ms，source RAF/render均60.00FPS；atlas59.71、encode/decode59.48、rVFC metadata.presentedFrames59.45、实际rVFC/authorized/canvas48.94、clientRAF56.54Hz。marker p50/p95/p99=61/73/81ms，CRC30有效/0无效。源供给已达到60，接收回调仍低于50；此组未达目标。

source/encoded/video1936×1088、DPR1/mediaScale1、actualLevel42，没有下采样。队列平均1.035ms、pendingReplaced增量8、atlasPoolDrops0、RTC丢包/framesDropped0、errorDrops0、Endpoint/pageerror0、整形器丢包0。frameGate matched1470/missed0，没有布局gate导致的持续拒绝。

有效资源窗口29样本、metricsReadErrors0、resource.err空。GPU3D78.93%、VideoDecode18.83%、VideoProcessing7.60%；3D角色sourceGPU24.39%、sourceBrowser5.03%、endpoint18.39%、receiverGPU17.35%，VideoDecode角色endpoint11.68%、receiver7.15%，VPP为endpoint7.60%。采样器0.0572核、collection99.29ms；CPU sourceGPU0.471核、sourceRenderer0.503核、endpoint0.444核、receiverGPU0.206核。

同一新fixture后续四租户LowPower配对单独见 `qsv-lowpower-loaded.md`，不能把旧fixture矩阵与这批新负载直接拼接。此批无构建/其他GPU任务重叠，全部组结束后清理进程/端口并正式browser_close；精准fake-vsync补丁的运行结果不在本报告这组中。
