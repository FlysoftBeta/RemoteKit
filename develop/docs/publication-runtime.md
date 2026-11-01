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
