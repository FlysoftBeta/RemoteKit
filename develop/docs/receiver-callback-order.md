# 接收端rVFC注册顺序审查

## 结论

**当前`before-work`选项在现有同步snapshot/canvas路径上已具备所需的连接、video身份和epoch保护；推广该注册顺序不需要先增加异步snapshot锁或改授权逻辑。** 是否推广仍应由同配置实测收益决定，本次只审查生命周期，没有改默认、运行测试、build或GPU实验。

关键事实是当前frame pump并没有异步snapshot：rVFC内的`drawImage`、canvas交换、授权、plane绘制、marker回调全部同步执行，没有`await/createImageBitmap/VideoFrame` Promise。提前注册下一次官方rVFC不会使下一帧JS回调打断当前同步绘制。

## 两种顺序的实际差别

文件为`control/client/transport.ts`的`startFramePump()`：

- 回调入口先校验捕获的`peer/attempt/video`与当前对象一致。
- `before-work`立即注册下次rVFC，把返回ID写入`frameCallback`，再处理当前metadata/snapshot/绘制和同步subscriber。
- `after-work`处理相同工作，在finally中再次校验身份后才注册下一次。
- 当前回调将注册方式读入局部`beforeWork`，所以回调处理中选项发生变化不会在本次finally重复注册。
- snapshot、epoch gate、输入授权和per-plane通知在两种方式中完全共用。

157的本地官方源码提供了直接依据：`third_party/blink/renderer/modules/video_rvfc/video_frame_request_callback_collection.cc::ExecuteFrameCallbacks()`先把本次待执行集合交换出去；执行过程中新增的callback归下次frame，不能在本次集合里递归调用。`video_frame_callback_requester_impl.cc::requestVideoFrameCallback()`会向media player申请下一通知，并把callback登记入集合。

因此提前登记可能让native视频线程更早知道下次通知需求，但不会制造第二个并发JS绘制者。它仍不能绕过主线程慢任务，也不能把video的presentedFrames计数当作canvas已经绘制的帧数。

## 生命周期逐项核对

| 边界 | 当前保护 | 对before-work的结论 |
|---|---|---|
| Peer重连/断开 | closeLocal递增attempt、取消`frameCallback`、清frame gate/layout/planes、关闭peer；每次establish创建新video | 提前登记时`frameCallback`正好是待执行的下一次ID，可被关闭流程取消；即使迟到仍在入口被peer/attempt/video拒绝 |
| 旧video/play Promise | rVFC捕获video身份；ontrack/play失败回调也同时检查peer/video；旧video pause、srcObject=null、remove | 不会把旧元素回调接到新元素，也不会让旧play失败覆盖新连接状态 |
| frame metadata先到 | DataChannel frame消息record RTP→epoch；rVFC observe实际RTP后才授权 | 注册先后不改变匹配条件 |
| frame metadata晚到 | rVFC同步保存到pendingFrame并记录pendingSnapshotRtp；晚metadata只允许当前已观察RTP匹配该快照 | 若新视频已覆盖pending，旧metadata不能授权新视频为旧RTP；现有late-metadata测试已覆盖此语义 |
| layout/epoch变化 | layout消息更新gate epoch，旧plane缓存/renderer失配即失效；authorize要求当前gate ready、pending RTP一致及atlas尺寸相同 | 浏览器事件不能打断当前同步回调；下一事件使用新layout重新校验，不因提前登记放宽 |
| 同epoch几何/generation变化 | rendererCurrent→planeMatchesLayout比较epoch、generation和完整plane身份/几何；getPresentedPlane还要求实际画过且当前canvas仍注册 | 旧renderer不获绘制/输入资格；已有几何/代次回归覆盖 |
| 多plane/split | snapshot只读video一次，交换一次授权atlas，dispatchPaint逐plane同步绘制，完成后才派发pendingPresentations | 不会每plane独立读livevideo；提前登记也不会让两plane横跨两个JS callback |
| direct单plane | 仅单plane、单renderer、当前epoch已完成初始snapshot且gate ready时采用；否则回退snapshot | 与注册顺序无关；输入仍需要当前实际painted plane |
| 慢marker读回 | subscriber在dispatchPaint finally中同步运行；marker先取同步同RTP plane source，再draw/getImageData/CRC | 会占用当前rVFC的主线程时间和GPU读回时间；before-work只能提前登记，不能把慢marker变成无成本，也不能去掉它冒充达标 |

## Promise、重入和晚完成的实际边界

当前snapshot和paint路径没有Promise晚完成，所以不应为了这次顺序切换引入额外队列、锁、busy gate或异步bitmap。没有发现必须先修复才能使用before-work的生产竞态。

同步subscriber可以主动disconnect/connect。before-work此时已经登记下次ID，closeLocal会取消；后续迟到callback仍被三重身份检查挡住。dispatchPaint若已取出一组旧通知，另一个subscriber仍可能收到该旧frame对象，但`getPresentedPlane/getLastPresentation/sendInput`会在当前layout/video连接状态下拒绝它。这是现有同步通知语义，两种顺序均存在，不是before-work新增的像素授权通路。

`drawImage(video)`和rVFC metadata不是浏览器提供的原子像素句柄；视频合成线程可在JS等待GPU时前进。代码已明确承认此边界，before-work并未提供更强的像素/RTP原子性。Pixel marker仍从真实绘制平面读取，实际FPS仍来自canvas新帧，而不是presentedFrames差分。

如果以后把snapshot改为异步，届时才会出现新的必要保护：

- 每份工作捕获peer/attempt/video、RTP、layout epoch/generation和完整plane身份；Promise完成后再次比较。
- 异步取得的像素必须属于捕获时帧，不能在await后再从livevideo读取并标为旧RTP。
- 有界in-flight或latest-wins提交，旧任务完成后不得覆盖新pending/authorizedFrame；销毁迟到的bitmap/frame资源。
- 取消/重连/布局切换使job token失效，不能仅取消下一次rVFC就认为异步工作也取消。

这些是未来异步改造的前置条件，不是当前before-work选项的缺失实现。

## 值得验证的真实差别

当前运行时A/B应比较rVFC/canvas FPS与相同marker p95，同时记录`videoCallbackTotal/markerReadback/viewportDraw/videoSnapshot`、presentedFrames增量、epoch misses和pending，判断收益是否来自缩短native通知空档，不能只看解码或video presentedFrames。

现有生命周期回归主要从默认after-work启动。若主Agent决定将before-work设为默认，最有价值的补充不是复写算法测试，而是：**在同步presented-frame subscriber里断开连接，确认提前登记的下一ID被取消，并人为投递已取消的旧callback，确保它不再绘制或注册。** 这针对真实顺序差异，现有取消逻辑应能通过。另将已有晚metadata/布局转换/重连实播覆盖到选定默认即可，不需要另外设计一套授权测试。

## 审查范围

本报告读取当前Client、frame gate、marker、既有presentation测试及本地157官方rVFC实现。没有修改产品、工具、协议、默认或测试；未重复45项检查，未占用runtime正在运行的唯一GPU采样窗口。

## 157媒体计数与rVFC派发：追加源码调查

runtime已实测before-work约47.04FPS/p95 87ms，after-work约47.35FPS/p95 97ms，没有吞吐收益，因此产品注册默认不变。以下是本地157官方源码的机制盘点，尚未用trace证明哪一段导致约55→47的差额。

### presentedFrames是什么

WebRTC的`video.srcObject=MediaStream`走`modules/mediastream/WebMediaPlayerMS`及`WebMediaPlayerMSCompositor`，不是普通文件播放器的`platform/media/VideoFrameCompositor`。两条路径不可混为同一对象。

MS路径的`SetCurrentFrame()`（web_media_player_ms_compositor.cc:1083）在video compositor线程、current_frame_lock保护下替换当前视频帧，写last_presentation_time/expected_display_time，随后**每次调用增加presented_frames_**。GetLastPresentedFrameMetadata（约1285行）在锁内快照该计数与当前帧；Blink把它公开为rVFC metadata.presentedFrames。

该计数记录播放器compositor的当前帧推进；它既不是JS callback次数，也不是RemoteKit canvas draw次数，更不是物理scanout完成数。算法路径只在选中不同current frame时调用；无algorithm路径也可按到达帧更新current frame。`OnFramePresented()`是另一个统计显示反馈的方法，不能因名字相近就认为presented_frames_在那里增加。

普通文件路径的VideoFrameCompositor也在SetCurrentFrame_Locked增加presentation_counter_，概念相似，但本次优先看MS trace事件。

### native通知到JS callback的链

```text
JS requestVideoFrameCallback
 → WebMediaPlayerMS::RequestVideoFrameCallback（主线程，约1472行）
 → MSCompositor::SetOnFramePresentedCallback：锁内覆盖一个one-shot closure
 → SetForceBeginFrames(true)，重置force timeout，保证隐藏video仍有媒体BeginFrame需求

video compositor线程 SetCurrentFrame
 → presented_frames_++
 → move并清空one-shot closure → BindPostTaskToCurrentDefault投递renderer主线程
 → WebMediaPlayerMS::OnNewFramePresentedCallback
 → Blink VideoFrameCallbackRequesterImpl::OnRequestVideoFrameCallback
 → callback集合非空才ScheduleExecution
 → pending_execution_合并重复调度
 → ScriptedAnimationController::ScheduleVideoFrameCallbacksExecution入队
 → 下次PageAnimator rendering steps：先执行video callback步骤，再执行普通RAF步骤
 → OnExecution读取此时最新播放器metadata
 → presented_frames与上次相同：stale，不调用JS
 → 不同：ExecuteVideoFrameCallbacks，向本轮已登记JS callbacks送同份metadata
```

one-shot closure和pending_execution_都说明这不是“一次native帧必然排一份JS事件”的无损队列。多个媒体帧可在一次JS取最新metadata前推进，JS看到的presentedFrames会跳号；这可以说明callback少于该counter的机制，但不能仅据跨线程或平均FPS就认定它是当前差额的根因。

PageAnimator中的rVFC步骤与RAF步骤共享渲染服务，却不是同一个计数：有RAF不代表rVFC待执行队列有任务，有rVFC任务不代表媒体计数一定已变化。媒体55FPS与RAF56.5Hz也不强制产生55个不同帧的JS callback。若媒体通知赶在某次rVFC步骤之后到达，会等下一渲染步骤；该期间帧可能合并，或某轮取到stale metadata。需看逐事件相位，不能从两个均值推导丢了哪一帧。

### 157的近刷新率快速调度分支

`video_frame_callback_requester_impl.cc`的IsFrameRateRelativelyHigh仅当`abs(1-rendering_interval/average_frame_duration)<0.05`时为true。OnExecution结束时，若此条件成立、还有callback且连续stale少于2次，直接ScheduleExecution，减小media通知刚错过rendering steps的机会。

这不是以公开RAF均值和presentedFrames FPS作比较。MS提供的rendering_interval是last_render_length_；algorithm路径来自deadline范围，无algorithm路径还会以帧timestamp差更新。average_frame_duration由GetPreferredRenderIntervalInternal选择：algorithm平均帧间隔、last_render_length_，或无reference_time且含RTP时的RTP估计器。当前0/0播放请求可能影响reference_time/algorithm路径，但仅凭现有统计无法确定实际走哪支，也不能断言55/60差距导致is_hfr=false。synthetic120诊断的结果同样要结合这两个内部间隔解释。

## 最小10秒trace建议

由唯一runtime实验窗口执行，先暖机5秒，再只录制10秒；保留现有分辨率、marker1Hz、网络和选定注册方式。trace组只用于定位，不混进无trace性能验收。无需改Chromium或开启昂贵截图/栈采样。

建议首轮category：`media,blink,cc,toplevel,devtools.timeline,disabled-by-default-devtools.timeline`。若体积超预算，先去devtools.timeline扩展，保留media/blink/cc/toplevel。browser.startTracing或CDP Tracing均可，关闭后落到develop/tmp。同时保留原有raw rVFC metadata（尤其presentedFrames/mediaTime/presentationTime/expectedDisplayTime/now）、clientRAF和marker成本；不必再增加一条独立rVFC链或每帧console日志。

已有、可直接观察的原生事件：

- `media / WebMediaPlayerMSCompositor::EnqueueFrame`：到达帧；不是呈现完成。
- `media / UpdateCurrentFrame`：compositor deadline及Render选择。
- `media / WebMediaPlayerMSCompositor::SetCurrentFrame`：包含视频Timestamp，计数增加位置；与duration事件`SetCurrentFrame`区分，避免双算。
- `media / SetCurrentFrame Timestamps`：presentation_time/expected_display_time。
- `media / RenderWithoutAlgorithm Difference From Deadline`：确认无algorithm路径及相位。
- `media / WebMediaPlayerMSCompositor::GetCurrentFrame`及`PutCurrentFrame`：当前帧读取/使用；可用媒体Timestamp与raw JS mediaTime对齐。
- `blink / VideoFrameCallbackRequesterImpl::OnRequestVideoFrameCallback`：主线程收到通知，带has_callbacks。
- `blink / VideoFrameCallbackRequesterImpl::ScheduleExecution`：带did_schedule，区分真正排队和pending合并。
- `blink / VideoFrameCallbackRequesterImpl::OnRenderingSteps`：带has_callbacks；包括可能stale的轮次。
- `blink / VideoFrameCallbackRequesterImpl::ExecuteVideoFrameCallbacks`：真正派发新metadata的轮次。
- `blink / VideoFrameCallbackRequesterImpl::requestVideoFrameCallback`：应用登记时刻。
- `blink,rail / PageAnimator::serviceScriptedAnimations`，以及`cc` BeginFrame/BeginMainFrame、toplevel RunTask：把通知和视频步骤放到实际主线程服务相位中。

先数同一播放器/renderer的SetCurrentFrame、OnRequest、did_schedule=true、OnRenderingSteps、ExecuteVideoFrameCallbacks及raw JS callback，再检查每段最明显的计数落差。不要跨进程/播放器合计，transport与benchmark可能各登记一次JS callback，但一轮ExecuteVideoFrameCallbacks会向多个callbacks派发，不能拿登记总次数当视频FPS。

可区分的问题如下：

1. SetCurrentFrame≈55，OnRequest明显少：one-shot通知未及时rearm/合并候选；结合JS登记与media帧相位，不能仅凭少于计数就判bug。
2. OnRequest较多、did_schedule=false较多，Execute约47：pending合并或rendering service时间窗候选。
3. OnRenderingSteps接近RAF56，Execute约47：stale metadata轮次；看媒体帧与步骤的相位，及有没有RunTask长等待。
4. Execute≈55而raw/canvas47：再检查多个callback链、脚本处理/生命周期与绘制路径；本轮已有gate0miss使授权等待缺乏支持，但仍用trace核对。

当前原生trace没有在OnExecution事件中直接暴露is_hfr、两个interval值或stale计数。若首轮仍无法区分，只能将这些保留为未知，再由主Agent决定是否增加有界官方patch观察；不在本轮无证据下修改调度算法。

还可在采样首尾读取`video.getVideoPlaybackQuality()`作为辅助：MS的DroppedFrameCount来自播放器compositor，SetCurrentFrame会把从未rendered的前帧计入本地drop；它与RTC网络loss、Endpoint queue drop语义不同。即使该计数上升，也不能直接称网络丢帧或物理显示丢帧。
