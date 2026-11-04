# Client默认触控手势桥

这是`client-v1`的新路径契约与实现说明；旧TouchEmulator的运行验收不能证明本路径通过。Browser与直接调用生产helper/官方filter的CPU probe已构建运行通过；真实157 tap及根滚动最小判因已执行，完整专项与移动设备QA尚未完成。

## 能力与wire

Browser `snapshot`（Control侧`session.snapshot`）顶层宣布`clientGestures:1`。Endpoint须把这项能力下放到Viewer的`layout.clientGestures`（或独立`input.capabilities`消息），不得依据Endpoint版本猜测Browser能力。未宣布时Viewer显式使用`gestureMode:"legacy"`；旧缺省也进入legacy。一个physical序列中不能换mode，两条识别链不能同时运行。

每个`type:"touch",gestureMode:"client-v1"`包保留现有points、source clock、samples，并必须有`gestures`数组（最多8，可空）。候选`type`为`tapDown/tapCancel/tap/scrollBegin/scrollUpdate/scrollEnd/pinchBegin/pinchUpdate/pinchEnd/flingStart/flingCancel`。坐标`x/y`、`deltaX/deltaY`是root DIP；scroll delta及`velocityX/velocityY`与手指位移同号，速度单位DIP/s；`scale`为本次倍率。GSB/GSU需要两个delta字段，pinchUpdate需要scale，flingStart需要两轴velocity。事件时间来自所属touch的source sampleElapsedUs。coalesced raw历史先空候选重放，整个候选数组只附最后raw包；多changed contact时TapDown附首个raw，其余候选附最后raw。

TapDown必须绑定首个global touch ID。pinch序列在scrollBegin之后、scrollEnd之前。flingStart只随最后一指up产生，且替代该包的scrollEnd。所有raw继续送网页，包括候选被拒绝的情况；错误候选/队列上限导致显式输入失败并取消owner，不能退回到另一套识别。

单指scrollBegin的方向hint不能双0：官方TouchActionFilter用该方向评估CSS许可，双0会进入为包装pinch保留的特殊路径。production helper拒绝这种单指候选，pointer count只取Browser已维护的真实raw触点状态，不读取候选伪造的计数。真实双指pinch的零hint包装仍交官方filter处理；它先检查pinch-zoom权限。

## 仲裁和目标

Browser为每个实际raw创建GestureEventDataPacket，先送官方TouchDispositionGestureFilter再RouteTouchEvent。canonical ACK受管hook只拦截已注册的global ID与root owner；无target、target销毁与callback销毁都不会把这些ACK误交给Aura已有recognizer。不相关系统触摸保留官方ACK链。

每个packet都按真实ACK处理preventDefault，consumed/unknown不能授予默认候选。首down未消费不代表后续move许可。Filter放行后的手势仍通过原InputRouter/TouchActionFilter与OOPIF routing；不伪造auto、不发送wheel。关闭官方scroll update的ACK延迟补偿，避免更改Client已计算的delta。

严格Client路由只接受首ID已有的目标map绑定，并检查后续owner ID与预期target；拒绝缺失map时的legacy TapDown重新hit-test。文档、实例、focus、布局失效和target销毁收尾原owner，不能把迟到候选投给新页面。

正式离屏Browser在`MainDelegate::BasicStartupComplete`的非demo分支，通过`ConfigureServiceScrollPolicy`固定关闭官方`ResamplingScrollEvents`；已有disable-features项保留，该策略随正常feature列表传播到renderer。该服务进程的输入来自Client，位移与惯性已在Client计算，renderer不再二次预测。此策略不关闭raw touch、官方preventDefault/touch-action仲裁、手势识别或普通页面动画；legacy仍走官方识别，但也不再进行renderer滚动重采样。独立demo、宿主与Viewer Chrome保持各自默认策略。

固定Chromium157的`ScrollPredictor::UpdatePrediction`在首个Momentum GSU且默认`ResampleScrollEventsForFling`关闭时直接停用重采样，未补偿direct累计输入与已预测输出的差。生产predictor CPU probe以8×27.5DIP direct再接289.8148DIP momentum复现：frame/source偏移-10/0/+10ms时direct输出199.375/213.125/226.875DIP，momentum三组均完整；因此尾差可少也可多，不能补固定距离。原真实attempt2 DOM471而预期509.8148；同产物仅关闭此feature的normal及move延迟70ms两条真实轨迹均DOM510、误差0.1852DIP，terminal processed、媒体身份稳定。该最小判因不能替代修复构建后的完整专项。

## 完全Client惯性

官方TouchDisposition放行flingStart后，Browser截住它，不送native FlingController。官方filter已经把该序列标为fling，因此不会在up自动补GSE；Browser保留原scroll target。受管`SetClientMomentumActive`只在这一许可点保持原target真实active touch-action，避免up ACK结束后重置成auto；每个惯性GSU仍经过官方filter。取消/新down/结束/超时/文档或target丢失都会解除保持。

固定Chromium157的UP ACK调用顺序是`InputRouterImpl::OnTouchEventAck`先同步调用disposition handler→`RenderInputRouter`→router canonical ACK queue→bridge→TouchDispositionGestureFilter。放行fling的同步callback在这里设置pin；整条回调返回后，InputRouterImpl才对active touch减计数并调用ReportAndResetTouchAction。该target的PassthroughTouchEventQueue按首项ACK推进且阻止重入，当前physical序列锁定同一raw target，因此前序raw先完成；无target或target销毁不进入许可。这里依据真实调用链核对时序，probe的手工驱动不能单独证明这条链。

后续事件为`{type:"gesture",gestureMode:"client-v1",sequenceId,action:"momentum"|"momentumEnd"|"cancel",sampleElapsedUs,cumulativeX,cumulativeY}`。elapsed延续首down时钟，cumulative从up处的0累计。Browser只把累计差转换成`inertial_phase=Momentum`的GSU，不估计速度、不生成raw touch moves/ACK。momentumEnd先应用最后累计值，再发GSE。许可ACK前只缓最新一条；拒绝时丢弃并结束scroll。正常Client曲线最长2秒；Browser另有2秒无进展期限与5秒source/接收总期限。到达延迟不能改变累计距离曲线，但超过期限会安全截断。

source elapsed与Native事件时间是两个域。前者独立保留，用于原始历史顺序、up时刻及惯性期限；后者在raw、候选、惯性和收尾共同约束为非递减且不晚于Browser当前TimeTicks。不能从被调整的Native timestamp反算source elapsed。特别是arrival fallback首包排队较久、后包较快时，`首包到达+source elapsed`会落到未来；保留其原始age诊断，但不得把未来时间交给Blink/EventMetrics，也不因此改变Client位移。

## 完成查询与Endpoint集成

raw路由之前若官方packet检查拒绝，撤回该global touch ID的注册并保留此前候选状态；不能留下永远不会得到ACK的登记。初始异步hit-test失败或撤销时，只有证明该owner从未路由raw，才能记录明确invalidated。精确已完成序列的重复cancel只读取原账本；不会再次向网页发raw事件。

Endpoint布局epoch变化不一定更换Browser InputToken，例如完整atlas编码采样调整。Client因此保留实际发送时的旧token与触控序列，通过同peer、同授权代次的`input.touchRetire`清理旧owner。消息只含原`session/view/instance/document/focus`、`layoutEpoch`、递增`sequence`与`sequenceId`，没有坐标。Endpoint要求旧epoch并预留终止收据；Browser只取消精确仍持有的旧owner，或返回既有完成/失效证据。普通坐标输入继续经过当前epoch与新帧门禁。新触控必须等待旧租约确认，不能因布局更换直接丢掉本地owner。

Browser touch RPC成功只表示受理，不能当网页允许默认手势或physical terminal完成。响应附`touchPending`、`touchSequenceId`与`inputAdmitted`；end/cancel的`touchTerminal`由真实raw `IsTouchSequenceEnd()`决定。双指只抬起一指不进入终止等待。Client的terminal提示只是本地计时依据，不能替代Browser判断。

Browser在可能同步回调的raw派发前登记完整InputToken与sequence，真实terminal canonical ACK和前序ACK全部完成后才记录`processed`。固定Chromium的canonical队列按已ACK队首派发。记录最多64项，pending不被历史项挤掉，终态按更新时间保留；超时后仅精确同owner的迟到canonical可恢复完成，target不匹配不授予成功。查询`input.touchStatus`携带原`session/view/instance/document/focus/sequenceId`，优先匹配记录，不把当前focus换代误作旧序列完成。回复含`ok,pending,state,sequenceId`；state为`pending`、`processed`、`terminal-invalidated`或`terminal-unconfirmed`。网页consumed仍可为processed；未知、无target和超时不能假成功。

Endpoint为终止请求预留有界收据，受理时返回`input.result`的`accepted-pending`，以原`clientSequence`和`touchSequenceId`关联后续终态。每轮普通输入之间最多推进一项到期查询，使用2秒查询预算，不同步sleep等待整段终止过程。64项收据保留未发通知和活动查询；SDK BUSY时原序重试，布局事务优先。明确派发前拒绝标为`rejected`，已受理或传输结果未知不能按未投递重放。

Viewer可发`{type:"input.touchStatus",clientSequence,sequenceId}`查询当前peer/授权代次自己已提交的原请求。Endpoint从保存的原命令取得token，不接受客户端改绑当前身份；此查询不携带坐标，允许跨布局门禁查询。普通输入仍在入队与派发前检查授权和布局。超时收据可重新查询，processed/invalidated直接补发，未知仍明确未知。

Client区分queued、submitted和最终确认，实际DataChannel发送后才开始有限状态查询；队列丢弃显式反馈，终止记录与普通256项输入历史分开保存。仅匹配原身份/sequence的processed或确切退役证明能释放owner。已受理或未知end不重放；清理作为新请求精确绑定旧owner，Browser对正在终止或已经完成的序列只返回原账本，对仍持有的原触点才发canonical cancel。自动清理最多三次，最终仍未知时提供原连接上的“重试确认”和“重试结束”，不使用遮挡整页的默认重连提示，键盘及其他控件仍可用。

只有原target确实失效，或精确证明该owner从未路由raw，才记录`terminal-invalidated`；它表示原owner撤销而非输入执行成功。普通cancel仍等canonical ACK。attempt、授权、文档及focus变化按各自退役证据处理；仅布局epoch变化时保留旧owner清理租约，迟到旧回执不能释放新手势。momentum继续保留既有权限仲裁和有界缓冲，不由回执查询重放。

## 必要验证

`remotekit_client_gesture_probe`直接运行生产packet/state helper、官方TouchDispositionGestureFilter与TouchActionFilter，覆盖start/move消费、tap、放行/拒绝fling、up后pan-x/pan-y/none与pinch限制保持和结束恢复。

`remotekit_scroll_handoff_probe`默认模式直接运行生产ScrollPredictor复现上述相位尾差；`--service-policy`检查生产启动helper保留既有disable项，且显式enable不能覆盖固定服务策略。它不替代真实InputHandlerProxy/DOM路由验收。

2026-11-03最终CPU probe实际运行exit 0，证据`develop/tmp/native-integration-gesture-probe-final.log`。保留none的kFiltered断言，覆盖水平/垂直/双轴真实非零hint及双指零hint；验证单指零hint在生产helper被拒绝且不改变状态、up后的原action保持、pinch允许/拒绝、拒绝与结束后下一auto序列恢复。生产`CompleteClientTouchAck`将terminal收尾与processed回调放在同一操作中；probe用真实官方filter的拒绝/放行fling结果分别验证收尾恰一次/零次、processed均恰一次，拒绝收尾先于processed。此次发现并修复的遗漏回调影响terminal查询，不能用仅观察scroll结束代替此回归。

真实QA用独立页面逐项观察DOM touch/pointer事件、实际scrollTop与scale：touch-action none/pan-x/pan-y/pinch-zoom；touchstart和中途touchmove preventDefault；nested scroller与跨origin OOPIF；普通tap恰一次click；双指加入时权限收紧；同source轨迹正常/途中延迟/late-up的最终累计惯性距离；cancel、target删除、导航、旧layout/旧sequence迟到；raw-only自定义canvas。故障注入覆盖同步ACK、无target、销毁重入、128未ACK上限、终止队列拒绝、terminal查询timeout与新down先终止旧惯性。CPU probe不替代这些真实路由结果，也不等于硬件/移动设备验收。
