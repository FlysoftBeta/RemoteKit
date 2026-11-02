# 生产Viewer呈现短基线

2026-11-02，Sol。针对新报告的多画面FPS、连接耗时和高画质分辨率问题；没有重跑历史性能目标组，没有改产品代码或构建。计时运行已结束，自有接收context、隔离Control/Endpoint/Browser均正常关闭。

## 结论与适用条件

本机headless短case未复现paint FPS远低decode FPS。157普通产品页实际选MSTP/fifo2，每plane直接draw不可变VideoFrame，**没有全atlas snapshot copy**；双窗每plane约59.47FPS。89走video/snapshot，实际低分辨率下每plane约59FPS，解码约60FPS。89结果不能当作同像素的157对照，更不能排除用户headed/RDP环境的显示链开销。

确实复现了高画质仍非满分辨率，但触发条件很具体：本次**HeadlessChrome/89.0.4389.90 UA没有命中官方Chrome89白名单**，选择native、协商level3.1。高画质请求44/48Mbps，实际14/14Mbps；源736×1648缩为448×1004，mediaScale=0.6087。`quality.effectiveDpr=1`、`reason=healthy`并没有表达编码采样缩小。真实headed Google Chrome89 UA应命中原白名单4.2；必须以用户实际UA和receiveSelection判断，不能概括成“89均不支持全分辨率”。

## 环境、方法与证据

- 普通`/`入口，diagnostics=false；真实注册用户、Control WS、Endpoint/QSV与离屏Browser。没有`/automation`、没有强制receiveProfile、frameSource、presentationMode、分辨率或码率；三质量档保留生产自适应。
- 单Tenant；接收viewport固定1440×900、DPR1，内容区域1440×812；双窗各718×812 DIP。固定独立无交互canvas页：全背景、移动色条、递增frame文字。不是重载benchmark。
- 源`out/dev/remotekit_browser.exe`，接收157为`out/rel/chrome.exe`；157 headless/fake60。89为官方89.0.4389.90 headless（传入fake60 flag，89是否支持该flag未验证）。本地LAN候选，无RTT10ms/48Mbps限速；不等同历史验收环境。
- 独占本轮GPU运行窗口，未并发构建；未切桌面/抢鼠标键盘。使用browser-use技能的宿主Playwright。证据目录`develop/tmp/viewer-presentation-baseline/`，fingerprints记录实际产物hash。
- 工具：`tools/viewer-presentation-baseline-server.mts`隔离服务、`viewer-presentation-baseline-browser.js`宿主管理浏览器采样、`viewer-presentation-baseline-resources.ps1`只读自有进程CPU/GPU采样。生产对象经React ref读取，不设置其接收策略。
- `metrics/client-metrics.jsonl`完整保留157单窗及三质量档尺寸；`89-reports.json`完整保留89两个case before/after/raw。157双窗完整raw未落盘（初版metrics未检查1MiB请求上限），本文与工具返回有其紧凑摘要和截图，不能声称其raw可重放。工具已改为200k分块且检查HTTP状态，修正后未再跑性能case。
- 157两个case的初版首帧观察器在MSTP下没有读取video decoded count，因而在case期间继续10ms轮询生产ref；这是额外CPU探针开销。89已修正为首paint后停止。没有为消除该探针重复跑分；157数值只作本条件生产路径诊断，不能作无探针标准性能值。

## 四个短case

paint为before/after独立帧计数差/实际采样秒数；89 decode同样从getStats帧数差计算。表中157双窗decode只有末次1秒统计，已明确区分。

| case | 时长 | 实际接收/呈现 | 每plane unique paint FPS | decode FPS | 源→编码/video | canvas backing |
|---|---:|---|---:|---:|---|---|
| 157单窗auto | 12.043s | MSTP/fifo2/snapshot，immutable-frame-planes | 51.816 | 52.065 | 1456×832→1456×832 | 1440×812 |
| 157双窗auto | 12.393s | MSTP/fifo2/snapshot，immutable-frame-planes | 59.470 / 59.470 | 59.260（末次1秒） | 736×1648→736×1648 | 各718×812 |
| 89双窗auto | 12.325s | video/snapshot，FFmpeg软件解码 | 59.553 / 59.553 | 59.959 | 736×1648→448×1004 | 437×495 / 437×494 |
| 89双窗quality | 12.870s | video/snapshot，FFmpeg软件解码 | 58.974 / 58.974 | 59.984 | 736×1648→448×1004 | 437×495 / 437×494 |

双窗仍为两个独立Window和canvas；atlas内部纵向packing，不要求与产品左右排布一致。DIP内容不因采样缩小而改变，89 canvas经CSS放大到约717.5×812，截图文字可见变软。Sol实际查看157双窗和89高画质截图：两个Window内容均有真实帧、布局无溢出，89模糊与缩采样吻合；静态截图不验证物理屏幕动态FPS。

157单窗末次源交付51.98、编码52.98FPS；89双窗auto约59.94/60.94，高画质约59.90/59.90。它们是Endpoint瞬时统计窗口，不拼成端到端同一帧时间。生产每页自适应与多源交错存在，targetFps=52不保证atlas始终52；本轮未单独调查该行为。

### 帧、metadata、复制与开销

157单窗期末processor total629/read628/authorized626、replaced2、invalid0/discarded0，RAF admitted626；双窗期末total2226/read2219/authorized2213、discarded7/replaced3/invalid0，RAF callbacks2214/admitted2213。双窗这些是从连接开始的累计值，不能除以12秒当FPS。两者`atlasSnapshotCopies=0`，drawing为`immutable-frame-planes`；snapshot模式名不代表实际复制过全atlas。157双窗viewportDraw p95约0.5ms，单窗约1ms，均为CPU调用时间，不是GPU fence完成时间。

89 auto采样窗口734次rVFC、734次authorize/每plane paint；miss增加0、unknown增加1；高画质760次rVFC、759次authorize/paint，miss增加1、unknown增加2。auto metadata授权等待p95 0.14ms、quality 0.125ms；没有持续metadata gate卡住的证据。89末次诊断p95：videoSnapshot约0.055ms、整个videoCallback约3.46ms、单plane viewportDraw约2.64–2.67ms。诊断p95采用有界最近样本，可能覆盖采样开始前的数据；不把这些阶段p95相加。

代码路径：89每rVFC从video复制一次完整atlas到pending canvas，授权时交换canvas引用（没有第二次全atlas复制），然后每plane各draw一次；157每次RAF持有一个不可变VideoFrame，各plane直接draw，旧owner随后close。`drawImage`的CPU耗时和API调用次数不足以证明GPU有N次完整纹理上传，需GPU trace作进一步归因。本轮没有采集ETW或GPU copy pass。

89高画质约14秒资源采样：自有receiver平均约0.98 CPU core，source/Endpoint合计约0.85，Control约0.01；receiver没有PDH GPU engine条目，getStats明确FFmpeg，不能宣称硬件解码/GPU canvas。GPU采样主要归于source；没有157对应资源case，不作CPU/GPU成对收益结论。

stats中的`decodedFramesPerSecond`来自getStats解码帧数差；`framesPerSecond`为接收帧统计；`paintFpsByView`来自每view最近一秒unique paint。它们时间窗/终点不同；不能将canvas redraw、所有plane求和或RAF当成单plane动态FPS。157 rawRvfcCount/clientRafCount为0是路径未调用那些探针，实际RAF计数在processor字段与feedback RAF样本，并非没有刷新。

## 三质量档与能力

157同双窗连接分别设quality/smooth/auto，每档等待约1秒观察，未各跑12秒性能组：三档effectiveDpr均1、mediaScale均1，源/编码/布局736×1648、各canvas718×812。预算分别8294400/1440000/2073600像素，target约50/59/52，均容纳该内容面积，因此尺寸相同。短等待不足以作为码率收敛测试。

157能力探测file/webrtc 1080p H264均supported/smooth/powerEfficient，产品VideoDecoder probe选level4.2。MSTP可读RTP metadata并实际工作；video元素videoWidth/height/decoded=0是该路径未使用video播放，不是黑屏或没解码。实际尺寸在processor/layout/getStats。

89 MediaCapabilities file 1080p H264 supported/smooth、powerEfficient=false；type=webrtc枚举不支持。它的headless UA白名单落空，实际native level31/14Mbps，即使quality.effectiveDpr=1，仍由Endpoint媒体采样减小到0.6087。level31限制与产品DPR预算是不同层，UI若只显示DPR无法解释实际清晰度。

## 连接阶段

页面性能时间戳从当前文档导航起算；first.decode/paint为轮询可见上界，89观察间隔20ms；不是物理屏幕点亮。源/服务已存在时的reload和首次新建Window不同，不能合为冷启动分位数。

| 条件 | WS open | 创建peer | offer发出 | offer返回 | ICE connected | DC open | 首decode | 首paint |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 157首次空workspace再创建页 | 62ms | 777ms | 956ms | 1110ms | 1119ms | 1131ms | 未测到独立decode时刻 | ≤1644ms |
| 157源已在运行、reload | 73ms | 81ms | 229ms | 356ms | 361ms | 368ms | 未测到独立decode时刻 | ≤531ms |
| 89源已在运行、新接收端 | 52ms | 63ms | 235ms | 367ms | 380ms | 393ms | ≤506ms | ≤527ms |

本地offer RPC约126–154ms，peer构造到offer约150–180ms；首157空workspace前段包含创建Browser/Window等准备，本次没有分别记录这些内部子阶段。ICE本地成功很快，未复现网络慢连接。首157 decode缺失是初版观察器读未使用video元素造成的测量缺口，不能将首paint倒填成decode。用户远端连接耗时需同样分阶段采样，尤其candidate网络、服务冷恢复与能力探测。

## 可供root选择的下一对照

1. 用户实际浏览器/UA、headed与否、GPU加速状态、viewport/DPR、plane数和stats截图/结构到位后，先复现其实际路径。157若回退video应记录`processorFallbackReason`；有MSTP构造函数不等于可读RTP metadata。
2. 在完全相同像素、同帧源条件下，对照现有N个2D canvas与共享WebGL atlas纹理：一次VideoFrame导入/上传、多个裁剪绘制。需实际GPU trace证明减少复制，保持每plane epoch与输入门禁；本轮没有实现或测试。
3. 单canvas多viewport/scissor可减少canvas backing/compositor表面，需让产品独立Window控件、命中与裁剪仍正确；是跨组件方案，由root决定。
4. CSS裁剪video可探查浏览器原生display成本，但任意packing通常需要多video元素或重新组织视觉atlas，同一video DOM节点不能同时出现在两个位置；多元素可能引入额外显示/解码成本，且可变video像素与metadata gate的一致性需独立处理。不能直接作为现有不可变帧安全边界的替代。

后续已按root授权完成[同流WebGL候选对照](viewer-presentation-candidates.md)：保留metadata gate，降低客户端提交/CPU/3D开销，尚未改产品默认。当前证据仍支持先查实际receive路径/协商/显示环境与stats口径，再决定集成范围。
