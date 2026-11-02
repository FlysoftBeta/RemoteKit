# Viewer媒体链路只读审阅（2026-11-03）

本文件保留审阅当时的发现与建议。后续实现和验收以[当前状态](../../docs/current-state.zh-CN.md)、[本轮契约](robustness-contract-20261103.md)及[当前问题](open-issues.md)为准，不能把下文历史缺陷自动视为仍未修复。

范围：当前RemoteKit2工作树，包含4de343c输入/video生命周期修复。未读取旧remotekit目录，未修改产品代码，未构建、启动GPU链路或重跑性能矩阵。以下“复现”明确区分直接调用现有TypeScript类的CPU模型与真实运行；没有新增真实浏览器/网络证据。

结论：发现2项P1和3项P2具体代码问题。默认video路径没有发现偷偷启动MSTP/全atlas canvas绘制；共享track也不能据此宣称各video元素没有额外合成成本。核心重写、unpack候选与跨节点契约由root决定。

## 实际覆盖文件

完整阅读：

- `control/client/transport.ts`：信令attempt、取消、ICE队列、接收track、呈现协商/屏障、video/processor/canvas生命周期、注册、输入门禁、统计、反馈、重连与清理。
- `control/client/video-presentation.ts`、`frame-epoch.ts`、`coordinates.ts`、`plane-source.ts`、`track-processor.ts`。
- `control/client/shared-plane-renderer.ts`、`reconnect.ts`、`receive-profile.ts`、`media-feedback.ts`、`capture-latency.ts`。
- `control/client/marker.ts`、`marker-schedule.ts`、`presentation-diagnostics.ts`、`stats-overlay.tsx`、`types.ts`。
- `control/test/video-presentation.test.ts`、`transport-control-rpc.test.ts`、`media-feedback-transport.test.ts`、`shared-plane-renderer.test.ts`。

按边界追查：

- `AGENTS.md`、`docs/current-state.zh-CN.md`、`docs/streaming-protocol.md`。
- `control/server/control.ts:301`（clock.ping）、`control/server/quality.ts:17`起（延迟反馈消费）。
- `endpoint/src/service.cpp:942`起（capture wall构造）、`endpoint/include/remotekit/touch_clock.hpp`与`browser/webview.cc:938`起（触控源时钟）。
- `browser/sdk/remotekit_rtc.cc:1015`起（encoded回调和wire RTP边界）；Native所有权/完整SDK线程审计由另一个owner负责，此处没有重复宣称覆盖。
- `control/client/style.css:164`起、`remote-viewport.tsx`注册/容器与`automation-entry.tsx`Marker入口。没有接管其它owner的UI或输入全量审计。

## VM1 — P1：Control时钟被误当作Endpoint时钟

证据：

- `transport.ts:1084`起向Control的WS `clock.ping`校准，`control.ts:301`直接返回Control主机`Date.now()`。
- `capture-latency.ts:2`注释把Control/Endpoint wall合并为一个域；`calibrate()`取得Control offset，`paint()`第40行却用`client wall + Control offset - captureWallTimeMs`计算。
- `service.cpp:950`起用Endpoint的`GetSystemTimePreciseAsFileTime`和QPC映射产生`captureWallTimeMs`；其uncertainty是本机映射误差，不包含Endpoint↔Control主机时钟偏差。
- `quality.ts:20`接受该反馈，24行起累计三次>300ms后降DPR。
- 同一个`CaptureLatency.inputStart()`还给触控生成`startServerWallUs`，而`browser/webview.cc:950`将它与Browser主机wall比较。

触发：Endpoint与Control在不同机器，wall有固定偏差。即便各机器时钟自身稳定、RTT很低，现有confidence检查也不会检测到两个远端时基不同。

CPU直接模型已运行：客户端/Endpoint同wall，真实采集到呈现100ms，Control快500ms；类实际报告`presentationLatencyMs:600`、`clockUncertaintyMs:7`、3个样本。反向偏差可以产生负值并静默丢样，而不是有效校准。该脚本没有模拟真正部署或声称真实质量策略已经降DPR。

影响：统计显示高置信错误延迟，自动质量可能不必要降分辨率/无法恢复；触控可偏移手势源时间，足够大的偏差会触发Browser的未来/过期start时间拒绝。此项不能通过要求Control与Endpoint同机解决，用户模型允许独立算力节点。

修复方向：显式区分Control产品时间域和Endpoint媒体/输入时间域。媒体采集/触控起点必须取得当前Endpoint/Browser时钟映射及不确定度、与peer/incarnation绑定；Control接收反馈的“样本新鲜度”另保留Control域，不能直接换掉一个offset后继续复用`sampledAtServerMs`的旧语义。未具备可信Endpoint校准时返回unknown/arrival fallback。

必要回归：三个独立时钟，Endpoint相对Control±500ms及±10s；capture→paint仍保持100ms或明确unknown，绝不能600ms/7ms不确定度；触控源序列可用或明确fallback；单节点结果不变；旧peer校准不能污染新Endpoint；每端wall跳变分别失效。

## VM2 — P1：静态video的晚到metadata重试耗尽后没有恢复出口

证据：

- `transport.ts:398`起只在本video的rVFC内用RTP查map，并首次授权。
- 第412–419行：未知RTP会保持未ready并安排刷新；第968行metadata到达只record、安排刷新，`authorizeFrame()`因backend是video立即返回。
- 第385–396行每个plane最多3次metadata retry。到达3次后，不再安排新刷新。晚metadata本身不会再次观察video；静态源没有下一次rVFC就永远未ready。
- 现有`video-presentation.test.ts`晚metadata用例手工再触发同RTP的`b.frame()`完成授权；浏览器对已呈现的静态帧没有义务再送一次rVFC，测试没有覆盖“所有刷新都晚到”。

触发：首次静态帧（或resize、后台恢复、新挂载plane）总是先发生rVFC，随后才收到该帧的可靠DC元数据。三个refresh返回帧也均是这个顺序，之后页面不再damage。RTP视频与SCTP metadata不具备本代码依赖的全局交付先后保证。

CPU直接模型已运行：有效当前barrier、尺寸、renderer，四个静态刷新帧依次`observeVideoPlane(rtp)`→`frameGate.record(rtp,currentEpoch)`→执行refresh timer；最终`ready:false, metadataRetries:3, remainingTimers:0`。这是现有类方法的确定行为；尚未在真实网络稳定制造该交付顺序。

影响：连接和音频仍可能正常，当前plane永久隐藏、输入永久关闭；用户只能制造新damage或重连。不能把“保留已授权稳定布局的video”当作首次ready的解决方案。

修复方向：保留“本元素真实观察+当前barrier”约束，同时为晚metadata设计有界恢复状态。可由root选定安全的后续metadata确认规则，或在重试耗尽时自动进入既有canvas安全回退（snapshot可等待metadata），或其它保证静态终能恢复的协议。不能无限高频刷新，也不能直接给未确认像素套新epoch。

必要回归：初始/resize/foreground三条路径，每次refresh的metadata均晚于rVFC、静态无下一帧；有限时间内安全显示或明确回退，旧epoch永远不放行；一个plane正常、一个迟到时分别处理；后台不得timer绕过双rAF屏障。

## VM3 — P2：processor失败回退中的旧play Promise仍可拆掉新peer

证据：`transport.ts:744–750`的`processorFailed()`在转video后执行`void this.video.play().catch(() => this.connectionFailed(...))`，没有捕获/检查peer、attempt与video。第312–314行`fallbackPresentation()`对应分支已经有这些guard；4de343c的新测试只覆盖后者，遗漏这里。

触发：产品从video回退MSTP，processor随后因帧metadata/API/流结束失败，转传统video；`play()`待定时发生断线/手工重连，新peer接管；旧play最终因旧媒体被pause/srcObject变更而reject。

CPU直接模型已运行：直接触发`processorFailed`，保留待定play；替换peer且增加attempt后拒绝旧Promise，现有`connectionFailed`被调用1次。没有启动真实MSTP或真实浏览器播放。

影响：与用户当前重连无关的旧回调关闭当前媒体并消耗自动重连预算。默认video稳定工作时不触发，但它恰在能力故障恢复路径上。

修复方向：与已修的fallbackPresentation一致捕获peer、attempt、video并完整校验，使用统一的attempt资源scope避免以后再遗漏。

必要回归：processorFailed分支分别替换attempt、peer、receiverVideo后reject，当前连接不失败；当前实例真实play失败仍处理一次；disconnect后不得重新安排reconnect。

## VM4 — P2：共享canvas静态几何失效时仍保留旧可见纹理

证据：`shared-plane-renderer.ts:44–46`的`geometryChanged`只处理`drawTexture()`成功或抛异常；它返回undefined的正常拒绝路径完全没有clear/fallback。第90–92行因目标断开、身份变化、零尺寸、面积/边长预算失败均可正常返回undefined。对照第75、83行，正常`render()`遇到同类情况会clear。

触发：canvas fallback已成功共享绘制，之后静态DOM resize/scroll/ResizeObserver使共享几何失效（例如一个目标宽度变0，或外接矩形越过8M像素预算），并没有下一次视频帧调用render。

影响：旧fixed共享canvas和原坐标继续可见，原plane opacity仍为0，`isVisible()`仍true；输入canvas使用新bounds，画面与输入可能错位。后续有效新帧可能自愈，静态时无此保证。

这是直接分支证据；未运行真实DOM/GL回归，也未确认普通窄屏切换一定触发此情形。

修复方向：geometryChanged的undefined结果同样撤销共享可见性、恢复plane opacity，并让transport从保留的不可变帧同步恢复2D或请求一次刷新；避免在fallback过程中再次选择同一不合格共享几何。

必要回归：成功render后，静态修改一个目标宽度0/超预算，再执行geometry RAF；旧shared backing不可见，2D资源/ready按实际恢复。重新变为有效尺寸可恢复；不把静态重画计新FPS。

## VM5 — P2：focus否定ACK留下乐观focused状态，下一次输入不再请求焦点

证据：`transport.ts:1030`起的focus在发送请求前把`inputFocus`设成`focused:true`；第977行`matches && message.ok === false`只清`pendingFocus`，没有撤销该known状态；第34行`ensureInputFocus`随后看到`known.focused && token===surface.focus`直接return。

触发：某次当前identity的focus请求被明确拒绝，而layout/focus token尚未改变；用户再次wheel或点击同view，调用ensureInputFocus。

影响：已否定的焦点被当成已确立，后续事件可能带旧token发送并持续被拒，直到其它layout/token变化。是否会在普通真实链路自然发生拒绝需输入/Native owner进一步检查，客户端错误状态转移本身明确缺失。

修复方向：将focus状态区分requested/acknowledged/rejected；拒绝时清掉仅属于该request的known乐观状态，保留并发新请求隔离。不要只用一个boolean代表实际焦点租约。

必要回归：focus拒绝后下一次ensureInputFocus产生新requestId；旧请求的迟到拒绝不能清新请求；成功ACK后同view连续wheel不重复focus。

## 确认的现有边界与未升级为实际bug的观察

- 默认产品由`setControlRpc`选择video pending；ontrack在pending只保存track，在video模式只为plane挂video。没有进入startFramePump/startProcessorPump；构造两个canvas不等于执行绘制。现有零draw/MSTP测试支持这一点。
- video DOM注册按viewId稳定，focus-only layout不改变samePlane；document/epoch变化更新identity并撤ready，真正peer/track变更才释放媒体。没有将刚修的React effect问题重复列为新发现。
- 双rAF屏障有channel/serial隔离；hidden时不以timer放行；恢复重新两rAF。旧frame metadata不能直接使新epoch canvas通过；processor owner有source+attempt检查和close路径。
- video同一barrier中已ready平面的未知逐帧metadata不立即撤输入，与Endpoint发送屏障契约一致。安全性依赖Endpoint发送边界确实排掉旧inflight，本报告没有替代Native owner对此契约的审查。
- clientPointToDip使用DPR×mediaScale把编码ROI转DIP；video crop按实际客户端内容bounds独立x/y缩放，不使用atlas placement作目标位置。共享canvas显式返回独立x/y pixelsPerDip。未发现本范围中的确定性DPR双乘错误。
- 接收能力探测并行、每项1500ms timeout，缓存有上限；显式网络超时不会降decoder档。VideoDecoder capability是选档启发式，不能单独证明WebRTC硬解能力；协商失败有降档路径。没有因该启发式提出额外性能组。
- `readStats`、clock/feedback Promise和网络诊断completion多数有peer/attempt检查。旧answer显式rtc.close，track processor待定read结束会close帧并releaseLock。VM3是实际遗漏，不概括为全部取消机制失效。
- `onconnectionstatechange`第587行对`disconnected`立即执行closeLocal，与failed相同，没有恢复宽限；这是短暂网络抖动会立即重建整条连接的现有行为。可作为重连状态机重构项，由root结合产品恢复目标取舍；本审阅没有真实网络注入，不另计已复现缺陷。
- peer.ondatachannel没有peer guard而bindChannel覆盖this.channel；多数其它peer事件有guard。旧已关闭peer的datachannel事件是否实际仍会派发需要浏览器事件任务顺序证据，现阶段仅列隔离一致性建议，不称已复现跨attempt污染。
- Marker仅从automation入口显式创建，普通产品不做逐帧ROI readback。Marker pending stimulus无超时，若输入永不在画面出现会长期绕过抽样频率，直到测量结束/2000有效样本停止；这是诊断负载/测量预算改进项。`MarkerMeasurement.report()`有subscribeFrame时仍固定标`selected-canvas-paint`，默认video测量应按backend标compositor观察。两者未列为用户默认路径P1。
- video返回的PresentedPlaneSource是可变HTMLVideoElement，同步Marker draw不能升级为不可变VideoFrame证明；其RTP/CRC对应限制应在video实验记录中明示。当前代码没有承诺原子句柄，本审阅也不据此否定既有canvas不可变帧结果。
- video compositor frames按元素delta计，未把多元素decoded计数相加。PresentationDiagnostics的全局rVFC/epoch观察混合了多个plane，分析时不可将其视为单物理解码器逐帧计数。Chrome89解码器数量仍须89源码或专门证据，不能从157或inbound流数外推。

## 验证记录与root后续选择

执行过一个stdin Node/tsx隔离CPU脚本，直接导入当前`CaptureLatency`和`RemoteTransport`，用最小DOM/媒体替身调用现有方法。输出为：

```text
different-host-wall-offset:
  presentationLatencyMs=600, clockUncertaintyMs=7, sampleCount=3
static-all-metadata-late:
  ready=false, retries=3, remainingTimers=0
stale-processor-play-rejection:
  replacementFailed=1
```

脚本未写入产品仓库，没有跑全量既有测试或做额外性能验收。VM4/VM5为代码路径证明，待实施修复时加入必要模型回归与对应小范围真实检查。

建议优先顺序是先由root明确跨主机时基与静态恢复契约，再修VM3/VM4/VM5。是否把transport拆为attempt资源scope、presenter状态机和独立input-focus状态机，或整体替换，属于root核心架构决定。本报告没有选择unpack/multi-video/WebGL方案；现有问题需要在任何新后端中保留取消、布局屏障、静态恢复和输入身份回归，而不是由换呈现技术自动消失。
