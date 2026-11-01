# Atlas publication 节拍定向调查

2026-11-01，先只读调查；主 Agent 获得10秒实测后决定并授权最小publication修复。当前已经实现并自审，没有构建、运行浏览器、占用 GPU 或提交。

结论：publication 的“距上次真实执行满一周期”判断累计调度迟到，已实测造成约55FPS capture降为42FPS publication。实现改为绝对 deadline 加 dirty 时一次性精准唤醒；性能改善待统一构建窗口及同负载A/B验证。测试页自身也丢掉约5FPS，本轮保持fixture不变。

## 新增10秒归因与实现

主 Agent 转交的独占运行证据：`develop/tmp/qsv-external16-publication10/publication-summary.json`。同10.004815秒窗口 RAF60.071/render54.874，capture_callback549（54.874FPS），source_counter无洞；atlas_publish/direct_source_copy424（42.380FPS），125个callback未copy。Poll601（60.071Hz），间隔p50/p95为16.662/17.952ms；publication间隔p50/p95为21.561/32.409ms。Endpoint atlasPoolDrops/pendingReplaced均零。该组把稳定损失定位到browser publication，不再需要推测Oracle是否已降为42FPS。

已修改 `browser/gpu_atlas.cc`：新专用publication DeadlineTimer默认按需运行；绝对phase仅在成功后以IntDiv推进，跳过全部过期槽；fps改变、Stop/Lost/consumer退出取消重置。普通dirty循环不改相位，metadata/geometry/StopView的dirty同样立即尝试并安排deadline。低fps沿用官方精确窗口预唤醒规则，避免远期kPrecise被调度器降级。槽满或direct source mutex暂忙以未来2ms重试；尚未提交读取的source可被下一capture替换，提交后的lease仍只由原真实ready fence回收。专用timer调用现有Poll，健康/lease Poll本轮不重构，ready/consumed fence、GPU提交和ABI均不变。

自审覆盖first dirty、普通dirty、长静止、迟到跳槽、fps重配、metadata-only、槽满、mutex暂忙/失败、Stop/Lost与consumer退出。修正了自审发现的ClearStage唤醒位置，确保staging clear提交后再尝试publication。`git diff --check`通过；构建与实播由主 Agent 统一分配窗口，未把源码检查写成运行通过。

独立审阅后主 Agent 固定同State capture epoch语义：ClearStage清除document/instance/geometry旧缓存时，先取消publication timer并重置相位，再清GPU内容，最后即时尝试publication，避免低fps下新布局stale等待旧预算。普通focus metadata/dirty不reset。已按此修正；已提交GPU读的lease与Fence仍不受reset影响。

## 最近两组现有证据

读取 `develop/tmp/qsv-{external16,async16}-t1-r60` 的 `source-trace/<case>-0.json`、`metrics/client-metrics.jsonl`、config 与 endpoint-args；没有扫描其他工程目录。

用 `metrics.timeOrigin + startedAt - source.timeOrigin` 对齐 source raw 到相同 30 秒正式窗口。stats 计数使用首尾 rtcSamples 的真实时间差。

| 环节 | external16 | async16 |
|---|---:|---:|
| source RAF FPS |59.9849|59.9833|
| source render FPS |54.9195|54.9847|
| source RAF interval p50/p95 ms |16.8/18.0|16.8/18.1|
| source render interval p50/p95 ms |16.9/32.4|16.9/32.5|
| Endpoint atlasCopies FPS |42.6934|42.6592|
| Endpoint encodeCompleted FPS |42.6934|42.7258|
| Endpoint atlasPoolDrops 增量 |0|0|
| Endpoint pendingReplaced 增量 |0|0|

两个 case 的 browserTrace/serverTrace/copyOutputProfile 均 false，browser-trace 没有动态组事件；不能把缺失的 capture/publication 频率补成 60 或 42.7。Endpoint 丢 publication 的 frame-id 计数为零，取到的 atlas 与编码完成基本一致，说明稳定损失集中在 source render → official capture → browser publication。

fixture 的 `tick` 是 `if(now-last>=1000/fps-1){last=now;render(now)}`，正式源位置为 `control/public/test-pattern.html:14`；另一个 fixture `control/public/compositor-pattern.html:38` 也使用相同限速式。60FPS 下阈值约15.667ms，一次早到 RAF 会跳过一次页面更新，接下来的迟到又以 `last=now` 改写相位。对齐窗口 external 的1800个RAF只调用1648次 render，async 为1800/1650；render 不等于 RAF。该问题不阻止其当前约55FPS动态内容作为 ≥50FPS 的源，但应单独记录，不能把它称为真实 render60。

现有 `qsv-async-functional-d1/browser-trace/browser-10876-atlas-1.json` 有99个 capture_callback、94次 publication、6个 direct_pending_replaced、15个 backpressure_polls；它是 render30/change-stop 功能组，含启动、停止及输入，不能套用到 r60 性能组。旧 `source-cadence-720` 的53.06 callback/52.76 publication也说明双重节流损失取决于源与调度相位，不能根据源码断言固定42.7上限。

## 各层实际抑制点

1. **OffscreenHost 的 tick admission 与 frame_time。** `browser/offscreen_host.cc:200` 的 Tick 按绝对 deadline、整数 IntDiv 跳过旧槽；只保留一个 tick 信用，pending ACK 会合并信用。`MaybeIssueFrame` 在实际发送时取 `TimeTicks::Now()` 作为 BeginFrameArgs.frame_time，deadline=now+interval，并没有将理想相位时刻作为 frame_time。因此定时发送均值60，不代表每个 compositor event 的时间差都精确16.666ms。当前单租户 source RAF 已证明均值60，不能仅凭该实现认定它是42.7瓶颈。

2. **官方 capture admission。** `FrameSinkVideoCapturerImpl::OnFrameDamaged` 用 aggregation 的 expected_display_time 送入 VideoCaptureOracle；不是 browser 收到 capture callback 的时间。Oracle 的 kCompositorUpdate 先更新 sampler，再决定是否产生 CopyOutput；随后 buffer pool 取不到帧会 PipelineLimited，CopyOutput失败和结果排序也可能减少最终回调。bounded capture patch 另有 admission gate，但该组配置 captureMaxPending=0，未启用。

3. **SmoothEventSampler 是 token bucket，并非 `now-last>=period`。** 本地官方源码 `media/capture/content/smooth_event_sampler.cc`：桶容量1.5周期，event 时间差补 token，RecordCapture 扣一个周期。它可吸收约半周期抖动，不会因每次回调略早就系统性隔一帧。`SetAnimationFpsLockIn(false,0)` 使 AnimatedContentSampler 不参与；`SetAutoThrottlingEnabled(false)` 关闭自适应 capture 节流，但仍保留这个名义60FPS上限及真实 buffer/CopyOutput 背压。metadata.frame_rate 仅由 min_capture_period 推导，不是实测 callback FPS。

4. **Browser publication 是第二个、且会漂移的 cap。** `browser/gpu_atlas.cc:752` 的 PublishIfFree 先比较 `now-last_publication_ < 1/fps`，拒绝后不安排该 deadline；只能等下次 callback 或 Poll。成功后 `last_publication_=now`，把本轮晚醒量永久加到相位。默认 RepeatingTimer 2ms 有 flexible 调度，旧实测 poll p95达15.66ms；opt-in precise 也每轮从 `now+2ms` 重新起算。单平面direct在等待中只持有最新 pending_capture，下一回调替换未提交旧帧；staging路径合并dirty和stage最新内容。两者都能有 capture>publication，而且不是输出 drop/error。

5. **Endpoint 仍可能跳帧，但本组证据不支持它主导。** `endpoint/src/media/atlas_pool.cpp:159` 先交付已完成 private copy，再读最新 mapping；无空cache槽或 ready gate 可延后，拿到较新frame_id时记录 atlasPoolDrops。取帧后的 consumed signal 排在GPU CopyResource之后；浏览器以真实 consumed completed value 才复用共享槽。当前两组 atlasPoolDrops/pendingReplaced 均零，且copies≈encode，因此继续调编码参数无法解释前段约55→42.7损失。

## 最小修复候选，待主 Agent 选择

先只改 browser atlas 的节拍，不改 capture sampler、GPU lease 或协议：

- 用 `next_publication_deadline_` 代替 last_publication_。初次dirty/恢复或fps变化重新建立相位；成功后按 `IntDiv` 整数槽推进到 now 之后，跳过过期预算，不重放历史帧。迟到不再向后漂移。代价是一次迟到后相邻publication间隔可以短于周期，长期频率仍有上限；这是绝对节拍的行为，需要明确接受，不能同时继续套用最短真实间隔cap。
- dirty 且尚未到 deadline 时，安排单个可取消 DeadlineTimer 到绝对 deadline，使用 kPrecise。低fps下沿用 OffscreenHost 的 kMaxPreciseDelay 预唤醒规则。callback直接尝试发布、deadline唤醒及Poll共用一个入口，不制造多次tick信用。
- dirty但 consumed槽全忙时，不推进 deadline、不清dirty，合并最新内容并以有界精准短重试等待真实Fence；不能把CPU publication/提交返回当作完成。读取 source lease 的 Done 仍只能在 ready Fence 真正完成或确认device removed后执行。
- 精准publication timer在dirty清除后停止，静态无dirty不持续2ms醒。现有Poll还负责source lease回收、consumer退出、device lost及geometry timeout；最小实施可以保留独立低频健康检查，在存在lease/背压时恢复短poll，不能直接删Poll。若要彻底事件驱动回收，可另案使用Fence completion event；不需要为这轮引入跨browser↔endpoint逐帧消息。
- SetFps/SetViews/StopView/Stop、几何stale publication、输出代次重建必须一起取消/重算timer。尤其是仅metadata dirty也应走相同一次性唤醒；不能只在 CaptureFrame 中安排。

绝对deadline具体语义：未初始化时first dirty可立即发布；已有相位时若now>=deadline，只发布最新dirty一次，然后 `deadline += (IntDiv(now-deadline, period)+1)*period`。没有dirty不发帧，下一次dirty到来时按同式跳掉整个静止期，不追发欠账。不能在每次dirty从false变true时重置相位，因为正常每帧成功后dirty都会归false。fps重配/代次重建取消旧任务并重置相位；槽满重试不消耗publication预算，past deadline必须改用未来短重试，避免即时自旋。ready/consumed/source lease完成判定不随timer变更。

另一个独立小修复是 fixture 用绝对render deadline，而非 `last=now`：保留一个 `nextRender`，RAF到时一次渲染并按整数period跳槽推进，而不是加本次晚到量；60档可让每次RAF渲染，低fps继续绝对节拍。重活动/模式改变不追发旧帧。同样分组对照并记录fixture hash，避免把改变工作负载的收益归给产品publication修复。当前四租户配对运行期间不要改fixture或服务二进制。

## 建议的一次有界诊断

无需先扩大四租户矩阵。在现有1080单租户/render60/default Chrome89/RTT10ms/24Mbps/marker1Hz同配置，读取正式采样前后的 `output.status`，直接差分 `capture_callbacks/captured/frame_id/direct_pending_replaced/backpressure_polls`。该RPC已有这些字段，无需新增逐帧通信；用短browser trace保留 callback/source counter/publication/poll/lease回收分布可补足时序。trace组用于归因，与正式profile-off验收分开。

判定顺序：callback≈55、publication≈42 支持publication候选；callback已≈42则先看官方CaptureOracle FpsRateLimited/PipelineLimited/CopyOutput完成及source damage。改动后比较同组capture/publication/copies/encode/decode/canvas及marker p95；服务端提高到50也不能替代已独立确认的接收端32Hz显示环境修复。

### 10秒单租户trace应取的已有观测

独占GPU、稳定暖机后固定10秒窗口，fixture不改；每组保存相同二进制/参数hash。只读数据取样点用同一TimeTicks/QPC映射对齐，不能拿整个启动trace的计数除以10秒。

| 观测 | 已有来源 | 能区分什么 |
|---|---|---|
| source RAF/render raw | source-trace 的 raf/renders | 源tick和页面真实更新；当前约60/55 |
| BeginFrame sent/acked/merged/skippedPhaseTicks | session.snapshot 的 compositor.renderHost | admission/ACK合并或漏相位 |
| capture_callbacks、captured、frame_id | output.status 采样前后两次 | 直接得到capture/publication频率，profile可关闭 |
| dropped、mutex_drops、geometry_transition_drops、direct_pending_replaced、backpressure_polls、pending_source_leases | 同output.status | 区分桥接拒绝、direct等待替换及槽背压；backpressure_polls不是掉帧数 |
| capture_callback / direct_source_copy / atlas_publish / poll / source_read_done | REMOTEKIT_MEDIA_TRACE 的browser raw | 回调与发布相位、poll迟到、capture end→发布、提交→真实GPU完成 |
| capture_callback.source_counter/capture_begin_us/capture_time_us | 同browser raw | source_counter是实际capture request counter；有跳号提示请求已产生后交付减少，连续counter的42FPS不能排除Oracle/无damage限速 |
| atlasCopies/atlasPoolDrops、encodeSubmitted/Completed、pendingReplaced、errorDrops | 现有metrics.rtcSamples.endpoint | 映射publication→cache→encode；drop计数与频率差同时判断 |
| atlas_observed / atlas_private_copy_submit / atlas_ready_observed / atlas_private_copy_complete | 需要时开REMOTEKIT_SERVER_TRACE | Endpoint是否观察却未copy、ready等待和private copy耗时 |

10秒仅开browser raw已经足以把“capture约55→publication42”和“capture已42”分开。若后者发生，再加一个相同配置的官方Chrome `gpu.capture` trace 诊断组：已有 `FpsRateLimited` 的trigger、`PipelineLimited`、`ReservingVideoFrame`、`Capture` begin/end及result、`FrameInUse`。FpsRateLimited事件需按trigger区分compositor-update与refresh-request，不能把refresh重试次数当作丢源帧数。`capture_counter`在成功reserve之后递增，Oracle前拒绝和pool reserve失败不会留下counter洞；CopyOutput失败/交付失败可能留洞。已有CopyOutput profile补丁的 `RemoteKitCopyCreated`/request id可关联更深GPU阶段，但不必先把它加入全部组。以上均是现有事件，不需要先新增架构或IPC。
