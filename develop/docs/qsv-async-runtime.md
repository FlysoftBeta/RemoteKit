# QSV async VPP 正式运行验证

2026-11-01，独占 GPU / managed headed Chrome89 窗口；无 CPU 构建重叠。结论：候选已通过单租户视频、输入、d1/d2/d4、尾帧、重连和几何切换实播。相同尺寸的单租户对照没有吞吐收益，仍未达到真实呈现≥50FPS目标。主 Agent 随后授权唯一四租户配对；首轮资源采样工具异常导致A/B采样开销不对称，不能据此宣称吞吐收益或退步。

## 固定条件与证据

正式 `prepare-streaming-case.ps1` + `streaming-benchmark.js`，Chrome `89.0.4389.90`，默认客户端模式，H264 level42，QSV TU1/VBR，RTT10ms、每 peer24Mbps；未关闭 marker、未使用 unlimited/disable-vsync/software 模式。所有组显式 `RemoteKitSinglePlaneDirect`，客户端仍 snapshot presentation。

SHA256 实际核验：

- Release service：`B7FB545A05359417DA74A390ACD260D8C565004D3B1D6392D13199FF74C50208`
- browser：`159A54CF70C2EA14289F6243F4EDEFD29463B643B01BCE1BDAB5A68F7B82C91B`
- Client `index-COuWf0fP.js`：`7B943C364BE32232FBACA36D84D9FA1E8E93FBF5EB137567DE812D0F5549D46C`

每组在 `develop/tmp/<组名>` 保存 config、fingerprints、临时 driver、metrics 和日志。没有修改媒体/浏览器源码、build、commit 或 push；后续按主 Agent 授权修复正式资源watcher。

## 功能

`qsv-async-functional-d1/d2/d4`：真实 source/encoded/video 均1936×1088，plane 1920×1080 DIP，DPR1。首帧 CRC marker 有效、displayReady=true；change-stop 初次停止后各组尾 IDR 提交/完成均为1，队列清空。d1 在静态输入 `RK:123;` 后读到 stimulus123，尾累计2，随后重连新 epoch/generation 后继续有有效 marker。d2/d4 同样恢复输入和重连，无 pageerror、Endpoint error、cookie/Locked/lease 错误。静态时提交完成相等；RTC close 均返回成功，无五秒 drain timeout。

输入重新聚焦后 textarea 光标仍会产生真实 damage；d2/d4 重活动后的累计 tail 可能多于2，不能将这部分作为“只有一次源变化”的尾帧试验。初次 change-stop 的无输入停止段各组均恰1。

`qsv-async-input-color`：DataChannel mouse down/up 在 viewport DIP(300,30) 被页面记录为 `mouse 300,30`，userActivation=true。`ime_set` 的“中文测试”在截图中有组合文字/下划线；commit 后页面记录 `compositionend:中文测试 RK:456;`、lastInput 相同，视频 CRC stimulus456。这里只验证协议 composition 注入，不代替物理 IME 人工操作。此组临时 fixture 额外把 DOM input/capabilities 附到原 source-probe 对象，用于证据；正式 fixture 没改。

Sol 视觉检查 `first.png`、`composition.png`、`decoded.png`：动态深蓝背景、静态浅黄背景、青色方块、深色/白色文字、marker 与中文组合文字正常。`decoded.png` 为完整1936×1088解码帧；右padding没有旧组的明显绿边。y600采样：x1924=(255,255,238)，x1925=(254,255,253)，x1928=(255,255,254)，x1935=(255,255,255)；页面边界有YUV色度过渡，最右列为白。未做与 external 同帧静态质量对照，因此不宣称既有绿边问题根因已闭合。

## MORE_DATA 与 flush 覆盖

Server trace 的 `mfx_submit_return status=-10`：d1为0次、d2为19次、d4为17次。该事件位于 `SubmitEncode(Task&)` 的非 NULL 输入调用，包含真实 task cookie；VPP submit 没有负返回。对应运行后续仍真实完成和继续输入，停止快照 submitted/completed 为 d2 81/81、d4 82/82，未卡住。

当前正式 trace 没记录 NULL flush / end-drain 调用的独立事件与返回，因此不能给出其真实调用次数，也不能把上述计数写成 NULL flush status。是否触发 delayed-cookie、混合 busy、纯 held midstream flush 的具体时序，交独立 probe 或新增观测确认；本轮只确认实际非 NULL Encode MORE_DATA 与随后持续完成。错误/Locked负例没有注入。

## 几何

`qsv-async-geometry` 同连接串行切换，各阶段均 displayReady=true、有效当前首plane CRC、Endpoint error=null。实际 source metadata / 编码尺寸：

| 阶段 | source atlas | encoded/video | 页DPR | mediaScale |
|---|---|---|---:|---:|
| 单 desktop |1936×1088|1936×1088|1|1|
| 双 desktop split |3856×1088|2778×784|1|0.7204357|
| 返回单 desktop |1936×1088|1936×1088|1|1|
| tablet820×1180 |1664×2384|1240×1776|2|0.7449664|
| 返回 desktop1920×1080 |1936×1088|1936×1088|1|1|

双plane布局确有两个1383×778编码plane；tablet plane1222×1758、deviceScaleFactor2，返回desktop重新为1920×1080。日志每次 VPP lazy init 均 `composite=0`、fit=完整encoded尺寸，均为full-fit。该矩阵没有触发 Composite 黑边分支；没有验证固定encoded尺寸下单独source变化的完整用例，未把几何重建成功等同所有缩放/黑边场景。

## 同尺寸性能对照

`qsv-external16-t1-r60` 与 `qsv-async16-t1-r60`，同binary、source/encoded1936×1088、1920×1080 DIP/DPR1、d1、render60、RTP0/0。profile/媒体trace全部关闭，暖机5秒、采样30秒，marker1Hz。实际 elapsed30007.56/30008.345ms，所有样本可见、无 pageerror/Endpoint error、无整形器丢包。

| 路径 | 真实canvas FPS | Pixel marker p50/p95/p99 ms | 有效marker | 编码完成FPS | 解码FPS | 接收RAF Hz |
|---|---:|---|---:|---:|---:|---:|
| external16 |29.73|59/81/85|30|42.69|42.69|31.86|
| async16 |30.39|58/80/80|30|42.73|42.66|32.39|

FPS从同组计数差/有效时段计算，marker invalid均0。源页面同采样时段实际render54.92/54.98FPS，atlas42.69/42.66FPS。因此编码/解码42.7与atlas供给接近，但源网页仍约55，不能归为网页render只有42。单租户profile全关，没有GPU引擎均值，不能推定GPU未饱和。单租户实际吞吐接近、延迟接近，不据此宣称async更快，也不排除重载收益。接收端仍受已定位的无DXGI output/RDP会话约32Hz显示节拍限制；即使解码42.7FPS也未到50。24Mbps是网络预算，实际编码约3–4Mbps，不把带宽预算当作实发码率。

## 四租户首轮资源采样失败

主 Agent 追加授权 `qsv-external16-t4-r30` / `qsv-async16-t4-r30`：4×1080、同1936×1088真实对齐尺寸、render30、d1/TU1/VBR、24Mbps独立预算/10ms RTT、RTP0/0、direct、5+30秒。两组相同开启ResourceProfile（系统counter与endpoint tee），媒体trace/ServerTrace关闭。

external的resource watcher在暖机时读client-metrics文件，与Node append冲突，`StreamReader(metrics)`抛IOException而提前退出，没有测量窗口重叠GPU样本。async watcher正常记录30样本。该开销不对称，首轮不作为干净A/B结论；失败证据在external/resource.err。

| 路径 | canvas FPS范围 | marker p95范围ms | 源render FPS | atlas FPS | 编码FPS | 队列等候/帧ms |
|---|---:|---:|---:|---:|---:|---:|
| external，counter提前退出 |8.53–8.80|638–653|29.78–30.02|28.39–28.66|14.73–15.36|14.02–15.22|
| async，counter完整 |6.73–7.53|730–912|28.15–29.75|22.86–25.46|14.09–15.30|9.26–10.27|

两组均无Endpoint/pageerror、marker invalid0、整形器丢包0/RTC丢包0。async单组资源事实：UHD630物理3D均值99.58%，VideoDecode25.98%，其他已枚举引擎0；3D按角色source-gpu50.87%、endpoint27.83%、receiver-gpu11.27%、source-browser9.59%。VideoDecode角色endpoint17.27%、receiver8.71%；引擎名称是驱动counter标识，不能从名称推定编码工作未发生。采集器0.130 CPU核、每次counter采集222.55ms。这证实该组共享3D满载，不能用队列等候下降单独认定媒体链改善。

原失败组完整保留并排除A/B判断。主 Agent 随后授权修复共享读取并重跑同一配对，结果如下。

## 正式watcher修复与四租户重测

修改 `tools/watch-streaming-resources.ps1`：metrics FileStream显式 `FileAccess.Read`、`FileShare.ReadWrite | Delete`，允许Control同时追加与文件替换。保留前8行JSON识别逻辑，IOException不终止采样，在下一次inventory重试；每个资源sample记录累计 `metricsReadErrors` 与最后错误，失败同时Write-Warning。非IO异常继续报错。AST语法及持有写句柄时读取root JSON的基本检查通过，没有添加实现镜像测试。

新配对 `qsv-external16-t4-r30-sharedread` / `qsv-async16-t4-r30-sharedread`，全部参数、fixture与binary沿用，四peer每个5+30秒、两组ResourceProfile完全一致、媒体/ServerTrace关闭。资源测量窗口各30样本、metricsReadErrors=0、resource.err为空；没有CPU构建重叠。

| 路径/peer | source render | atlas | encode | decode | canvas FPS | marker p95ms | CRC有效/无效 | 队列等候/帧ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| external/0 |29.59|26.46|14.16|14.26|7.86|724|27/0|15.95|
| external/1 |29.52|27.63|14.16|13.90|8.08|668|28/0|16.33|
| external/2 |29.99|28.02|14.00|13.76|7.98|687|28/0|15.57|
| external/3 |29.66|27.33|13.26|13.20|7.40|747|28/0|17.82|
| async/0 |29.45|24.82|15.29|15.26|7.50|789|28/0|9.17|
| async/1 |29.28|25.86|14.71|14.78|7.22|753|28/0|8.94|
| async/2 |29.62|25.69|15.83|15.70|7.16|775|27/0|8.19|
| async/3 |29.81|25.66|15.68|15.71|7.55|845|27/0|9.77|

编码完成计数有约一成提升，队列等待下降；真实canvas与marker没有改善，不能据编码单环节改动切换默认。各peer停止没有Endpoint错误、pageerror或RTC close失败。整形器两组均丢包0；async在暖机已累计RTC packetsLost157/72，正式采样窗口两者均无继续增加，另两peer为0。正式窗口async peer2/3各有1次receiver framesDropped，external均0。async RTC close最慢1.443秒，均HTTP200，没有drain超时。

GPU均值（不同引擎分别列，不能相加）：

| 物理引擎/角色 | external % | async % |
|---|---:|---:|
| UHD630 3D总计 |99.76|99.80|
| 3D source-gpu |53.22|50.74|
| 3D source-browser |11.01|9.77|
| 3D endpoint |23.53|28.14|
| 3D receiver-gpu |12.00|11.15|
| VideoDecode总计 |24.56|26.04|
| VideoDecode endpoint |16.29|17.11|
| VideoDecode receiver |8.27|8.93|
| VideoProcessing endpoint/总计 |9.71|0|

其他已枚举物理引擎均值0。采样器成本 external/async0.135/0.091 CPU核、collection均值239.59/214.19ms，p95546.43/575.96ms；不把采样器视为零开销。Endpoint CPU1.225/1.298核，sourceGPU CPU1.649/1.450核，sourceRenderer1.747/1.568核，receiverGPU0.344/0.321核。完整角色分解在两组 `resource-summary.json`。

async把原VideoProcessing工作移到更繁忙的3D引擎，endpoint3D增加，同时共享3D持续饱和。worker队列等待减少没有消除总体GPU竞争。marker同步readback的p50约external155–177ms、async191–215ms，p95约283–427ms，本机四接收端与读回成本是正式结果的一部分，不能关闭marker代替验收。下一优化应针对3D工作量、源准入/背压及实际呈现反馈。

## 10秒publication归因

主 Agent 追加唯一 `qsv-external16-publication10`：单1080 external16/render60/direct、同fixture/binary/network，暖机5秒、采样10秒，只开启browser raw，不开ServerTrace/ResourceProfile。该组用于定位，不替代profile-off性能结果。

用系统QPC/UTC anchor将同一正式客户端窗口映射到browser raw；anchor前后QPC括号2.806ms，UTC毫秒量化，边界存在约数毫秒误差。没有用整个启动trace计数除以10秒。实际测量10004.815ms，traceFull=false。

| 环节 | 同窗计数/FPS | interval p50/p95 ms |
|---|---|---|
| source RAF |601 /60.07|—|
| source render |549 /54.87|—|
| capture_callback |549 /54.87|16.02/31.22|
| direct_source_copy |424 /42.38|21.55/32.41|
| atlas_publish |424 /42.38|21.56/32.41|
| poll |601 /60.07|16.66/17.95|
| source_read_done |425 /42.48|17.28/34.32|

本窗source_counter连续无洞；125个capture callback的serial在整个trace都没有direct_source_copy，符合direct待发帧被后续capture替换。整个trace累计direct_pending_replaced217、backpressure_polls11、dropped217、mutex_drops0；这些是全生命周期计数，不能伪写为本窗增量。正式metrics窗口Endpoint copies42.59、encode42.49、decode42.29FPS，atlasPoolDrops/pendingReplaced增量0；canvas29.89、CRC10个有效/0无效、marker p9569ms。

**回调实际约55→publication约42已经直接观测，瓶颈在browser发布节拍；不是capture回调本身只有42。** 这支持主 Agent 审阅中的绝对publication deadline与dirty精准唤醒候选，现阶段无须先扩官方capture trace。原始browser JSON与 `publication-summary.json`、`clock-anchor.json` 保存在本组目录。

下一步建议：保留external默认；先用独立midstream-drain probe闭合NULL调用边界，并由主 Agent 决定四租户是否值得单组诊断。继续优化应依据共享GPU成本/背压反馈，不扩大无差别参数矩阵；最终50FPS仍需正常显示输出的默认Chrome89验收环境。

## 清理

所有自建组Control/source及后代已通过正式stop工具退出，Chrome89在driver finally关闭；3001/3013无监听，未见Chrome89/Endpoint/browser残留。所属managed默认host已调用正式browser_close。GPU窗口交还主 Agent。
