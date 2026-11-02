# Client 手势 / Browser passthrough 的 Chromium 157 API 调查

2026-11-03；仅源码调查，无产品修改、构建、GPU实验或运行验收。读了 AGENTS、当前状态、audit-input-mobile-20261103 和现有 webview 触控实现。Chromium 根 `C:/src/chromium/src`，`git rev-parse HEAD` 为固定官方基线 `1aa07b638799e59656559ae6c6649d4b197f555e`（工作树含既有受管补丁）。下列路径均相对该根，不引用旧项目。契约与取舍由 root 决定。

## 核心发现

1. 可以跳过 TouchEmulator，直接 `RenderWidgetHostInputEventRouter::RouteTouchEvent(root, &WebTouchEvent, latency)`，仍保留官方异步 compositor/OOPIF hit test、坐标变换、touch target 固定与 ACK 队列。这个入口本身不运行 GestureProvider。不能再经过 Aura `ui::TouchEvent` 入口，否则 Aura 的 recognizer 仍会生成默认手势。
2. raw ACK 已有公开 `RenderWidgetHost::InputEventObserver::OnInputEventAck`；但它在目标 widget 上通知，root widget observer 不等价于覆盖所有 OOPIF。ACK 结果不是现有注入完成 closure，也不是默认手势所有权令牌。
3. 官方把两个权限过滤拆开：`TouchDispositionGestureFilter` 根据每个 touch 的 consumed ACK 处理 preventDefault；`InputRouterImpl` 内的 `TouchActionFilter` 根据 CSS touch-action 过滤 scroll/pinch。直接注入 gesture 只得到第二层，不能单凭未消费的首 down 绕过第一层。
4. 官方 touchscreen target 从首 TouchStart ID 建 map，**GestureTapDown** 消费 map 并设置 gesture target。只发 ScrollBegin/Update 而遗漏 TapDown，不会正确接续首触的 OOPIF target。
5. 手工 raw Cancel 后再启动默认手势不是官方“转所有权”API。官方实际在首个获准 ScrollUpdate 时发 `kTouchScrollStarted`，Blink 据此产生 UA-action pointer 取消，raw touch 管线仍由原队列管理。
6. FlingStart 接受客户端算好的速度，但 Browser FlingController 仍按 Browser animation clock 演进惯性。若要求惯性曲线/进度全部由 Client 算，应该发送 source-timed momentum ScrollUpdate/End，且不能再同时发 FlingStart；这是产品契约选择，源码并无“Client fling模式”开关。

## raw touch：准确入口与 ACK

| API / 源码 | 行为与边界 |
|---|---|
| `components/input/render_widget_host_input_event_router.h:147`, `.cc:1081` `RouteTouchEvent` | components/input 导出类的 public 方法，非 `content/public` embedder API。通过 `event_targeter_->FindTargetAndDispatch`。参数坐标是 root DIP，screen 坐标仍需单独正确填写。 |
| 同 `.cc:954` `FindTouchEventTarget`、`:971` `DispatchTouchEvent` | 首 down TOUCH-source Viz hit test，可能异步查询 renderer；active contacts 时锁定 target。存首 down 的 `unique_touch_event_id → WeakPtr<RenderWidgetHostViewInput>`，变换所有触点到 target widget 后 `ProcessTouchEvent`。End/Cancel按变化触点数释放 raw target。 |
| `content/browser/renderer_host/render_widget_host_view_base.cc:842` `ProcessTouchEvent` | 调用 `PreProcessTouchEvent` 后转 `RenderInputRouter::ForwardTouchEventWithLatencyInfo`；此处不识别手势。不能直接用它代替 router，否则丢首点OOPIF路由。 |
| `ui/events/base_event_utils.h:21` `ui::GetNextTouchEventId()` | 每个 WebTouchEvent 分配全局非零 uint32 ID。wire sequence ID、pointer ID 和此 ID 是不同概念；Browser建立有界映射，不能把客户端递增 sequence直接冒充全局 ID。 |
| `content/public/browser/render_widget_host.h:243–275` | `InputEventObserver::OnInputEventAck(host, source, state, event)` + Add/RemoveInputEventObserver；WebTouchEvent携带global ID。可在不改Chromium情况下读到目标widget正常ACK。观察者必须在自身销毁前移除，并处理 widget销毁。 |
| `components/input/render_input_router.cc:604` | ACK先 `NotifyObserversOfInputEventAcks`，再 `GetInputEventRouter()->ProcessAckedTouchEvent`。所以 observer 可在官方后续root处理前读权限/入filter；注意callback同步重入与对象销毁。 |
| `components/input/render_widget_host_input_event_router.cc:185–226` | 全局 TouchEventAckQueue按顺序归并ACK，再尝试现有TouchEmulator HandleTouchEventAck，未处理则root `ProcessAckedTouchEvent`。无target时 `.cc:1027` 直接入该队列 `kNoConsumerExists`，不会经过目标widget observer。 |

`kConsumed` 映射event_consumed=true；其余状态不能统一说“网页允许默认动作”。应保留 source/state，并使用 `input::InputEventResultStateIsSetBlocking(state)` 与官方filter一致，不把 kUnknown/timeout/target loss授予所有权。`kNoConsumerExists`可以是队列过滤无handler，亦可根本无target；必须同时验证有效target及文档。

直接raw routing不调用 `TouchEmulatorImpl::HandleEmulatedTouchEvent`（该方法 `.cc:307` 才创建 MotionEventWeb→FilteredGestureProvider）。现TouchEmulator已启用/有active emulated stream时，ACK仍会被它尝试处理；进入新模式前必须停用且drain原序列，保持CDP/native互斥。不能仅删除EnsureTouchEmulator而保留active旧emulator。

Aura ACK后备会经 `RenderWidgetHostViewAura::ProcessAckedTouchEvent` (`.cc:1422`)→WindowEventDispatcher→GestureRecognizerImpl::AckTouchEvent；没有Aura输入包时通常被filter当spurious ACK忽略（`touch_disposition_gesture_filter.cc:247`），不会凭空识别手势。但不能与相同consumer的真实native/Aura流混用：未知ID落入已有provider时可触发ACK顺序 DCHECK。生产bridge适合在router的canonical ACK点明确拦截自己拥有的raw流，不依赖spurious路径。

## touch-action 的真实来源与获取限制

- `content/public/browser/render_widget_host.h:301` 的 `GetAllowedTouchAction()`是公开API；impl `.cc:2129`只返回 `input_router()->AllowedTouchAction()`，即TouchActionFilter的optional `allowed_touch_action_`，不是完整的effective compositor+main状态。
- `components/input/input_router.h:93–96`另有 `AllowedTouchAction()` / `ActiveTouchAction()`；可从目标view `GetViewRenderInputRouter()->input_router()`获取，属于components/internal边界。active在gesture期间（包括抬手后fling）保留。
- `components/input/input_router_impl.cc:373` `SetTouchActionFromMain`更新主线程action并释放deferred gesture；`:397` `OnSetCompositorAllowedTouchAction`更新compositor约束；`:816`说明touch-action在touch ACK内传回，确保处理ACK时已有值，compositor ACK调用该setter。
- `components/input/touch_action_filter.h:80`有 `compositor_allowed_touch_action()`，但该filter是InputRouterImpl私有成员，无生产public getter/observer。`RenderInputRouter::OnSetCompositorAllowedTouchAction` (`render_input_router.h:123`)目前是空实现，未转给embedder。
- `TouchActionFilter::OnSetTouchAction` (`.cc:303`)与`OnSetCompositorAllowedTouchAction` (`:370`)都对多指取交集；不能仅缓存第一指的结果。主线程allowed与compositorallowed也不可冒充同一种精度。
- `.cc:86`过滤时优先active，否则compositor。GSB在unknown且可能被禁止时会defer；pinch禁止、方向轴过滤、pan-left/right/up/down及internal cursor/stylus bits均有专门逻辑。不要把规范简化为`panX/panY/pinch=true`后绕过官方filter。
- OOPIF：权限属于实际raw target widget，不是主框架DOM `elementFromPoint`，不是root host的GetAllowedTouchAction。跨进程祖先/局部root的有效值必须以实际renderer/compositor报告为准；保留官方router的pinch目标选择。

若只需“反馈当前可知allowed/active optional，unknown时passthrough”，公开observer +现内部router API可实现原型，不必立即改Chromium。若契约要求“逐sequence、逐start ACK时明确返回effective compositor/main action及known/provenance，覆盖no-target/canonical synthetic ACK”，现有公开API不够：建议受管小补丁在canonical ACK层提供observer/hook，并在InputRouter暴露包含allowed/active/compositor与known状态的只读snapshot。hook需在`OnTouchEventAck`重置allowed之前取值；不应通过ForceSetTouchActionAuto伪造权限。具体补丁归属由root决定。

## gesture 注入、target与ID

入口 `RenderWidgetHostInputEventRouter::RouteGestureEvent` (`.h:140`, `.cc:877`)；设置`SourceDevice=kTouchscreen`，不要借用touchpad/wheel。后者会走不同target、wheel cancelability与pinch逻辑。

`third_party/blink/public/common/input/web_gesture_event.h:30–48`：

- `primary_unique_touch_event_id` = 首个touch的全局ID，整物理序列保持。
- `unique_touch_event_id` = 从TouchDispositionGestureFilter释放该gesture的touch ID；通常是当前source touch，不是永远首ID。
- `is_source_touch_event_set_blocking`来自ACK；`primary_pointer_type=kTouch`。
- position为root DIP；ScrollBegin hints、pointer_count、delta units、ScrollUpdate deltas/inertial_phase、PinchUpdate scale等均应按结构定义赋值；scale是本次更新倍率。不能误把DPR/编码采样比例当delta单位。

关键路由：

- router `.cc:1616` `FindTouchscreenGestureEventTarget`：pinch先送root候选；nonzero ID的常规手势留给target map；ID=0的Android特殊手势才重新hit-test。不能用0规避绑定。
- `.cc:1806–1861`：`is_gesture_start`仅为GestureTapDown，其ID必须对应首TouchStart map；它确定`touchscreen_gesture_target_`并消费map。GSB不做这一步。
- `.cc:1678` `DispatchTouchscreenGestureEvent`：pinch是否允许取实际child target的`ActiveTouchAction`；允许时可提升到root或embedded pinch zoom target，并补包围ScrollBegin/End。绕过router直接发root pinch会破坏此约束。
- `.cc:1925`：Tap、LongTap、DoubleTap、TwoFingerTap、ScrollEnd、FlingStart结束gesture target。不要在Client momentum还要继续时提前发ScrollEnd。
- `.cc:949` `OnHandledTouchStartOrFirstTouchMove(id)`是已有public内部入口，可清首触map。纯passthrough且永远不发送TapDown时，未消费首触map没有自动按TouchEnd清除的正常路径；bridge必须明确处理此清理，避免每个raw自定义手势留下map记录（view销毁会清理）。

仅raw passthrough不会生成浏览器默认tap/click；普通网页点击仍需完整tap gesture语义，或者保留一个明确不与Client默认重叠的官方tap路径。不能只实现scroll/pinch/fling便声称触摸全覆盖。

## preventDefault：可直接复用的官方仲裁器

`ui/events/gesture_detection/touch_disposition_gesture_filter.h`导出`TouchDispositionGestureFilter`与client接口，独立于GestureProvider，可由embedder持有，不要求用Browser重新计算速度：

1. 每个raw touch分配ID，创建 `GestureEventDataPacket::FromTouch(MotionEventWeb(event))` (`gesture_event_data_packet.h:69`)。
2. 将Client算好的该source touch候选gesture转为`ui::GestureEventData`后`packet.Push()`；即使没有gesture也必须提交一个空packet。
3. **在发raw前**调用`OnGesturePacket(packet)`，否则同步ACK可能先到。随后RouteTouchEvent。
4. 每个canonical ACK调用`OnTouchEventAck(id, state==kConsumed, InputEventResultStateIsSetBlocking(state))`。
5. `ForwardGestureEvent` callback中用`ui::CreateWebGestureEventFromGestureEventData`，经RouteGestureEvent注入；InputRouter继续做touch-action过滤。

官方参照 `FilteredGestureProvider::OnTouchEvent/OnTouchEventAck` (`filtered_gesture_provider.cc:53–93`)和`TouchEmulatorImpl::HandleTouchEventAck` (`touch_emulator_impl.cc:345`)。这允许Client识别/算delta/算速度，Browser只做权限与序列仲裁；不要求网络ACK返回Client后才计算候选gesture。应有有界未ACK包预算、同步ACK重入保护与WeakPtr销毁守卫。

`TouchDispositionGestureFilter` `.cc:91–137,596–623`明确：任一touch start消费会禁止相关GSB/pinch；ScrollUpdate和PinchUpdate也按当前touch ACK过滤；fling依赖先前scroll update是否获准；它自动补TapCancel/FlingCancel/ScrollEnd。首down未消费不能推出first move、第二指down也未消费。旁路这层会破坏preventDefault。

此组件可直接在当前Browser GN代码中使用，属于ui导出组件，不必复制算法或修改tracked Chromium。需要检查Browser目标GN依赖，但本次没有构建验证。`DisableScrollUpdateCompensation()`可禁用其基于ACK延迟补偿的delta修改；若目标要求Client算出的source轨迹在到达停顿下保持距离，不应不知情地保留额外补偿。

## 取消与默认接管

官方默认滚动接管路径：获准GSB→首个获准GSU→`InputRouterImpl::SendGestureEventWithoutQueueing` (`.cc:233–245`)调用`PrependTouchScrollNotification(primaryID)`；`passthrough_touch_event_queue.cc:124`把后续move改nonblocking并发`kTouchScrollStarted`。`WidgetBaseInputHandler::HandleTouchEvent` (`widget_base_input_handler.cc:203`)把它变为`CreatePointerCausesUaActionEvent`。这是应优先保留的页面pointercancel/UA action路径。

不建议预先手工raw Cancel来“争取”默认所有权。Cancel意味着物理touch序列终止：router释放touch target；TouchDisposition filter会进行序列收尾；InputRouter ACK会减少active touches并ReportAndResetTouchAction。更细地说，TouchActionFilter有意保留`active_touch_action_`供fling，因此不是“Cancel必然清掉全部权限”；但若Cancel后再发TapDown，`num_active<=0`时会SetTouchAction(auto)（touch_action_filter.cc:243–252），可能破坏原限制。没有公开的“取消DOM触点但继续原权限/gesture序列”通用转换API。

正常Client接管候选应仍发送物理raw生命周期，由官方touch-scroll通知夺走页面pointer流；在布局/文档/target失效、用户cancel或队列失败时才整体取消并收尾。不允许在touch-action:none或消费后强行用wheel/新auto gesture补滚。

## fling 的两个不同含义

- Client只算初速度：最后up候选包可含FlingStart（速度DIP/s；source touch ID保持）；官方FlingController接管，`components/input/fling_controller.cc:130–178`。它在Browser收到事件后按BeginFrame/animation时钟推进；起始时间戳影响曲线，但不能宣称整段惯性由Client计算，亦不能宣称完全不受late delivery影响。
- Client算完整惯性：不发FlingStart，而保留GSB/GSU序列，物理up后继续Client计算的`ScrollUpdate(inertial_phase=kMomentum)`，结束才ScrollEnd(momentum)。官方FlingController自身也是这样生成progress事件（`.cc:303–338`），但该做法经root router保留target至终点的独立外部注入仍需运行验证；物理触点已结束，不能伪造额外raw moves。失焦/新down/断线必须结束原momentum，且避免官方fling与Client momentum双运行。

`TouchDispositionGestureFilter`的外部API只接受基于touch的packet或timeout packet；不能随意给每个惯性tick造同ID“touch ACK”。用它仲裁up前/最后up的fling许可，再由bridge持有已获准gesture target/active权限进行momentum更新，是另一个需要root定义的状态。不得把这条设计推断称为已验证官方组合。

## 可供root考虑的最小状态序列

1. Idle→RawPending：首down绑定产品instance/document/focus/layout，创建Browser全局touch ID、候选包（TapDown）、路由raw。Client可本地计算完整候选轨迹并有界缓冲，无需用包到达间隔计算速度。
2. RawPending→RawPassthrough 或 DefaultEligible：按每个touch canonical ACK及known权限过滤；unknown/consumed保持页面raw。允许的候选继续官方TapDown→TapCancel/GSB→GSU与pinch；不是一次首ACK永久授予ownership。
3. DefaultActive：由获准首GSU触发官方TouchScrollStarted；后续触点与候选仍逐包有序、第二指down继续权限交集。限制轴交给官方filter最终裁决。
4. End：物理up结算raw与候选；正常tap走Tap；无惯性走GSE；Client初速度→GFS由Browser惯性，或经明确契约进入ClientMomentum。两者互斥。
5. Cancel/Invalidated：旧identity内raw Cancel及必要gesture收尾；等待drain或明确失效后回Idle。销毁目标、no-target、超时、不完整ACK、queue拒绝不得转投新文档或新hit target。

必须保守passthrough/拒绝默认接管：touch-action unknown/none、blocking start/first-move或新增指被消费、真实OOPIFtarget未定/改变、Chrome native/CDP触摸冲突、页面自定义多指处理、布局/导航身份不稳定。对于已消费首start，不应发送会重新hit-test的TapDown（可同时清target-map）；否则会用fallback误接管。

## 推荐最小受管补丁边界与验证

原型raw+gesture+公开ACK observer可只改RemoteKit；但要做可长期维护的完整bridge，canonical ACK hook（覆盖无target、阻止raw ACK进入无关Aura provider、反馈最终target identity）与effective touch-action snapshot是有价值的小补丁。Gesture识别、速度/轨迹计算应留Client；现有InputRouter/TouchActionFilter/TouchDispositionGestureFilter复用，不引入第二套CSS规则或wheel模拟。此为调查建议，不替root确定协议。

本次未验证：纯raw custom页面/OOPIF实际ACK与pointercancel、source timestamp late-up下Browser fling差异、ClientMomentum抬手后官方router保target与scroll bubbling，以及重入销毁/拒绝故障注入。后续必要功能组应覆盖touch-action:none/pan-x/pan-y/pinch-zoom、start/move preventDefault、nested scroll/OOPIF、第二指权限收紧、tap点击、up延迟/中途暂停、cancel/导航/target loss。不得把现TouchEmulator历史验收覆盖到新路径。

## 给实现代理的补充：构造接口、线程与寿命

- 所有上述Browser routing、widget观察、权限snapshot及filter操作应在Browser UI sequence执行；现WebView本来在该sequence。Endpoint worker/DC接收不得直接调用这些Chromium对象，继续post到Browser UI。renderer compositor/main通过Mojo返回ACK，不代表embedder callback在这些renderer线程执行。
- `content::MotionEventWeb`的header为`content/browser/renderer_host/input/motion_event_web.h`，构造时复制WebTouchEvent，无外部event引用寿命问题；`GestureEventDataPacket::FromTouch`亦复制取出的属性。packet.Push复制GestureEventData并强制替换unique ID为packet ID；其primary ID应先通过`GestureEventDetails::set_primary_unique_touch_event_id(first_id)`填写。
- `ui::GestureEventDetails(EventType, float x, float y, ScrollGranularity=kScrollByPrecisePixel)`可构造GSB hint、GSU delta和FlingStart velocity（按各type的构造switch）；Pinch用`set_scale()`，TapDown用`set_tap_down_count()`。`set_touch_points()`、rails等按实际候选填写。
- `ui::GestureEventData`公开构造参数是`details, motion_event_id, primary_tool_type, time, x,y,raw_x,raw_y, touch_point_count,bounding_box,flags,unique_id`，声明`ui/events/gesture_detection/gesture_event_data.h:24`。这里motion_event_id是触点/运动ID，不能与全局touch event ID混用。转换header为`ui/events/blink/blink_event_util.h:45`。
- `TouchDispositionGestureFilter`不是refcounted，由bridge拥有；client是raw pointer，必须比filter活得久，销毁或跨identity断开时先Shutdown，避免callback重入。filter按ACK放行时可以同步callback再触发更多ACK，因此用bridge WeakPtr并避免callback后解引用裸this/target。
- router由WebContents委托对象持有；view/target/widget可能在input dispatch中同步销毁。使用现有WebView WeakPtr、target的GetInputWeakPtr、frame DocumentToken及产品身份共同验证；WeakPtr仅保活校验，不授权跨文档复用。InputEventObserver跨所有local-root widget注册与解除，不能只观察root。canonical router hook可避免让embedder自己猜target的生命周期。
- official停止API：`input::InputRouter::StopFling()` (`input_router.h:104`)→`InputRouterImpl::StopFling`→GestureEventQueue。正常输入序列也可发送`GestureFlingCancel`经router；若最后fling target为OOPIF，应保留官方router的last_fling_start_target路由，不能只Stop root的input_router。
- 官方curve可复用在C++：`ui::FlingCurve(velocity,start_timestamp)`公开`ComputeScrollOffset`/`ComputeScrollDeltaAtTime`；`ui::WebGestureCurveImpl::CreateFromDefaultPlatformCurve(...)`与`Advance(double, velocity,delta)`接受PPI/viewport/mobile curve选择。它们不是Viewer JS API，也不自动运行在Client；若要Client完全使用同一curve，需要移植或明确WASM构建边界，本调查未评估该实现成本。
- FlingController取`fling_booster_.GetVelocityForFlingStart`，可能boost Client给定速度；start_time优先最后GSU source timestamp而不一定up timestamp（`fling_controller.cc:402–424`）；平台curve还读取scheduler的PPI/viewport（`:461`）。因此“只传Client velocity”仍有Browser物理策略参与。服务现固定PPI补丁不会把它变成纯Client fling。
