# B56 source → delivery 缺口调查

2026-11-01，只读离线调查；未构建、启动 browser/GPU、修改产品源码或提交。输入为 D2 B52/B56 同 binary 正式组、现有资源数据和当前源码。

## 结论

B56 peer0 的主要缺口在 **JS render 到共享 atlas 发布之间**，已有发布帧基本都被 Endpoint 借到、提交并完成编码。应优先测 Viz capture admission、GPU copy 完成和三槽归还循环，不能继续把它归为 encoder drop，也不能凭 GPU 总利用率不到100%排除 GPU 队列或任务等待。

最可能的解释是源端 GPU/capture 流水线在56Hz负载下延迟增长，三槽的捕获/归还可用时间随之不足；其次是同一条路径的任务调度或 oracle admission。现有数据能定位阶段，尚不能在这些机制中选定唯一根因。源 render 是 JS 执行次数，尚未证明每次都提交、激活或捕获一个新的 compositor frame。

## 计数和计时的实际定义

|字段|代码定义|判断边界|
|---|---|---|
|source render|`tools/streaming-source-probe.mjs` 在 fixture `render(now)` 入口记录传入的 RAF 时间；`control/public/test-pattern.html` 随后执行canvas和marker绘制|是JS render入口计数，不是GPU完成或compositor提交计数；时间是RAF参数，不是执行结束时间|
|atlas发布|`browser/gpu_atlas.cc:CaptureAtlasFrame` 在成功capture callback中递增frame_id并发布共享元数据|D2直接池callback已过GPU捕获完成；frame_id从此处开始，未capture的源内容不会形成跳号|
|atlasDeliveredFrames / atlasDeliveredFps|`AtlasPool::Poll` 成功返回共享纹理lease时递增；秒级report取计数差/实际QPC间隔|是Endpoint成功借到的publication数量，不是上游源帧数量|
|atlasPoolDrops|成功借用时，publication frame_id相对上次借用的跳号数|表示已发布但此consumer未借到的帧；不记录Viz无buffer、oracle拒绝、源compositor未提交|
|encodeSubmitted|EncoderWorker硬件Submit返回accepted后递增|发生在external VPP Convert之后|
|encodeCompleted / encodedFps|硬件完成后调用RTC encoded接口，再递增completed；秒级report取差|completed即使RTC返回INVALID_STATE也会递增；正式组解码与它接近，但不能把定义改为成功网络交付|
|encodeDropped / pendingReplaced|EncoderWorker明确拒绝/替换/关闭未完成job的事件计数|没有进入worker的源内容不在此计数内|
|captureToReadyMs|metadata.capture_end_time到Endpoint成功borrow的QPC差|**排除了capture_begin→capture_end的GPU捕获时间**；Chromium在成功CopyOutput结果处理时写capture_end_time|
|lastEncodeMs|worker在external VPP Convert成功后设置submitted_qpc，直到硬件完成及RTC completion返回|**排除了BGRA→NV12 VPP提交和GPU等待、worker排队、SDK source队列等待**|
|queueWaitUs / queueWaitSamples|worker入队到出队的累计耗时与次数|不包含出队后的VPP GPU等待|

源码入口：`endpoint/src/service.cpp:MediaLoop`，`endpoint/src/media/atlas_pool.cpp:Poll`，`endpoint/src/media/encoder_worker.cpp:Enqueue/Run/Complete`，`browser/sdk/remotekit_rtc.cc:TextureSource::Submit/remotekit_rtc_submit_texture`。本调查只读取了正在由另一Agent修改的atlas_pool.cpp，没有编辑该文件。

## 原始指标补充

来自 `develop/tmp/capture-to-atlas-d2-B-fixed56-t2/metrics/client-metrics.jsonl`，通过正式 `tools/streaming_metrics.py` loader读取。分段沿用既有startedAt与15秒边界；Endpoint首尾差按实际样本间隔，不把异步快照当逐帧同步。

|peer0分段|source|delivery|encode completed|decode|atlasPoolDrops增量|ready gate deferred frames/polls增量|worker pending replaced/drop增量|
|---|---:|---:|---:|---:|---:|---|---|
|0–15秒|56.00|52.916|52.916|52.916|0|0/0|0/0|
|15–30秒|56.00|50.073|50.073|50.073|0|0/0|0/0|
|30–45秒|55.93|43.142|43.071|42.999|0|0/0|0/0|

全rtcSamples首尾覆盖比三个15秒片段稍宽，peer0 atlasPoolDrops为3→4（增量1），peer1为0→1（增量1）。peer0 delivery/borrow增量2193，submitted/completed增量2192/2192；peer1分别2490/2490/2490。两路hardwareBusy、pendingReplaced、encodeDropped增量均0，tailIdrSubmissions也始终0。B52对应的两路atlasPoolDrops增量均0、delivery/submitted/completed完全同增量。正式B56的约数百帧source差额不可能由这1个未借publication解释。

peer0 worker平均queue wait按累计值差计算，三个分段为0.171/0.156/0.467ms；peer1为0.210/0.255/0.656ms。秒级encodePending几乎全0、inflight最大1，没有持续worker积压。peer0最后15秒lastEncodeMs均值9.003ms/max13.539ms，captureToReady均值2.615ms/max7.247ms；由于上述计时定义，仍不能排除VPP或capture阶段的长等待。

现有资源按各client共同正式窗口分段，peer0为Session1/browser23188/source GPU15632/renderer10836，peer1为Session3/browser25544/source GPU22832/renderer21892（Session2为空闲初始会话）。

|资源|0–15秒|15–30秒|30–45秒|
|---|---:|---:|---:|
|peer0 source GPU进程3D运行时间占比 %|19.97|19.86|22.13|
|peer1 source GPU进程3D运行时间占比 %|20.91|20.87|24.37|
|peer0 source GPU进程CPU cores|0.440|0.443|0.622|
|peer1 source GPU进程CPU cores|0.453|0.465|0.689|
|peer0 source renderer CPU cores|0.558|0.612|0.752|
|peer1 source renderer CPU cores|0.523|0.526|0.786|

这些是进程聚合平均，不是线程饱和测量。末段两源CPU与3D工作都增长，但只有peer0交付明显退化；资源证据支持“负载/等待增加”，不证明哪个队列先达到临界点。总Intel3D末段80.81%、host CPU p95接近97%同样不能决定局部瓶颈。

## 三槽和定时器链路

实际循环为：Viz专用池Reserve三槽之一 → GPU CopyOutput → Browser capture callback立即publish → Endpoint借BGRA → SDK/worker持lease → external VPP读取完成 → H264完成/SDK释放 → Endpoint refs归零 → MediaLoop下一次Poll向consumed和local done fence提交Signal/Flush → Browser健康Poll观察consumed完成后callbacks.Done → Viz `NotifyFrameReleased`销毁VideoFrame → `Generation::OnFrameDestroyed`再post一次ReturnSlot → 下一次Reserve才可复用。

`CaptureToAtlasVideoFramePool`容量硬编码3，无空槽Reserve返回null，capturer记录`PipelineLimited`、RecordWillNotCapture并安排refresh。这是capture admission未发生，不能称为encoder drop。Endpoint的heldSlots只统计已借用且refs>0的slot；它不含正在Viz捕获、等待Browser Done、等待Viz ReturnSlot的槽。held均1.11/p95 2并不能证明专用池从未满。

MediaLoop额外保留一个latest lease用于idle refresh，直到下一帧borrow后才release旧latest。这是当前行为。external VPP模式还把worker的BGRA源lease持有到H264 completion，虽然`GpuConverter::Convert`已经通过Fence等待确认BGRA读取完成。该额外占槽时间是有代码依据的优化候选；要安全提前释放，应把源像素lease与job/RTP/metadata生命周期分开，不能直接删掉Complete中的release或改变异步VPP/NVENC语义。

B56 config的`endpoint.pollTimer`为default，prepare脚本据此设置`REMOTEKIT_GPU_POLL=default`。因此Browser atlas健康轮询使用普通2ms RepeatingTimer，**没有开启可选precise atlas poll**。无browser-trace，无法确认其实际wake分布、high-resolution状态、consumed完成→Done延迟。Endpoint main调用timeBeginPeriod(1)，MediaLoop用1ms condition_variable wait；调用返回值和实际调度精度没有正式记录。SDK QPC high_resolution字段描述时钟分辨率，不是调度timer已开启的证明。

Offscreen BeginFrame pacer是另一套绝对deadline/kPrecise实现，56Hz约17.86ms在正常precise窗口内，source JS56支持它成功提供了足够RAF机会；并不证明atlas2ms归还timer也是precise。正式receiver honorClientTimerResolution=false，receiver fake60不改变此区分。

## 最小必要诊断与下一实验

先保持B52为性能候选，不追加58/60。一次固定B56、10秒暖机+45秒诊断组即可；诊断组单列，保持分辨率、CRC、network、binary及客户端条件，构建窗口与采样错开。

1. **补最小计数/时长直方图，避免先开全部逐帧trace。** Viz按generation输出OnFrameDamaged、oracle rate reject、Reserve success/failed-all-busy、capture admitted、capture result分类、delivered计数；池输出busy高水位和各busy数驻留时间。这样先区分“没有compositor damage”“oracle拒绝”“无slot”“捕获未成功”。
2. **度量三槽生命周期。** 记录capture_begin→capture_end、capture_end→Browser callback、publish→Endpoint borrow、VPP begin→complete、lease refs0→consumed GPU完成、consumed完成→Browser Done、Done→Viz ReturnSlot。按source/capture counter、generation、slot/token、publication frame_id关联。已有browser/server profile可覆盖中间部分，缺Viz Reserve/ReturnSlot及actual GPU fence完成观察。只在需要时对15秒尾段打开现有gpu.capture/CopyOutput诊断。
3. **单独核对poll节拍。** Browser记录2ms poll实际间隔p50/p95/max及consumed→Done延迟；Endpoint记录MediaLoop loop间隔、Poll耗时、VPP等待耗时，记录timer请求状态/返回值。不要以timeBeginPeriod调用或QPC high_resolution推断调度已生效。
4. **根据计数决定唯一A/B。** 若slot-all-busy与consumed→Done/ReturnSlot长尾同现，固定56只比较default与已有precise poll；若busy主要由worker源lease在VPP完成后继续占用，比较“external VPP已完成即退休BGRA源lease”的局部候选；若busy不高而damage/CopyOutput提交数下降，则转源renderer提交/激活和Viz任务post→run profile。不要先扩槽或提高async depth掩盖归还时间。

判定成功：计数能解释大部分JS render→publication差额，并能明确其中哪段时间/哪种admission原因随peer0末段恶化；最终性能仍需关闭诊断profile后回到相同正式配置验收。现有B56没有browser/server/official逐帧trace，无法事后补出这些缺失时序。

## 产物与检查

阅读现有D2 B52/B56 config、summary/details/segments、原始metrics、source-trace、resource-samples/processes及源码。离线Python聚合通过；本文件为唯一新增文件，没有改变既有case结果。未运行产品测试、构建或GPU实验。
