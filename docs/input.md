# 客户端输入

输入从 Viewer 的 DOM 事件开始，经可靠有序的 DataChannel 到 Endpoint，再通过本地控制 RPC 交给 Browser，由 Chromium 的输入路由派发到页面。本文讲身份与门禁、键鼠与 IME 语义、触控与客户端手势、Browser 触控序列化以及坐标换算。移动端软键盘与编辑状态见[移动编辑与尺寸过渡](mobile-editing.md)。

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

- 修饰位使用 Blink `WebInputEvent` 位：Shift=1、Ctrl=2、Alt=4、Meta=8，CapsLock=512、NumLock=1024。按住左/中/右键为 64/128/256，后退/前进为 1048576/2097152。down/up 的 `button` 表示变化的那个键，move 的 Blink button 由按住的修饰位推出。直接把 wire 上 move 的 button=0 当作 NoButton 会让原生滚动条拖动被取消。`click_count` 支持 1–3。
- 滚轮先确认焦点，再复用 Aura 的 `MouseWheelPhaseHandler` 建立 begin/update/end 序列，然后走 `InputEventRouter`。phase=None 直接进 router 不会完成首次 hit-test——曾表现为输入回执成功但页面没有 wheel 事件、也不滚动。零 delta 不建立序列。line 模式 ×16 换算为 DIP，page 模式按 viewport 对应轴。
- 键盘事件携带 physical code、Windows 虚拟键、DomCode、DomKey（十进制字符串）、修饰、repeat、text、unmodified_text。`char` 只投字符事件；旧式"down 带 text"也会产生字符事件，二者不能对同一字符同时使用。Enter 的 RawKeyDown/KeyUp 必须跟一个 `\r` 字符事件，否则 textarea 不换行。键盘与 IME 投递到实际聚焦的 widget/frame；指针保留根路由（含 OOPIF 变换）。
- Browser 用 Chromium 的 DomCode 映射补出左右键位和小键盘标志。支持 Keyboard API 的 Viewer 在连接建立或布局变化时发送 `keyboard.layout`。Endpoint 按当前 RTC 授权接收这项 Session 元数据，首帧可交互前即可更新。Browser 在内存中为当前 Session 提供布局表。
- 手写笔沿用鼠标路由，保留指针 ID、压力、倾角、旋转与橡皮状态。Browser 合成释放时沿用被释放笔的身份，压力归零。触点尺寸随坐标换算成 DIP，普通采样和合并历史共用同一字段，Browser 以宽高的一半生成触点半径。

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

`ClientGestures` 在客户端识别 tap、长按、滚动、缩放和 fling 候选，参数：滚动/缩放 slop 8 DIP，tap 时限 500ms，长按 500ms（Chromium 默认 long_press_time），速度历史 100ms，fling 阈值 50、上限 8000 DIP/s。触点集合变化时重置质心历史，增减手指不会凭空产生平移或速度。

每个 touch 包都带 `gestures` 数组（最多 8 个，可为空）：`tapDown/tapCancel/tap/longTap/scrollBegin/scrollUpdate/scrollEnd/pinchBegin/pinchUpdate/pinchEnd/flingStart/flingCancel`。坐标和 delta 为根 DIP，滚动 delta 与速度与手指位移同号，`scale` 为本次倍率，事件时间取所属 touch 的源 elapsed。coalesced 历史先以空候选重放，候选只附在最后一个 raw 包上。pinch 包在 scrollBegin 与 scrollEnd 之间；flingStart 只随最后一根手指的 up 产生，并替代该包的 scrollEnd；双指只抬起一根不是物理终止。

Browser 的仲裁（patch 0010）：

1. 为每个真实 raw touch 创建全局非零 touch ID 和 `GestureEventDataPacket`，先登记再派发（ACK 可能同步回调），空候选包同样参与 ACK 排序。
2. 包先进官方 `TouchDispositionGestureFilter`：逐包按真实 ACK 处理 preventDefault，consumed 或 unknown 都不授予默认手势。首个 down 未被消费不代表后续 move 被许可。
3. 放行的手势再经 `InputRouter` / `TouchActionFilter`（含多触点 action 交集）和 OOPIF 路由。不伪造 auto，不转成 wheel。
4. 受管的 canonical ACK hook 只拦截已登记的全局 ID 与其根 owner；无目标、目标销毁、回调销毁都不会把这些 ACK 交给 Aura 已有的识别器。无关的系统触摸保留官方 ACK 链。
5. TapDown 把首个全局 touch ID 绑定到官方 raw-touch 目标表。严格模式只接受已有绑定，后续 owner 与目标必须一致，不重新 hit-test——否则延迟的输入可能被重定向。
6. 单指 scrollBegin 的方向 hint 不能双 0：官方过滤器把双 0 解释为包装 pinch 的特殊路径。触点数取 Browser 维护的真实 raw 触点数，候选不能谎报。
7. 关闭官方 scroll update 的 ACK 延迟补偿，因为客户端已经算好了 delta。

被否决的方案：把整个触摸转成滚轮（破坏 touch-action、preventDefault、canvas 绘制、滑块、缩放、OOPIF）；直接把手势送进 TouchActionFilter 跳过逐包消费仲裁；为了抢默认滚动而提前取消 raw touch（会终止目标和 ACK 状态，新的 TapDown 会把权限重置为 auto）。只发 raw 也不会产生普通点击，tap 候选是必需的。

**长按**由计时器触发，不随 raw 包到达：单触点、未出 slop 时按住 500ms，客户端发 `{type:"gesture", action:"longPress", sequenceId, sampleElapsedUs, x, y}`，每个序列最多一次。Browser 把它作为 `GestureEventDataPacket::FromTouchTimeout` 送进该序列的 `TouchDispositionGestureFilter`——这正是 Chromium 自己的 GestureProvider 投递定时长按的方式，所以 touchstart 被 preventDefault 或 touch-action 禁止时长按同样被丢弃。长按之后这一序列不再开始滚动、缩放或 fling，最后的 up 带 `longTap` 而不是 tap/tapCancel。迟于 up 到达的长按是空操作，不是错误。

## 统一文本选择

Viewer 的 `client/selection/` 通过 `SelectionTarget` 统一远端页面、本地 input/textarea、文档 shadow root、学习富文本和片段全文的手柄、快捷菜单与命令。手柄使用视觉视口坐标，选择层挂在缩放 body 之外；菜单在锚点上方放不下时翻到下方，并避开软键盘。选区高亮继续由网页或 DOM 绘制。

远端保留 Chromium 的 `ui::TouchSelectionController` 与 Aura selection client，安装不绘图的 `TouchHandleDrawable`；视频里不画手柄。Browser 从根 DIP 的 selection bounds 发布 `input.selection.handles {start,end,insertion}`，每个非空值有 `x/y/lineHeight`。消息绑定 view、`outputGeneration / layoutEpoch`，布局或文档不匹配时隐藏。拖动发送有序的 `selection.extent {which:start|end|insertion,x,y}`，经完整输入身份与坐标门禁到 Browser 的选区/光标移动路径；DPR、atlas mediaScale、letterbox 与外壳缩放只在投影时换算。

raw 触控仍先交给 Chromium `WillHandleTouchEvent`；手柄拥有的序列不投网页，但 ACK 与终止账本正常结束。普通序列的 `OnTouchDown/Up`、滚动与选择状态继续接线。长按已有文本选词；空输入框和插入手柄显示可用的粘贴/全选。快捷菜单由 Browser 的 `RemoteTouchSelectionMenuRunner` 决定可用命令，Viewer 的剪切/复制/粘贴/全选/更多按钮不抢编辑代理焦点。`selection_command` 执行时复核菜单 ID 和能力；`contextMenu` 调用 `RunContextMenu()`。显式 dismiss、切 view、布局失效、断链与 peer 清理都结束远端菜单/controller 状态，见[移动编辑](mobile-editing.md#手动收起与菜单生命周期)。

外壳根为 `user-select:none; -webkit-user-select:none; -webkit-touch-callout:none`，控件不触发选择。内容通过 `data-selectable` opt in：文档页、题目富文本、片段全文；可编辑 input/textarea 由统一注册器标记，远端代理除外。触摸的长按、双击、selectstart 与 contextmenu 由 Viewer 接管，程序化 Selection API / setSelectionRange 仍可用。本地 input 用镜像测量点位；正文用 caret-from-point 和 DOM Range，支持 shadow root。精细指针保留鼠标选区和快捷键，只有触控显示水滴手柄。

本地剪切/复制写 Control 的应用剪贴板，粘贴读取应用缓存；设备同步关闭时仍然工作。显式本地粘贴在已授予读取权限时先同步设备文本，不触发权限提示；异步返回后重新检查节点、内容和选区。远端粘贴复用显式设备读取，再发 Browser 命令，菜单或文档已失效则放弃。物理 Android/iPadOS 的系统插入手柄是否完全被抑制，需要在对应设备上确认。

## 页面上下文菜单

Chromium 的顺序保持不变：`WebContentsImpl::ShowContextMenu` → `WebContentsViewAura::ShowContextMenu` 先交给 `TouchSelectionControllerClientAura::HandleContextMenu`（长按文字且有触控选区时显示上面的快捷菜单），否则交给 `WebContentsViewDelegate`。Browser 通过 `ContentBrowserClient::GetWebContentsViewDelegate` 提供这个 delegate，`WebContentsDelegate` 不拦截上下文菜单。

`RemoteContextMenu`（`browser/context_menu.cc`，进程内唯一）持有当前唯一打开的菜单：菜单 ID、所属 view、按 `WeakDocumentPtr` 绑定的帧与文档，以及从 `ContextMenuParams` 取出的链接、图片地址、选中文字（最多 256 个 UTF-16 单元）、编辑能力和来源（鼠标/触控/键盘）。新菜单取代旧菜单；执行命令、关闭、帧或文档失效、页面切换、view 隐藏或销毁都会关闭它，并且每个菜单恰好调用一次 `NotifyContextMenuClosed`，结束 Blink 的菜单状态。

传输分两步，因为 Browser 到 Endpoint 只有共享元数据这一条推送通道，而菜单含有任意长度的字符串：每 view 元数据只带菜单 ID 和按下点（`SharedAtlasContextMenu`）；Endpoint 看到新 ID 后在 Session 的 RPC 路径上调用 `page.contextMenu` 取详情（不在 dc_services 锁内，后来的 ID 使在途的取数作废），再向已授权的 peer 发 `input.contextMenu`。ID 归零直接发关闭。

命令按状态所有者分流：

- 页面内的操作走输入路径（`context_command`，与键盘相同的身份、焦点与序号门禁）：撤销、重做、剪切、复制、粘贴、全选、复制链接地址、复制图片、复制图片地址、dismiss。编辑命令要求菜单所在帧仍是焦点帧且对应 edit flag 可用；菜单已变化时返回 `conflict`，不执行。地址类复制写入 Browser 剪贴板，每种写入只有一处调用。
- 产品状态的变化走 Control：在新标签页打开链接或图片是 `tab.create {url}`；搜索选中文字是 `tab.create {query}`，`query` 总是用用户当前的搜索引擎生成搜索 URL，即使看起来像域名也不直接导航；返回、前进、重新加载是 `tab.command`。之后 Viewer 发一次 `dismiss` 让 Blink 结束菜单。

Viewer 在按下点显示 MUI 菜单（触控来源下移 24px，避免被手指挡住），分组顺序与 Chrome 一致：链接、图片、可编辑区（撤销/重做 | 剪切/复制/粘贴/全选，不可用的项显示为禁用）、非编辑选区（复制、使用某引擎搜索"前 16 个字符…"）；都不适用时显示返回/前进/重新加载，可用性取自 Viewer 的产品 Tab 状态。Esc、点外部、窗口失焦或选择菜单项关闭菜单，非 Browser 引起的关闭恰好发一次 dismiss；关闭后若编辑代理原本有焦点则还给它，不打断输入法。

## 惯性

惯性完全由客户端计算：

- 曲线：每轴 `x(t) = v0 × (1 − e^(−4.2t)) / 4.2`；持续时间不超过 2 秒，且在速度降到 5 DIP/s 时结束。用累计位置表达，掉帧不影响总距离。
- Browser 放行 flingStart 后截住它，不交给原生 FlingController。`SetClientMomentumActive` 在这一许可点保持原目标真实的 active touch-action，避免 up ACK 后被重置成 auto；每个惯性 GSU 仍经过官方过滤器。
- 后续消息 `{type:"gesture", action:"momentum"|"momentumEnd"|"cancel", sequenceId, sampleElapsedUs, cumulativeX, cumulativeY}`，cumulative 从 up 处的 0 累计。Browser 只把累计差转成 `inertial_phase=Momentum` 的 GSU，不估计速度，不伪造 raw move 或 ACK。许可之前只缓存最新一条；被拒绝则丢弃并结束滚动。
- Browser 另有 2 秒无进展期限和 5 秒总期限；新的 down 先终止旧惯性。客户端 rAF 长时间暂停后旧惯性安全过期，不在恢复时跳一大步，由此产生的 owner-lost 拒绝属于那条过期序列，不阻塞后续 tap，也不触发整个 peer 重连。

把客户端速度交给原生 FlingController 被否决：它会再放大速度，并按 Browser 动画时间推进自己的曲线，仍依赖到达时间。服务进程固定关闭 renderer 的 `ResamplingScrollEvents`：客户端已经算好了直接与惯性两段位移，第二个预测器会在直接→惯性边界改变距离。Chromium157 的预测器在首个 Momentum GSU 时停用重采样但不补偿已预测的差，同一段 220 DIP 的直接位移按帧相位不同会得到 199.4/213.1/226.9 DIP，误差可正可负，无法用固定值补偿。

## Browser 触控序列化

Browser 是唯一掌握 Chromium 原始触控队列、canonical ACK、目标文档和惯性状态的一端，因此由 `TouchController` 串行接管每个 WebView 的 client-v1 触控序列。客户端发送新的 start 时，不等待上一序列的结束证明。

新的 sequenceId 或同文档的新 focus 身份进入时，Browser 先停止旧 owner 的惯性。旧目标仍存活且还有 contacts 时，用旧目标、旧坐标和旧时钟注入一次 canonical raw cancel，然后让新 start 入队。旧 terminal 已经入队、只是在等待 canonical ACK 时，不再注入 cancel；保留其手势仲裁器直到 ACK 完成，让原 tap 正常产生一次 click。旧 ACK 按 owner 代次隔离，不能改变新序列。Chromium 的触控队列保证 raw cancel/end 在新 start 之前处理，客户端不参与等待。

文档、instance 更换或目标销毁时直接丢弃旧 owner，不把旧坐标重新命中到替代目标。raw ACK 超时会停止旧仲裁，下一次 start 接管剩余 contacts。canonical ACK 拦截、TouchDispositionGestureFilter 仲裁和惯性期间的 touch-action 固定仍保留。

layoutEpoch 变化时，旧 move/end 仍按过期坐标拒绝。客户端丢弃旧布局的本地采样，新布局的下一次 start 由 Browser 接管旧 owner；没有坐标外的退役协议。

客户端只负责采样、源时钟、合并历史、gesture candidates、惯性动画，以及 pointercancel、失焦、卸载时的一次全序列 cancel。最后一个 end 入本地发送队列后立即释放本地 owner，不查询状态、不重发 end、不做后台对账，也没有等待结束确认的界面。Endpoint 把触控作为普通有序输入：验证身份、输入序号及布局，派发后返回 `input.result{clientSequence, ok, error?}`；仅 Browser 受理前的 BUSY 可以重试同一命令。

## 坐标

客户端 CSS 坐标 → 内容区内比例 → 编码平面像素 → 页面 viewport DIP：

- `surfacePixelScale(axis) = deviceScaleFactor × mediaScale{X|Y}`。编码平面像素除以它得到 DIP。X/Y 分别使用各自的比例，覆盖 WebRTC 对齐取整造成的轴向差异；同样的比例用于 caret、文件输入锚点和 marker ROI。
- 归一化使用实际显示的内容矩形，排除 letterbox。普通的初始命中在外部时拒绝；已捕获的拖拽在 move/up/cancel 中保留外部的有限坐标而不夹紧到边缘；leave 夹紧。
- Browser 侧宿主尺寸就是内容 DIP，renderer backing 按页面 DPR，root→widget/screen 由 Aura 换算。服务器显示器 DPI 与远端坐标无关。

## 代码位置

- 客户端：`control/client/input/`（`input-pipeline.ts` 焦点与队列、`touch-session.ts` 本地触控视图、`client-gestures.ts`、`coordinates.ts`、`keys.ts`）、`control/client/editing/`
- Endpoint：`endpoint/src/input/`（InputController、序号、校验）、`endpoint/src/session/control_reliability.hpp`（受理前 BUSY 重试）、`protocol/touch_clock.hpp`
- Browser：`browser/control_input.cc`、`control_input_codec.*`、`webview_input.*`、`webview_touch.*`、`client_gesture_*`、`service_input_policy.h`
- 补丁：0010（客户端手势仲裁、惯性期间保持 touch-action）。只接受 `client-v1` 触控；早期基于 TouchEmulator 的服务端手势识别路径及其配套补丁已删除。

## 测试

`tests/e2e/test-touch-selection.mjs` 用隔离的 Viewer、Control 和真实 Native H.264，在 headed Chrome 157 上以 CDP 触控驱动：长按选词与快捷菜单锚点、视频回读中没有 Chromium 手柄、Viewer 水滴手柄、拖动手柄不产生页面 touch 事件、复制→粘贴与全选、tap 与鼠标点击隐藏手柄、`touch-action:none` + preventDefault 阻止长按选择，以及输入法代理跟随远端光标并提交组合。
