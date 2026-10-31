# GPU吞吐与Chrome89呈现有界定位

本轮找到并修复了一个真实软件原因：服务网页虽报告DPR1，原生150% DPI仍使1080页面实际提交2880×1620，再缩成1920×1080捕获。现在按每页DPR设置官方capture scale override，桌面与平板都提交正确像素尺寸。**四1080源FPS约8→20，最终paint约6.5→9.3；默认Chrome89仍约32Hz呈现，目标尚未达成。**

另一个可验证边界是Chrome89的begin-frame限制：独立测试profile加`--disable-frame-rate-limit`后，单租户真实RTP paint可达约53fps，但1Hz marker p95仍103–105ms，CPU明显增加。这个特殊flag结果不是默认Chrome89或物理屏呈现证明，不自动作为产品默认。

开始UTC2026-10-31 21:26，45分钟有界阶段；所有参数组独占GPU，5s暖机+20s有效段。最终额外检查仅为已批准的LowPower支持与一个四租户ON组，没有重跑16组矩阵。

## 直接尺寸证据与修复

修复前`resource-geometry-baseline-1080-t4/endpoint-responses.jsonl`中每个view：

| 层 | 修复前 | 修复后 |
|---|---|---|
| 配置/JS viewport，pageDPR | 1920×1080，1 | 相同 |
| 宿主display DSF | 1.5 | 1.5 |
| captureScaleOverride | 1 | 2/3 |
| 有效view/compositor DSF | 1.5 | 1 |
| requested renderer与compositor viewport | 2880×1620 | 1920×1080 |
| 实际最后提交RenderFrameMetadata | 2880×1620 / DSF1.5 | 1920×1080 / DSF1 |
| capture requested/coded/natural/visible | 均1920×1080 | 均1920×1080 |
| 导入D3D11真实texture | 1920×1080 / BGRA87 | 相同 |
| atlas/video（含padding） | 1928×1088 | 相同 |

根因与官方Blink实现一致：`screen_metrics_emulator.cc`保留compositor原始DSF，单独改变网页ScreenInfo/DPR不等于改变实际backing。修复由主Agent选定：service每WebView调用`RenderWidgetHostViewBase::SetScaleOverrideForCapture(pageDPR/未乘override的宿主DSF)`；导航/新RWHV/宿主显示变化重算。没有改系统DPI、窗口容器、输入协议、共享atlas ABI或native demo策略，也没有提前释放GPU lease。

Control已实际验证mixed desktop1/tablet2：desktop提交1920×1080、tablet提交1640×2360、宿主仍1.5；touch marker32769及中文composition91正确，desktop刺激仍0。证据`develop/tmp/mixed-backing-final/{snapshot.json,protocol.jsonl,metrics,chrome89.png}`。共同atlas5512×2376→encoded3118×1344；desktop capture在共同atlas2下仍会放大，这是现有统一atlas布局成本，与真实backing修复分开。

## 引擎和进程计数

正式工具`watch-streaming-resources.ps1`按自有PID树归属source browser/renderer/GPU、endpoint、Chrome89 receiver、Node及collector。GPU用Windows PDH `GPU Engine(*)/Utilization Percentage`，另以原始CIM计数器交叉确认。按LUID/physical/engine分别保存，不能平均空闲3D节点，也不把独立引擎相加成“GPU总利用率”。

最初CIM/Get-Process原型占约0.7核，未掩盖此成本；改为PDH与原生GetProcessTimes后，最终比较collector约0.05–0.12核（16逻辑CPU的约0.3–0.8%）。每次`collectionMs`、有效窗口与缺失记录保留。原型与低成本工具结果分开。

修复前低成本1080×4基线：physical engine0/3D平均**98.85%**；VideoDecode约13.0%，VideoProcessing约5.1%，Copy约0。3D归属：source GPU进程合计71.75%、source browser5.22%、endpoint10.64%、receiver GPU11.23%。Intel的endpoint编码工作也可能记在名为VideoDecode的引擎，不能把名字直接当API功能。

| CPU角色，进程合计核数 | 修复前1080×4 | 修复后1080×4 | 修复后720×4 |
|---|---:|---:|---:|
| source renderer | 0.533 | 1.263 | 2.308 |
| source GPU进程 | 1.128 | 1.988 | 3.049 |
| endpoint | 0.903 | 1.066 | 1.238 |
| receiver renderer | 0.645 | 0.767 | 0.867 |
| receiver GPU | 0.238 | 0.405 | 0.475 |
| collector | 0.072 | 0.088 | 0.120 |

逐PID数据在每case的`resource-processes.json`和`resource-summary.json`。修复后更高FPS增加CPU工作量；全机CPU p50为四1080约69%、四720约84%。没有把合计CPU核数当成某单线程负载。3D busy代表调度运行时间，可能包含依赖/等待，未用GPU timestamp拆分shader执行与fence等待，因此**不能据此宣称硬件固有上限是66Mpixels/s**。

## 同路径分层结果

均默认Chrome89、marker0、每peer24Mbps/每向5ms，QSV d1/TU1/VBR；CPU/GPU collector与被动stdio tee同配置。

| 组 | source | capture | copy | encode | decode | 真实paint FPS |
|---|---:|---:|---:|---:|---:|---:|
| 修复前1080×4 | 约7.5–8.0 | 约7.5–8.0 | 约7.5–8.0 | 约7.4–7.9 | 约7.4–7.9 | 6.5–6.9 |
| 修复后1080×4 | 20.0–20.4 | 19.9–23.0 | 19.0–20.4 | 11.9–12.6 | 12.0–12.4 | 9.2–9.3 |
| 修复后1080×1 | 52.9 | 52.9 | 52.8 | 52.8 | 52.9 | 31.8 |
| 修复前720×1 | 52.9 | 约53 | 约53 | 52.7 | 52.7 | 32.8 |
| 修复后720×1 | 53.2 | 53.2 | 53.3 | 53.2 | 53.2 | 31.8 |
| 修复后720×4 | 46.4–46.9 | 45.5–46.3 | 37.5–38.0 | 20.5–22.1 | 20.4–22.1 | 11.7–12.3 |

capture原始trace窗口是声明的first-event+5..25s，与客户端墙钟窗口不保证完全对齐；source/endpoint/decode/paint按实际有效段。没有把窗口差异导致的capture略高于source解释为新增真实内容帧。

新瓶颈已转移：四1080 source/copy约20，encode约12；四720 source约47、copy约38、encode约21。不能继续把它们归因为“网页自身只8fps”。3D引擎仍约99%，同时client呈现还有额外损失。

## 客户端与有限编码对照

| 条件 | source / decode / paint FPS | marker与render→paint | 代价/结论 |
|---|---|---|---|
| 默认720×1，修复后 | 53.2 / 53.1 / 31.74 | 20个；p50/95/99=106/111/113ms | 默认路径未达50FPS |
| 仅client unlimited，720×1 | 53.1 / 53.1 / 53.03 | 20个；99/103/104ms | CPU p50约45%，默认同组约29% |
| 仅client unlimited，1080×1 | 52.8 / 52.9 / 52.70 | 20个；103/105/109ms | CPU p50约51%，默认marker0约35% |
| 默认1080×4，1Hz | 20.2–20.5 / 12.2–12.5 / 8.5–8.7 | 各19个；p95 1004–1096ms | 1Hz仍有GPU读回扰动 |
| 仅client unlimited，1080×4 marker0 | 约20 / 11.7–12.5 / 8.7–8.9 | 无延迟样本 | CPU p50约90%，没有改善 |
| client `--disable-gpu`，修复前1080×4 | 约7 / 约7 / 5.6–6.1 | marker0 | receiver renderer约3.28核、hardware GPU引擎消失，未改善 |

unlimited只给受控Chrome89测试profile，独立client RAF探针已禁用；计数是实际canvas paint的独立wire RTP，非空转RAF/重复帧。官方89源码说明该flag解除cc/display begin-frame限制并隐含disable-gpu-vsync；实际物理屏幕仍未测。单租户达到>50的同时，p95仍高于100ms，不算目标达成。

在修复后唯一d4/TU7/VBR四1080组：source19.6–19.9、encode15.8–16.1、decode15.7–16.1，paint8.7–9.2；编码吞吐提高但没有改善最终呈现，因此不据此改默认。个别高负载组receiver lost增量3–18，relay drop仍0，原始NACK/发送等待/RTT保留；没有把它们写成全组零丢包。

## LowPower有限检查

新增`--qsv-low-power=auto|on|off`，默认auto不变。显式请求必须被Query/Init/GetVideoParam接受，实际值缺失保持null，不以请求值冒充接受值。ON短检查及240帧码率阶跃通过，实际LowPower requested/queried/initialized=16/16/16，Init/GetParam状态0，Query warning5为其他码率修正；BT709 limited、HRD off仍通过。

唯一1080×4 ON组`backing-fixed-lowpower-on-1080-t4-marker0`，Release service SHA256 `2e4b4953ea5a567b9a840ddb6b16980fb40b019aa0a3f8520f057340d856307d`：source20.4–20.6/copy19.6–20.5/encode12.9–13.4/decode12.9–13.7/paint9.3–9.7，3D99.14%，CPU p50约76.7%，encoder错误null、PLI/loss/relayDrop0。与先前auto组相比没有足以改变默认的呈现收益；不据单次小幅差异宣称VDEnc解决瓶颈。自动模式实际选择另以最短初始化证据确认，不能假定它一定是VME。

## 质量与边界

同静态1080/d1/TU1/VBR/24M、实际Init仍2M，source/decoded各自CRC frame1+timestamp匹配，ROI x24/y128/1000×260：修复前PSNR23.50dB/MAE8.48，修复后**25.87dB/MAE7.86**。Sol查看真实PNG，文字轮廓有所改善，细线及小字仍有压缩损失；未把它称为无损或把全部剩余失真归到启动码率。目录`backing-fixed-static-1080-vbr-quality/source-trace/*-{source-scene,decoded}.png`，计算在`quality-0.json`。

旧CSS对照的源文件SHA099400e36c…与case副本一致，helper当次代码明确读`--fixture-root=<case>/fixture`；原始source文件含dom-compositor-scroll-v1/12卡片/translate3d。历史未保存实际HTTP响应或像素截图，因此本轮不把CSS历史记录作为核心排除证据；新helper会保存每次实际served HTML、源/响应SHA与fixtureKind。DPI结论来自真实提交metadata/texture、引擎与修复A/B的独立证据。

没有改系统电源/RDP/路由或切换会话。已编译的browser precise poll没有在本阶段扩展成额外组：capture前耗时和真实高倍backing证据更有价值，修复后优先完成验收。Skia GPU-finished callback的2ms检查与browser lease轮询是两处；未来若要进一步拆GPU工作与等待，需真实GPU计时，不能提前Done或省略fence。

默认建议仍d1/TU1/VBR、LowPower auto；单独客户端或物理屏工作站的GPU成本需要另测。本轮已证明并修复软件放大，尚未证明最终四租户50FPS/100ms可达。

正式工具：`watch-streaming-resources.ps1`、`windows-gpu-counters.cs`、`analyze-streaming-resources.py`，被动协议保存`streaming-endpoint-tee.mjs`；参数准备工具的诊断选项默认关闭。各case保存config/fingerprints、逐PID/引擎原始数据、完整sender stats与实际presentation chunks。所有临时输出在develop/tmp，工具不依赖已有分析文件。

参考：[Microsoft GPU计数口径](https://devblogs.microsoft.com/directx/gpus-in-the-task-manager/)、[PDH通配计数器数组](https://learn.microsoft.com/en-us/windows/win32/api/pdh/nf-pdh-pdhgetformattedcounterarrayw)、[Chrome89官方switch实现](https://raw.githubusercontent.com/chromium/chromium/89.0.4389.90/components/viz/common/switches.cc)。
