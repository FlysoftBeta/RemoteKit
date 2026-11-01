# 自适应帧率与背压：现有信号和最小接线边界

## 结论

已有绝大部分分层计数和一条可直接复用的运行时调速接口。缺口是：产品客户端没有持续RAF/可见性反馈；Endpoint没有编码pending/inflight/busy的常态统计，也没有跨Session的GPU公平预算；SDK的WebRTC码率回调只进入编码器，未反向影响源pacer。

**现有browser控制支持仅发送`output.configure`的`render_fps`/`fps`字段，在输出保持打开时更新pacer和capture上限，不必重建纹理或布局代次。** 不应复用Endpoint现有`GeometryConfig()`来调帧率：它总发送`device_scale`，browser在output打开时即使scale值相同也拒绝该字段。

本报告只盘点事实及接线边界，不选控制算法、阈值、权重或升降速规则。只读检查，无构建、GPU实验、生产修改或提交。盘点时其他agent正在修改service/encoder文件，以下描述对应读取到的工作区版本。

## 客户端现有信号

| 信号 | 精确位置/字段 | 生成与更新频率 | 当前是否反馈Endpoint |
|---|---|---|---|
| RAF间隔和计数 | `PresentationDiagnostics.clientRaf()`；snapshot的`clientRafCount`、`viewportRafCallbacks`、`intervals.clientRaf` | `RemoteTransport.recordClientRaf()`存在，但产品代码没有调用者；默认值并不是实际已采样显示Hz | 否 |
| 实验RAF | `tools/streaming-benchmark.js`的独立`clientRaf[]` | 有界实验内每次RAF；与上面PresentationDiagnostics不是同一条采样调用链 | 只随实验报告POST到metrics落盘 |
| 显示器刷新率 | 无正式字段/API封装 | 当前只能从RAF间隔估算有效callback节拍；不是物理monitor Hz | 否 |
| document可见性 | 产品`control/client`未监听visibilitychange/读取visibilityState | benchmark有事件轨迹和逐秒snapshot；产品没有 | 否 |
| rVFC与视频呈现计数 | `startFramePump()`→`presentation.video()`；snapshot的`rawRvfcCount`、`latestPresentedFrames`、`latestDecodedFrames`、`intervals.rvfc` | 每个真实rVFC；raw数组上限2400条，分位数是保留样本，不是固定1秒窗口 | 否 |
| Canvas新帧 | `reportPresented()`→`presentation.paint()`；`canvasPaintByView[id]`含`frames/redraws/firstAt/lastAt/fps` | 每次成功draw提交；新RTP/epoch与同帧重绘分开计数；fps取最近1000ms，初始阶段用首尾间隔 | 否 |
| 产品显示FPS | `Diagnostics.paintFpsByView`、`displayFramesPerSecond` | `readStats()`每1500ms读取上述统计；后者只取`selectedViewId` | 否 |
| 解码/接收 | `Diagnostics.framesDecoded/framesPerSecond/decodedFramesPerSecond/bytesReceived/receiveBitrateBps/videoWidth/videoHeight/codec` | 每1500ms `peer.getStats()`；decodedFPS由framesDecoded与RTC timestamp差值计算，优先于原生framesPerSecond | 否 |
| RTT | `Diagnostics.roundTripTime`，来自nominated+succeeded candidate-pair的`currentRoundTripTime`；单位秒 | 同一1500ms getStats | 否 |
| 丢包/解码丢帧 | 产品readStats没有提取`packetsLost/framesDropped`；原始`inbound-rtp`仅在benchmark的`rtcSamples[].rtc`中保存 | 产品无专门常态计数 | 否 |
| epoch gate问题 | snapshot的`epoch.matched/missed/unknownAtVideo/wrongEpochAtVideo/missingRtp/metadataCount/lateMetadataForMissed/pending` | 逐rVFC/metadata更新；`missed`是metadata/epoch授权未赶上下一视频帧，不等同网络丢包 | 否 |
| 绘制成本 | snapshot的`costsMs.videoCallbackTotal/videoSnapshot/viewportDraw/...`及`authorizeToPaintMs` | 逐调用；2400条有界历史分位数 | 否 |
| Pixel marker | `setMarkerStats()`→`Diagnostics.marker/markerSampleHz` | 用户诊断/实验启用时才产生，不能假定正常产品一直开启 | 否 |

文件：`control/client/transport.ts`（connect后的1500ms timer、startFramePump、reportPresented、readStats）、`presentation-diagnostics.ts`、`types.ts`、`main.tsx`。

当前产品的canvas是event-driven，由rVFC/metadata授权后直接draw，不依靠常驻RAF绘制循环。新增独立RAF观测不能把绘制重新迁回RAF，也不能用video decode计数替代canvas新帧数。

`/api/metrics`只把带认证tenant的JSON串行追加到文件，不转发Endpoint、不参与预算。Client→Control网络实验查询`/api/rtc/network`也只是relay snapshot。不能把这两条现有诊断链误称为自适应反馈。

## 多plane与可见性现状

- Control产品状态持有`activeTabId/splitTabId`；`Control.reconcile()`令二者对应WebView的`visible=true`，其他tab为false。`control/server/main.ts`每1500ms tick，且动作后立即reconcile；配置用JSON值比较，changed-only发送`view.configure`。
- Client `main.tsx`为主plane和split plane分别调用`transport.registerPlane()`；注册身份含完整surface、layout epoch/generation，卸载时unregister。transport的`renderers`集合能提供当前挂载plane集合，但没有IntersectionObserver或canvas实际屏幕可见面积采样。
- `selectedViewId`只用于当前活动页诊断显示，不能代表所有可见plane。split次plane不应因未选中而被判断为不可见。
- document隐藏、窗口遮挡、plane CSS几何和Control中“逻辑前台tab”是不同事实。现有逻辑visible不跟随客户端visibilitychange，也没有客户端反馈去改变该产品状态。
- 一个Session共用一个atlas视频、一个source output fps和一个`render_fps`。当前`UpdateOutput()`把同一render fps应用到该Session所有可见live WebView；没有每plane独立rate预算字段。两个plane的canvas绘制不能相加当作两倍atlas FPS。

## Endpoint与SDK现有信号链

```text
WebRTC带宽/编码速率控制
 → browser/sdk/remotekit_rtc.cc ExternalEncoder::SetRates
 → C ABI encoder.set_rates(context, encoder, bitrate_bps, fps)
 → endpoint Session::Rates（SDK线程，encoder_mutex）
 → EncoderWorker::Rates
 → requested_*立即记录，有效变更待worker空inflight后应用hardware SetRates

Endpoint MediaLoop每约1秒
 → remotekit_rtc_request_stats(peer)（异步，至多一份in-flight）
 → SDK StatsObserver → REMOTEKIT_RTC_STATS
 → Session::EventCallback入events队列 → MediaLoop缓存sender_rtc_stats
 → 同一MediaLoop的type=stats DataChannel消息
 → Client diagnostics.endpoint
```

| 层 | 精确字段/接口 | 频率与含义 |
|---|---|---|
| SDK速率回调 | `bitrate.get_sum_bps()`、`framerate_fps`→C ABI uint32 bitrate/fps | WebRTC自行触发；日志只在值变化时打印，C callback每次SetRates都调用；double fps向下转uint32。没有固定1Hz承诺 |
| SDK sender stats | `sampleTimeUs/callbackMonotonicUs`；`selectedPair.availableOutgoingBitrate/currentRoundTripTime/bytesSent/...` | Endpoint约1Hz异步请求，缓存的stats可能来自上一个周期；应以原生sampleTimeUs/回调时间判断新鲜度 |
| SDK outbound | `outbound[]`：`framesEncoded/framesSent/framesPerSecond/targetBitrate/qualityLimitationReason/qualityLimitationDurations/bytesSent/retransmittedBytesSent/packetsSent/retransmittedPacketsSent/totalEncodeTime/totalPacketSendDelay/nackCount/pliCount/firCount/frameWidth/frameHeight` | 可选RTCStats字段不存在时省略。availableOutgoingBitrate是该Peer发送视频方向估计，不是四租户总GPU预算 |
| Worker累计 | `encodeSubmitted/encodeCompleted/encodedBytes/encodeDropped/rateUpdates/keyframeRequests/keyframesSubmitted/keyframesEncoded` | 各事件更新atomic，Snapshot读取；encodeDropped混合pending替换、暂停/失败及硬件错误，不能直接当纯queue busy |
| Worker速率与耗时 | `lastRequestedBitrate/lastRequestedFps/appliedBitrate/appliedFps/lastEncodeMs/actualLevel/qsvLowPower/error` | requested来自Rates；applied来自硬件查询；lastEncodeMs是最近一次submit→completion耗时，不含pending等待，不是窗口分位数 |
| MediaLoop当前速率 | `encodedFps/encodedBitrateBps/atlasCopyFps` | 每约1秒counter差分/真实QPC窗口；不以固定1秒假设代替真实间隔 |
| Atlas/桥接 | `atlasCopies/atlasPoolDrops/lastGpuCopyMs/captureToReadyMs/clockUncertaintyUs/atlasReadyGateDeferredPolls/atlasReadyGateDeferredFrames` | stats每秒上报。atlasPoolDrops计跳过的producer frame_id；free slot不足返回idle但没有单独no-free counter；lastGpuCopyMs也是最近样本 |
| 尾IDR与源间隔 | `configuredIdleIdrMs/effectiveIdleIdrMs/sourceFrameIntervalMs/lastTailAfterSourceMs/tailIdrSubmissions/tailIdrCompletions` | fresh capture metadata在AtlasPool ready时更新IdleIdrPolicy；sourceFrameIntervalMs是到达间隔EWMA，不是源真实渲染/完整capture FPS |
| 几何/输入 | `sourceAtlasWidth/sourceAtlasHeight/encodedWidth/encodedHeight/mediaScale/receiveLevel/inputQueue/inputRejected/inputCoalesced` | 同一type=stats每秒发送，宽高不是帧率反馈 |

`sdk/include/remotekit_rtc.h`现有ABI2已提供set_rates callback、request_stats和send_data；新增Client周期性JSON反馈可复用DataChannel，不必改ABI。SDK当前只在初始化sender时设置`encoding.max_framerate=60`、`degradation_preference=MAINTAIN_RESOLUTION`；TextureSource直接OnFrame，没有Endpoint可调用的运行时source fps/budget setter。若未来要改WebRTC sender max_framerate，这是新增SDK API范围，不是当前browser pacer接口的必要前提。

## fps含义必须分开

| 名称 | 现有控制点 | 应保留的含义 |
|---|---|---|
| 源render上限 | browser `render_fps`，0表示跟随output fps，1..60显式 | 每可见WebView的external BeginFrame pacer；不等同网页实际damage/render产出 |
| capture/publication上限 | browser `fps`，1..120；GpuAtlas::SetFps | 同时设置官方capture MinCapturePeriod与atlas发布间隔；不是编码器名义fps |
| Endpoint名义fps | `options.encoding.fps`（CLI `--fps`） | output.open初始fps、H.264采样level预算、编码器/VPP初始化等多处使用；修改它会混合多个职责，不适合直接承接客户端测得displayFPS |
| WebRTC requested fps | `lastRequestedFps` | SDK SetRates请求，可能受到实际source输出/带宽控制影响；不是静态页面的最大显示能力 |
| QSV applied fps | `appliedFps`、`nominal_fps_` | Configure时固定序列名义fps；Worker对QSV将Rates的fps替换为nominal，普通码率Reset保持原FrameRateExtN/D与StartNewSequence=OFF |
| 实际encode/decode/canvas fps | 各层counter delta | 是当前内容与负载下的产出，不应单独当作可用能力上限 |

NVENC目前Worker不采用QSV的fixed_rate_fps_，会将有效requested fps送入其SetRates；不能因为本机QSV调优就统一改NVENC行为。

静态页面没有damage是正常状态。低atlasCopyFps/encodedFps/decodedFPS/canvasFPS，甚至sourceFrameIntervalMs升高，均不能单独判定拥塞或降低预算。现有offscreen pacer会持续提供tick，但OnAck并未统计`has_damage`；常态数据中缺少“有动态需求却受压”的直接区分量。browser可在现有本地OnAck/capture计数处累积damage/无damage信息，再以≤1Hz状态读取输出，不需要新renderer/Viz逐帧IPC。具体是否使用该信号由主Agent决定。

## 运行时不重建资源的接口

browser `harness.cc`的`HandleControl("output.configure")`允许省略所有几何字段：

```json
{"method":"output.configure","render_fps":30,"fps":30}
```

该调用更新render_fps/output_fps，已有output执行GpuAtlas::SetFps，然后UpdateOutput→WebView::SetRenderDemand→OffscreenHost::SetRenderDemand。后者只有enabled/interval改变才重启deadline相位，立即刷新首帧，保留compositor、纹理和输入身份；同值调用直接返回。GpuAtlas::SetFps只调整fps_与各capturer MinCapturePeriod。几何未改变时不ApplyLayout、不output.close/open。

需要分别控制render或capture时可只发送其中一个字段。`render_fps=0`是跟随output，不是暂停；暂停存在独立`enabled`字段。调用不携带`device_scale`，也不需要width/height。当前Endpoint未暴露对应运行时命令，只有GeometryConfig在初始化/几何变动使用它；`Session::Rpc()`已有rpc_mutex可串行调用Browser控制请求。

`output.status`可按需读取GpuAtlas的`fps_limit/frame_id/captured/capture_callbacks/dropped/mutex_drops/geometry_transition_drops/backpressure_polls/pending_source_leases`以及direct-copy各计数。正常MediaLoop没有每秒读取该RPC；Control的session.snapshot读取WebView compositor信息，其中`compositor.renderHost`含`pacerFps/configuredFps/enabled/pendingBeginFrame/sent/acked/merged/skippedPhaseTicks/coarseWakes/cancelled/sampleTimeTicksUs`。这些只在snapshot请求时取样，不是主动事件流。

## 周期反馈和changed-only预算：最小文件边界

以下是接线所需边界，不指定最终消息名或算法。

1. `control/client/transport.ts`：连接存活时独立有界RAF采样、visibilitychange状态和≤1Hz feedback发送；复用DataChannel。关闭/重连时清timer/RAF、重置counter基线与sequence；只发送窗口统计，不上传逐帧数组。现有1500ms readStats可复用或把测量/反馈统一到不超过1Hz，避免为同一peer重叠getStats。
2. `control/client/presentation-diagnostics.ts`、`types.ts`：提供低成本窗口counter快照及反馈类型。直接对2400条历史sort只适合诊断，不必每次feedback计算所有cost分位数。建议事实字段包括seq/windowMs、visibility、RAF count/interval摘要及有效样本数、rVFC/presentedFrames/decodedFrames delta、按view的新canvas帧计数、mounted view identities、layout epoch/generation、可选RTC loss/drop/RTT；缺失数值保留unknown，不能补0。
3. `endpoint/src/service.cpp`：新feedback类型先按当前event.peer/connection验证，再在MediaLoop侧消费并缓存最近sample/age。当前REMOTEKIT_RTC_DATA全部进入QueueInput，HandleData只接受input/focus；新增feedback应在分派处识别，与256条输入队列和inputRejected分开，过量反馈合并只保留最新。只在预算变化时发无几何`output.configure`，保存requested/applied render/output预算及原因/代次供stats观测；重建后重新应用，但不要把瞬时适应值写回Control产品设备状态或Profile。
4. `endpoint/src/media/encoder_worker.hpp/.cpp`：补pending queue长度、inflight数、hardware busy计数、pending替换/暂停/错误分项drop、累计或窗口queue wait时间。queue和inflight分属调用线程/worker，统计需atomic snapshot或独立锁，不能为了读取inflight在媒体线程直接访问map。当前trace已有enqueue/dequeue/hardware_submit/complete事件可参照定义，常态反馈不要求开启trace。
5. 若选择全Endpoint跨Session公平预算：`endpoint/src/service.cpp`中的共享协调边界或独立`endpoint/include/remotekit/...`策略类，由主Agent固定接口。当前std::map<tenant,Session>只管理生命周期，每Session独立MediaLoop/encoder；没有全局资源分配器。应先使所有Session在同一资源域/窗口里可比较，避免各自都把带宽充足解释成GPU预算充足。是否按像素、plane数、需求、活跃度或其他权重分配，留给主Agent。
6. `docs/control-protocol.md`、`docs/sdk.md`及适用的正式状态说明：记录新feedback与预算单位、未知值/过期/reset语义；前者现有output.configure表尚未列render_fps，实施时应同步。`protocol/control.h`目前只有控制版本和busy错误常量，JSON消息没有现成schema生成体系，不需要为了这次接线引入大范围协议重构。

最小方案不要求修改browser或SDK ABI、不需要改共享atlas布局，也不产生browser↔endpoint逐帧Mojo消息。若主Agent选用browser damage计数或精简专用rate命令，才增加`browser/offscreen_host.cc`/`harness.cc`局部字段；若选用运行时sender max_framerate，则另加`remotekit_rtc.h`、SDK实现和loader的ABI边界工作。

## 主Agent制定算法时需保留的事实边界

- 客户端RAF推算的是有效callback能力；断开会话32Hz、后台节流、窗口切屏都会改变它。没有可见性和样本有效性标签就不能解释为物理显示刷新率。
- 只用selectedViewId会漏split；只把所有plane FPS相加会重复计算同一atlas。需要保留每plane状态与一次视频流的counter。
- 带宽是per-Peer，GPU是本机共享；四个Session各自20Mbps预算不意味着有四份独立GPU。服务端公平性必须同时看到1/4租户的需求与压力，不能仅靠每Peer WebRTC码率自然解决。
- 现有drop/queue信号是压力而非最终原因；网络loss、SDK适应丢帧、Endpoint pending替换、browser跳帧应分别计数。部分没有动态内容时应标需求不足，不能当拥塞。
- 每次feedback必须有连接/布局身份、单调seq及本地接收年龄。客户端performance时间轴与Endpoint QPC不同，不能直接相减求跨机age；Endpoint从收到时开始计时即可。
- 常态统计用counter差分+真实窗口，计数回退/encoder重配/peer替换/输出generation改变需要重置基线。预算changed-only更新与每秒观测是两件事。

本报告未测试运行时rate-only RPC的实际视频效果；其“不调用资源重建”结论来自当前源码分支。正式改动仍需验证资源generation稳定、DPI/布局与split保留、输入身份不失效，并用原同组1/4租户和Pixel marker口径测量效果。
