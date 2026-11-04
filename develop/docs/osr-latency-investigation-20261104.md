# OSR 生命周期、触控与延迟排查

2026-11-04，修复与范围内验收完成，已发布[861200](https://airportal.cn/861200/YnupKqRq8U)，见[包内验收与上传](osr-lifecycle-delivery-20261104.md)。用户报告152167后出现lifecycle uncertain、navigation save重复报警、触控收尾永久等待、stats缺项、呈现比解码低约10 FPS，以及RTT约10ms时input→present体感接近1秒。另复查有屏及有屏转无屏崩溃。

## 范围与判定

- 生命周期：区分请求前拒绝、已发请求的精确 ACK、真实未知及恢复。不能把普通导航竞争变成永久不可用，不能通过重放未知导航掩盖问题。
- 触控：按 token、sequence 和 canonical 路由/终止证据收敛。没有路由与已经完成须能确认；超时本身不是完成证明。
- Client：统计同窗 decode/present；显示当前路径真实可测指标。区分 rVFC、video compositor 提交、像素回显与物理显示。
- 媒体：输入发送/接收/派发、Begin 排队、plane、atlas GPU Fence 观察、编码排队/VPP/编码、wire RTP、接收抖动缓冲/解码/呈现分别观测。各段分位数不直接相加。
- 显示切换：保留 Browser/GPU PID、退出码、设备 LUID 与日志，区分进程崩溃、GPU 丢失及媒体通道失败。

## 实验排程

不同领域静态调查和独立修改并行；GPU 计时组串行且不与编译/测试负载重叠。先以新 OSR 默认 video 单租户独立 fixture 建立本次基线，再跑必要同条件修后对照，不重复历史双租户验收矩阵。每组记录 binary/hash、配置、采样窗口、网络整形及探针开销。显示会话切换单独进行，不混入性能比较。

## 已定位的待修复路径

- `FinishLifecycle(false)` 无条件永久标记 uncertain；freeze/thaw 的导航与活跃性竞争也走此路径，Control 没有对应恢复闭环。
- 触控原序列已经完成或从未真正路由时，cleanup cancel 仍可能返回“无可取消序列”，Client 无法取得终止证明。
- decode 与 plane present 当前窗口不一致；旧 capture 字段在 OSR 下没有有效源时戳。
- 旧 server trace 分析器依赖 capture 字段，不能直接分析新 Comp/Rend。需建立新链关联及明确观测时间语义。

源码、CPU、实际Browser/H264与显示会话证据分别列在下文；未复现的用户现场和物理显示延迟不记作已解决。

## 已完成验证

原生增量已通过：Browser/SDK及触控、BeginFrame生产probe；Endpoint五项相关CTest；八项patchset可逆；SDK导出核实ABI2/RTC4。Control触控24项、呈现/反馈30项、产品操作52项及生产构建通过。本轮未运行Control全量或旧性能矩阵。[原生产物hash](../tmp/osr-native-build-20261104/artifact-sha256.txt)。

真实Browser已通过同文档和慢跨站导航与freeze竞争、保持JS堆、正常freeze/thaw、10秒ACK超时和迟到回执、精确guarded unload/GET restore、已frozen renderer退出恢复。另一个可见页面保持。故障fixture的两次工具失败单独保留，没有记作产品通过。[生命周期运行](osr-lifecycle-runtime-20261104.md)。

## 发布152167基线

新OSR默认video，1920×1080 Viewer / 1920×992远端DIP / DPR1，atlas1936×1008，UHD630/QSV。20.06秒，H264实际接收约3.845Mbps；网络整形每向5ms、48Mbps上限，选中ICE对实测RTT14–35ms。解码58.21、compositor提交54.74、rVFC54.24FPS；18次可信点击均取得像素回显，input→rVFC p50/p95为115/151.4ms，input→预计显示131/166.8ms。像素取样间隔和同步读回p95 18.8ms会扰动结果，不是物理scanout测量。

全wire关联的p95：Comp Begin→实际Fence完成观察9.83ms、观察→编码返回11.77ms、编码返回→末包接收17.92ms、末包→video提交47.60ms、解码processing1.60ms、video提交→rVFC2.20ms。分位数不可相加；接收缓冲差分均值22.20ms，RTC丢帧/丢包增量均0。窗口内21次QSV Reset总计2.253ms、p95 0.205ms，不支持其为本组巨大延迟主因。

本组没有复现约1秒或10FPS差；后续新设施与无marker窗口用于区分渲染/输入长尾和探针影响。证据位于`develop/tmp/osr-video-profile-20261104/baseline/`。

## 新设施默认组（同peer的两个窗口）

`instrumented-default-retry`包含20秒sync45像素取样及随后20秒none窗口；两窗均18次真实点击，none只关闭像素读取。主窗解码58.28、video提交54.95、rVFC51.76FPS，元素1169帧/64丢帧；none为58.46、55.48、55.53FPS，1172帧/58丢帧。因此约3FPS差并非完全由读回探针引起。主窗18/18像素回显，input→rVFC p50/p95为120.3/168ms，读回p95 21.4ms。

每个wire帧均精确关联Rend Begin、plane、Signal和ready；两窗各18次输入逐段齐全。下表为p95，不能逐行相加；末包时间是rVFC的receiveTime，GPU项是实际Fence完成的CPU观察，非GPU硬件时间戳。

| 阶段 | sync45 ms | none ms |
|---|---:|---:|
| Client DC send→Endpoint callback | 12.10 | 13.19 |
| Comp事件队列 | 1.28 | 1.54 |
| Input worker队列 | 3.35 | 3.33 |
| RPC锁等待 | 0.004 | 0.004 |
| SDK调用→Browser派发 | 0.25 | 0.31 |
| Browser派发→页面handler | 2.41 | 1.99 |
| Comp Begin→Rend | 0.18 | 0.18 |
| Rend单active Work排队 | <0.01 | 0.01 |
| plane请求→返回 | 6.09 | 2.26 |
| atlas Signal调用前→ready观察 | 7.20 | 6.95 |
| Begin→ready观察 | 13.49 | 9.47 |
| ready→SDK提交 | 0.23 | 0.24 |
| 编码worker队列 | 0.02 | 0.02 |
| VPP | 3.11 | 3.09 |
| 硬件submit→complete | 7.13 | 7.02 |
| Begin→编码返回 | 25.11 | 20.91 |
| 编码返回→末包接收（pacer与网络合计） | 18.22 | 18.09 |
| 末包接收→compositor提交 | 72.20 | 78.50 |
| 解码processing | 1.40 | 1.20 |
| compositor提交→rVFC | 2.30 | 2.20 |

RTC实际缓冲差分均值41.24/59.63ms；选中ICE RTT p50为17/19ms。各22次QSV Reset，worker SetRates p95仅0.30/0.17ms。数据支持优先检查接收端等待，不支持扩大Rend并发、改输入队列或降低Reset频率。正式分析工具已支持`--profile video-profile-clean.json`生成独立输出，避免两个窗口重复stimulus号串样。

首次`instrumented-default`在新标签页的自动化导航阶段失败，正式采样0；修driver等待产品DC并使用工具栏后仅重试一次。Stats的异步Switch校验曾使后置截图步骤报错，实际截图已显示新指标；此工具错误不作为产品故障或计时结果。

## 原生0/50ms playout对照

同binary、同条件、同peer双窗的`instrumented-max50`实际请求min0/max50。主窗video提交58.06、解码58.30FPS，元素丢帧4/1169（默认64/1169）；none提交57.87、解码58.35，丢帧9/1170（默认58/1172）。末包→提交p95主/none为47.2/50.4ms，较默认72.2/78.5ms降低；实际缓冲均值23.9/28.9ms，较默认41.2/59.6ms降低。主窗marker p95从115降至92ms。服务器与编码/网络段相近，收益主要在接收端。

18次输入的中位从120.3降至112.4ms，nearest-rank p95在这个样本数下就是最大值，168→183.5ms，不能宣称输入尾延迟同幅改善。最大值为第一刺激，输入事件→实际send47.1ms，其中此前同步读回占用与事件调度重叠；余下等待另以Worker组补证。

`instrumented-max50-worker`使用每rVFC小ROI immutable bitmap、有界4个在途任务，108次全部完成，无容量跳过或CRC失败。主线程capture p95 1.0ms、Worker turnaround p95 10.5ms，后者不倒填成video观察时间。18/18输入回显，中位/最大（nearest-rank p95）118.8/162.4ms；marker p95 99ms，video提交57.49、解码58.27FPS，丢帧14/1170。测法不同，不与sync45直接宣称相同口径的输入改善。

Worker首点击证据：event→DC send30.8ms；focus请求到精确ACK27.0ms；ACK→input send0.4ms；`sendInput`提前26.8ms已接受待焦点队列。由此确认首次点击额外等待来自正确token的focus往返，保留该输入身份门禁。所有本轮输入样本未复现约1秒。

0/50是WebRTC原生best-effort请求，不是50ms硬截止。固定157中min0/max≤500触发低延迟路径，正max保留有界video合成算法；max0会走不同的无算法路径，因此本轮没有扫描其它值。音视频同步仍可增加有效最小等待，拥塞控制与质量三档不变。Chrome89默认video/可信触控兼容通过后，已采用Endpoint默认0/50，保留显式-1及合法值override；最终CLI和显示组无参数实读回0/50。

## 显示与交付检查

Windows sudo实际完成同UHD630/LUID的DXGI输出0→1及1→0，Browser/GPU、peer/track保持，H264持续解码，无FATAL/CHECK/dump。两组各60/60、25/25健康采样；输出移除后12.869秒，未做物理拔插。[显示证据](osr-display-runtime-20261104.md)。

32项Stats实际读数与无遮挡截图通过，旧capture空白项退出当前叠层；触控同peer跨布局退役与旧owner重放负例见[触控/Stats运行](touch-terminal-runtime-20261104.md)。本轮不重复旧性能矩阵或全库审查，交付以最终包的独立smoke和上传记录为准。

`RTC remote H264 receive level ... level=52`为接收能力信息。`PEER_REPORTED/User-Initiated Abort/Close called`表示SCTP对端主动关闭，应与peer/会话生命周期关联，单独这一行不能证明Browser崩溃。反复uncertain与navigation save来自需要修复的生命周期/导出状态链，不把这些信息行一并隐藏。
