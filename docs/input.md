# 客户端输入

输入从 Viewer 的 DOM 事件开始，经可靠有序的 DataChannel 到 Endpoint，再通过本地控制 RPC 交给 Browser，由 Chromium 的输入路由派发到页面。本文讲身份与门禁、键鼠与 IME 语义、触控与客户端手势、触控终止账本以及坐标换算。移动端软键盘与编辑状态见[移动编辑与尺寸过渡](mobile-editing.md)。

## 设计意图

- **延迟的输入不能落到别的对象上。** 每个输入都绑定完整身份；页面换了文档、换了执行实例、焦点换了、布局换了，旧输入就失效，而不是被改投到新对象。
- **页面的权利由 Chromium 裁决。** 常见触摸手势（tap、滚动、缩放、惯性）在客户端计算，但网页的 `touch-action`、`preventDefault`、OOPIF 路由仍由 Browser 内的官方过滤器决定，客户端不能绕过。
- **"已受理"不等于"已完成"。** 入队、实际发送、Browser 受理、页面处理是不同阶段，各有各的证据。
- **不确定时不重放。** 一个可能已经产生点击的 end 不会被重发。

## 身份与门禁

输入身份由几层组成：

| 层 | 含义 | 变化时机 |
|---|---|---|
| session / view | 租户与逻辑 WebView | view 关闭 |
| instance | WebContents 执行实例 | discard/unload/restore、崩溃重建 |
| document | 主文档 | 跨文档导航 |
| focus | 输入租约 | 焦点变化、生命周期转换、布局重排 |
| outputGeneration / layoutEpoch | 当前画面布局 | resize、编码尺寸变化、可见集合变化 |

DataChannel 上的 `input` 消息携带全部身份、连接内 `sequence` 和事件本体。各层逐级检查：

1. **客户端**：只有该平面已 ready（见[呈现](presentation.md#帧与-rtp-匹配)）、焦点租约已确认时才发送坐标类输入。
2. **Endpoint**：拒绝旧 peer、旧授权代次、连接内重复或倒退的序号；要求输入授权、当前 layoutEpoch 匹配、坐标类事件要求该 view 在此 epoch 下 ready。
3. **Browser**：在最终派发前再检查 instance/document/focus/outputGeneration；IME 事件另外检查编辑目标（见[移动编辑](mobile-editing.md)）。

**序号分两层**：连接内的 client sequence 由客户端分配，Endpoint 校验单调；Endpoint 再分配 Session 生命周期内持续递增的 browser sequence。重新登录或重连时客户端序号可以从头开始，而 Browser 的每 view 高水位不会倒退。回执里两个序号都带上。

**焦点租约**：首次交互前客户端发 `focus{focusRequestId, 页面完整身份, layoutEpoch}`，输入在本地排队，直到收到匹配这个请求 ID 的 ACK。即使 token 没变的成功 ACK 也足以放行；A→B→A 不能复用第一次 A 请求迟到的 ACK。否定 ACK 只撤销对应请求的乐观状态（曾经否定 ACK 只清了 pending，之后的输入就永远跳过焦点获取）。本地 textarea 已经聚焦时 DOM 不会再触发 focus 事件，所以远端目标变化时必须显式发远端焦点请求。首次点击的焦点 ACK 实测约 27ms。

**悬停例外**：不按键的鼠标 move/leave 可以发给未聚焦的可见 live view（悬停不改变焦点），但仍校验全部身份与序号。拖拽、down/up、滚轮、键盘、IME、触控都要求焦点。

**BUSY 重试**：Browser 在解析目标或收尾期间对所有输入返回 `ok:false, code:busy`（受理之前）。Endpoint 以同一个 browser sequence 和 token 串行重试，间隔 5ms，最多 50 次 / 250ms；peer 或 epoch 变化立即停止。受理之后的异步失败从不重放。旧实现的 RPC 包装把所有 `ok:false` 都转成异常，导致 BUSY 重试逻辑在真实服务里根本走不到，这是"传输失败"与"应用拒绝"必须分开表示的直接原因。

**队列**：Endpoint 普通队列上限 256，只合并相邻、同 peer/授权/view 的鼠标 move；键盘、IME、touch start/end/cancel 严格保序。输入与媒体在不同线程，输入 RPC 不会阻塞媒体循环。客户端队列为终止事件保留容量：普通 112 / 总计 128，DataChannel `bufferedAmount` 超过 256KiB 暂停发送、低于 64KiB 恢复，实际发送时再查一次身份。

## 鼠标、滚轮、键盘

- 修饰位使用 Blink `WebInputEvent` 位：Shift=1、Ctrl=2、Alt=4、Meta=8；按住左/中/右键 64/128/256，后退/前进 1048576/2097152。down/up 的 `button` 表示变化的那个键；move 的 Blink button 由按住的修饰位推出。直接把 wire 上 move 的 button=0 当作 NoButton 会让原生滚动条拖动被取消。`click_count` 支持 1–3。
- 滚轮先确认焦点，再复用 Aura 的 `MouseWheelPhaseHandler` 建立 begin/update/end 序列，然后走 `InputEventRouter`。phase=None 直接进 router 不会完成首次 hit-test——曾表现为输入回执成功但页面没有 wheel 事件、也不滚动。零 delta 不建立序列。line 模式 ×16 换算为 DIP，page 模式按 viewport 对应轴。
- 键盘事件携带 physical code、Windows 虚拟键、DomCode、DomKey（十进制字符串）、修饰、repeat、text、unmodified_text。`char` 只投字符事件；旧式"down 带 text"也会产生字符事件，二者不能对同一字符同时使用。Enter 的 RawKeyDown/KeyUp 必须跟一个 `\r` 字符事件，否则 textarea 不换行。键盘与 IME 投递到实际聚焦的 widget/frame；指针保留根路由（含 OOPIF 变换）。

## IME 与文本

wire 上分为 `ime_set`（组合文本 + 选区）、`ime_commit`（文本）、`ime_cancel`、`ime_finish`。选区按 UTF-16 code unit 计算，不能切开代理对。

客户端用一个隐藏的 textarea 作为本地输入代理，`EditingInput` 把它的事件翻译成上述操作：

- 组合属于一个编辑 owner。owner 被替换时，旧组合的 compositionend 和随后的文本被隔离，不能落到新目标。曾经迟到的 compositionend 被贴上新文档的 token，Browser 无法识别它是旧的。
- 有 `beforeinput` 时以它为准，`input` 是 Chrome89 的后备。去重窗口：组合相关的普通插入 100ms，beforeinput 与物理键等价 1000ms。
- `deleteContentBackward/Forward`、`insertLineBreak/Paragraph` 转成 Backspace/Delete/Enter 的完整按键对。
- 依赖上下文的替换（自动更正、历史编辑、不支持的删除类型）明确报告为不支持：空代理不知道远端文本和范围，把替换文本当追加会破坏编辑语义。
- 重置 textarea 的 value 或选区不是可靠的 Android InputConnection 取消边界：可能折叠 Blink 的组合范围却不触发 compositionend 或 restartInput，之后旧的 commit 看起来像普通插入，所以保留隔离逻辑。

完整的 replacement range/span、逐字符候选几何和周边文本同步尚未实现。

## 触控：采样与时钟

触控要保留客户端的采样轨迹，不受可靠 DataChannel 的到达抖动影响。历史上服务端按到达时间喂给 Chromium 的速度跟踪：一次 40ms 的 move 间隙会重置历史，80ms 的迟到 up 可能抹掉 fling 速度，同一次拖动可能完全没有惯性或惯性过大，而坐标增量本身是完整的。

- 每个物理序列固定 `sequenceId`、`clockMode`（`source` 或 `arrival-fallback`）和源采样 elapsed（微秒）；source 模式还携带整条手势固定的 `startServerWallUs`。时间原点在序列中途不能改变。
- source 模式：首个 down 的 `PointerEvent.timeStamp` 归一化到客户端 performance 单调轴，用与 Endpoint 的 `clock.ping` 校准（offset 减不确定度，保守取值）得到服务端 wall 起点。Browser 只在首个 down 配对一次 NowWall/NowTicks，之后严格按 elapsed 推进。首 down 允许最多 5 秒年龄、1ms 未来误差；elapsed 非负、单调、最多 24 小时。校准缺失或过期时整条手势用 arrival-fallback，不中途切换。
- 每包只带变化的触点，最多 16 个。move 可附最多 32 条 `getCoalescedEvents` 历史（每批变化触点累计不超过 64），历史不跨 start/end/cancel、手势或目标身份合并。其他指针早于已发出的全局时间水位的历史样本会被丢弃，但不取消整个序列。
- 失焦、lostpointercapture、pointercancel、卸载时发送一次整序列 cancel，而不是每个剩余触点一个 cancel。
- Browser 中 source elapsed 与 native 事件时间是两个域：前者保留用于历史顺序、up 时刻与惯性期限；后者约束为非递减且不晚于当前 TimeTicks。arrival-fallback 首包排队较久、后包较快时，"首包到达 + elapsed"会落到未来：只夹紧 native 时间，不能从夹紧后的时间反推 elapsed，也不改变位移。

## 客户端手势

`ClientGestures` 在客户端识别 tap、滚动、缩放和 fling 候选，参数：滚动/缩放 slop 8 DIP，tap 时限 500ms，速度历史 100ms，fling 阈值 50、上限 8000 DIP/s。触点集合变化时重置质心历史，增减手指不会凭空产生平移或速度。

每个 touch 包都带 `gestures` 数组（最多 8 个，可为空）：`tapDown/tapCancel/tap/scrollBegin/scrollUpdate/scrollEnd/pinchBegin/pinchUpdate/pinchEnd/flingStart/flingCancel`。坐标和 delta 为根 DIP，滚动 delta 与速度与手指位移同号，`scale` 为本次倍率，事件时间取所属 touch 的源 elapsed。coalesced 历史先以空候选重放，候选只附在最后一个 raw 包上。pinch 包在 scrollBegin 与 scrollEnd 之间；flingStart 只随最后一根手指的 up 产生，并替代该包的 scrollEnd；双指只抬起一根不是物理终止。

Browser 的仲裁（patch 0010）：

1. 为每个真实 raw touch 创建全局非零 touch ID 和 `GestureEventDataPacket`，先登记再派发（ACK 可能同步回调），空候选包同样参与 ACK 排序。
2. 包先进官方 `TouchDispositionGestureFilter`：逐包按真实 ACK 处理 preventDefault，consumed 或 unknown 都不授予默认手势。首个 down 未被消费不代表后续 move 被许可。
3. 放行的手势再经 `InputRouter` / `TouchActionFilter`（含多触点 action 交集）和 OOPIF 路由。不伪造 auto，不转成 wheel。
4. 受管的 canonical ACK hook 只拦截已登记的全局 ID 与其根 owner；无目标、目标销毁、回调销毁都不会把这些 ACK 交给 Aura 已有的识别器。无关的系统触摸保留官方 ACK 链。
5. TapDown 把首个全局 touch ID 绑定到官方 raw-touch 目标表。严格模式只接受已有绑定，后续 owner 与目标必须一致，不重新 hit-test——否则延迟的输入可能被重定向。
6. 单指 scrollBegin 的方向 hint 不能双 0：官方过滤器把双 0 解释为包装 pinch 的特殊路径。触点数取 Browser 维护的真实 raw 触点数，候选不能谎报。
7. 关闭官方 scroll update 的 ACK 延迟补偿，因为客户端已经算好了 delta。

被否决的方案：把整个触摸转成滚轮（破坏 touch-action、preventDefault、canvas 绘制、滑块、缩放、OOPIF）；直接把手势送进 TouchActionFilter 跳过逐包消费仲裁；为了抢默认滚动而提前取消 raw touch（会终止目标和 ACK 状态，新的 TapDown 会把权限重置为 auto）。只发 raw 也不会产生普通点击，tap 候选是必需的。

## 惯性

惯性完全由客户端计算：

- 曲线：每轴 `x(t) = v0 × (1 − e^(−4.2t)) / 4.2`；持续时间不超过 2 秒，且在速度降到 5 DIP/s 时结束。用累计位置表达，掉帧不影响总距离。
- Browser 放行 flingStart 后截住它，不交给原生 FlingController。`SetClientMomentumActive` 在这一许可点保持原目标真实的 active touch-action，避免 up ACK 后被重置成 auto；每个惯性 GSU 仍经过官方过滤器。
- 后续消息 `{type:"gesture", action:"momentum"|"momentumEnd"|"cancel", sequenceId, sampleElapsedUs, cumulativeX, cumulativeY}`，cumulative 从 up 处的 0 累计。Browser 只把累计差转成 `inertial_phase=Momentum` 的 GSU，不估计速度，不伪造 raw move 或 ACK。许可之前只缓存最新一条；被拒绝则丢弃并结束滚动。
- Browser 另有 2 秒无进展期限和 5 秒总期限；新的 down 先终止旧惯性。客户端 rAF 长时间暂停后旧惯性安全过期，不在恢复时跳一大步，由此产生的 owner-lost 拒绝属于那条过期序列，不阻塞后续 tap，也不触发整个 peer 重连。

把客户端速度交给原生 FlingController 被否决：它会再放大速度，并按 Browser 动画时间推进自己的曲线，仍依赖到达时间。服务进程固定关闭 renderer 的 `ResamplingScrollEvents`：客户端已经算好了直接与惯性两段位移，第二个预测器会在直接→惯性边界改变距离。Chromium157 的预测器在首个 Momentum GSU 时停用重采样但不补偿已预测的差，同一段 220 DIP 的直接位移按帧相位不同会得到 199.4/213.1/226.9 DIP，误差可正可负，无法用固定值补偿。

## 触控终止账本

问题：一条触摸序列的结束需要确认——确认之前，新触摸不能开始，否则两条序列会在页面里交错；但 end 的回执可能丢失，而一个已经产生点击的 end 不能重发。

**Browser**（`client_touch_retirement.h`）：64 项账本，以完整原始 InputToken + 触摸 sequenceId 为键。可能同步回调的 raw 派发之前先登记。只有真实终止的 canonical ACK 及其之前的 ACK 全部完成，才记为 `processed`；网页消费了事件仍是 processed。终态由真实 raw 的 `IsTouchSequenceEnd()` 决定，不由客户端的 end 动作决定。状态：`pending`、`processed`、`terminal-invalidated`（原 owner 确实失效，或精确证明从未路由过 raw）、`terminal-unconfirmed`。未知、无目标、超时都不能升级为 processed。pending 项不会被历史挤出，已完成项按完成时间保留（曾经已完成项按插入顺序被立即淘汰）。

**Endpoint**：为终止请求预留有界收据（64 项，与普通输入历史分开），受理时回 `input.result{touchState:"accepted-pending", clientSequence, touchSequenceId}`。输入线程在两次普通输入之间最多推进一项到期的状态查询（2 秒查询预算），不同步睡眠等待。SDK BUSY 时关键通知按原身份重试，布局事务优先。

**客户端**：区分 queued、submitted、最终确认。实际 DataChannel 发送之后才开始查询：`input.touchStatus{clientSequence, sequenceId}`，间隔 250/500/1000/2000ms。Endpoint 从保存的原命令取 token，不接受客户端改绑身份；该查询不带坐标，可以跨布局门禁。只有匹配原身份/序号的 processed 或精确的失效证据才释放 owner；迟到的旧回执不能释放新手势。

**旧布局退役**：layoutEpoch 变化不一定更换 Browser InputToken（例如整张 atlas 的编码采样调整）。客户端保留实际发送时的旧 token，通过同 peer、同授权代次的 `input.touchRetire{原 session/view/instance/document/focus, 旧 layoutEpoch, 新 sequence, sequenceId}` 清理旧 owner，不带坐标。Browser 只取消仍精确持有的旧 owner，或返回已有的完成/失效证据；对已在终止或已完成的序列只读账本，不再注入第二个 raw cancel。新触摸必须等旧租约确认。

自动清理最多三次；仍未知时在原连接上提供"重试确认 / 重试结束"，键盘和其他控件仍可用，不弹整页重连。

## 坐标

客户端 CSS 坐标 → 内容区内比例 → 编码平面像素 → 页面 viewport DIP：

- `surfacePixelScale(axis) = deviceScaleFactor × mediaScale{X|Y}`。编码平面像素除以它得到 DIP。X/Y 分别使用各自的比例，覆盖 WebRTC 对齐取整造成的轴向差异；同样的比例用于 caret、文件输入锚点和 marker ROI。
- 归一化使用实际显示的内容矩形，排除 letterbox。普通的初始命中在外部时拒绝；已捕获的拖拽在 move/up/cancel 中保留外部的有限坐标而不夹紧到边缘；leave 夹紧。
- Browser 侧宿主尺寸就是内容 DIP，renderer backing 按页面 DPR，root→widget/screen 由 Aura 换算。服务器显示器 DPI 与远端坐标无关。

## 代码位置

- 客户端：`control/client/input/`（`input-pipeline.ts` 焦点与队列、`touch-session.ts` 触控 owner 与终止账本、`client-gestures.ts`、`coordinates.ts`、`keys.ts`）、`control/client/editing/`
- Endpoint：`endpoint/src/input/`（InputController、序号、校验）、`endpoint/src/session/control_reliability.hpp`（终止收据）、`protocol/touch_clock.hpp`
- Browser：`browser/control_input.cc`、`control_input_codec.*`、`webview_input.*`、`webview_touch.*`、`client_gesture_*`、`client_touch_retirement.h`、`service_input_policy.h`
- 补丁：0010（客户端手势仲裁、惯性期间保持 touch-action）。只接受 `client-v1` 触控；早期基于 TouchEmulator 的服务端手势识别路径及其配套补丁已删除。
