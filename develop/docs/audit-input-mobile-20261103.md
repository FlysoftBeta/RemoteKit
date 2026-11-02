# 输入、触控与移动键盘只读审阅（2026-11-03）

本文件保留审阅当时的发现与建议。后续实现和验收以[当前状态](../../docs/current-state.zh-CN.md)、[本轮契约](robustness-contract-20261103.md)及[当前问题](open-issues.md)为准，不能把下文历史缺陷自动视为仍未修复。

审阅基线：`4de343c37492d0c5d6435bf6dab1a0a62b5554dc`。仅审阅源码和执行两个不启动服务的 TouchInput 模型轨迹；没有构建、GPU/性能实验、真实移动设备验收，也没有修改产品。已先读 AGENTS.md、当前状态、control-protocol、touch-source-qa。本文不将旧服务端手势实现等同于最新客户端手势目标。

## 结论

现有连续 wheel/原生 scrollbar 修复在源码上接通了 Aura phase 与 held button，不能因该批修复推断触控与移动键盘已经完整。确认了 5 个具体状态/事件缺陷，以及 3 个需要明确补齐的产品契约差距。优先处理旧 composition 跨文档提交、多指历史导致整序列取消、移动键盘焦点反馈，以及终止包失败后的远端残留。

### F1 [P1] 多指 coalesced 历史误判时间倒退，取消合法双指序列

- 位置：`control/client/remote-viewport.tsx:177–190`；`control/client/touch-input.ts:48–53`。
- 触发：两个触点分别收到 coalesced PointerEvent；先处理指 1 的历史 10/20ms，再处理指 2 的历史 11/21ms。这是每个 pointer 分别保留历史的合法排列；顶层事件仍按 20→21ms 前进。
- 坏状态：`TouchInput.active.elapsed` 是整手势共享的 20ms，指 2 的 11ms 历史在 `sample()` 被判时钟倒退；viewport 对仍有触点的 undefined 直接 `cancelTouches()`，整个 pinch/自定义双指触摸被取消。不能把此情况归为网络到达时序错误。
- 证据：直接导入生产 `TouchInput` 的 CPU 模型：两指 start 0/1ms，指 1 move 10/20ms 均成功，指 2 move 11ms 返回 undefined，`invalidClock=1`、active contacts 仍为 `[1,2]`。调用方随后会取消。现有 `control/test/touch-input.test.ts` 只测单指连续历史，没有这种交错。
- 建议：在进入全局有序 wire 时间线前，对跨 pointer 的历史做明确排序/去旧策略。已发出的全局时间水位之前的补充历史可被丢弃，不能把合法 coalesced 历史当成终止整个手势的错误；必须保留该指最新位置。若选择短窗口合并各指采样，需要 root 决定额外延迟预算。
- 测试：上述两指交错；三指；同时间多指；真实 getCoalescedEvents 双指 pinch 和 touch-action:none canvas。断言不产生 cancel、全局 wire elapsed 单调、每个触点末位置正确。

### F2 [P1] 旧 composition 可用新文档 token 提交到新页面

- 位置：`control/client/remote-viewport.tsx:43–44,63–64,92–102,285–315`；Browser 的目标保护见 `browser/webview.cc:454–515,1249–1255,1331–1340`。
- 触发：远端输入框正在 composition，页面导航/重载或执行实例改变；同一个 viewId 的 RemoteViewport 保持挂载，新 layout 已到且 frameReady 恢复，然后客户端旧 IME 发 compositionend。
- 坏状态：layout/document effect 只清理 touches；`composing` 与本地 textarea 没有 owner identity。compositionend 通过本次 render 的 `send` 取得新 surface、新 instance/document/focus token，向新文档发送旧文本。Browser 的旧 token 拒绝无法阻止，因为消息已被客户端重新标成新 token。旧 compositionupdate 也有同样问题。`releaseInput()` 在 blur 时同样用当前 surface 提交 textarea 值。
- 建议：composition start 绑定 attempt/session/view/instance/document/focus 身份；身份失效时只清本地状态与旧 composition，不把旧文本转投当前页面。明确“正常失焦提交”与“导航/断线丢弃”的策略，避免复用无 owner 的 `send()`。heldKeys/mouse 的本地 owner 清理也应在同一生命周期处理，不能只处理 touch。
- 测试：composition 中导航、reload、renderer 恢复、RTC 重连后再收到旧 update/end；新文档 input 应保持空，旧事件不带新 token 发送。正常同文档 blur 的提交策略另测。

### F3 [P1] 最后一个 touchend 本地先清 owner，发送失败后无法再取消远端序列

- 位置：`control/client/touch-input.ts:54–57,35–38`；`control/client/remote-viewport.tsx:188–192`；`control/client/transport.ts:985–1005`；`endpoint/src/service.cpp:1205–1208`。
- 触发：已有 start 抵达远端；最后一指 up 发生时发送队列达到终止事件容量（128 项且没有可淘汰 move），或其他 `sendInput()` 拒绝条件。Endpoint 自己的 256 项队列也可拒绝 end。
- 坏状态：`sample('end')` 在 send 之前删除最后触点并清掉 active；`send(packet)` 返回 false 后 `cancelTouches()` 找不到 owner，什么也不发。远端仍持有旧触点，后续 start 可能与未结束序列冲突。Endpoint 返回 input.result=false 时客户端也只更新 error，没有按 touch sequence 终止/恢复，故服务端队列拒绝形成同类残留。
- 证据：生产 TouchInput CPU 模型确认最后 end 后 `contactIds=[]` 且 `cancel()` 返回 undefined；这不是网络真实复现。终止包容量保留只降低概率，没有形成“受理或显式失效”的保证。
- 建议：保留终止待确认 owner/终止 packet，直至进入可靠有界队列或明确使远端 owner 失效。发送失败必须能以旧身份排一个 cancel，或走已有的受控失焦清理；不要绕过旧 layout 门禁强行重放坐标。Endpoint 的非受理队列拒绝需要可关联序列的恢复动作；不能重放已经受理的异步结果。
- 测试：阻塞 DC bufferedAmount，填满无 move 的队列后 up；单独填满 Endpoint 队列再 end；模拟 input.result 拒绝，随后新手势应正常且远端无旧 active touches。还需覆盖 terminal 排队时换 layout/document，确保旧取消不进入新文档。

### F4 [P1] Enter 缺少字符/换行事件，远端 textarea 无法插入换行

- 位置：`control/client/remote-viewport.tsx:225–237,306–316`；`browser/webview.cc:1267–1293`。
- 触发：不在 composition 时，硬件键盘在远端 textarea/contenteditable 按 Enter。
- 坏状态：Viewer keydown/up 的 `text` 恒为空，Browser 只发 RawKeyDown/KeyUp；本地 textarea 的 `inputType=insertLineBreak`、`data=null` 被 onInput 的真值检查忽略。因此无 Char/commit 换行进入远端。普通可打印字符恰好由 onInput 的 data→ime_commit 补充，不能覆盖 Enter。
- 固定 Chromium 源码旁证：`C:/src/chromium/src/third_party/blink/renderer/core/editing/editor_key_bindings.cc:67–76` 明确 RawKeyDown 对文本插入命令返回 false，并在注释点名 Enter 等待 keypress；不能假设 Browser 会从空 RawKeyDown 自动补 Char。该结论为静态路径确认，尚未跑真实页面。
- 建议：将 Enter 等文本控制字符建立恰一次的完整键盘/编辑事件映射，兼顾网页 keydown preventDefault、单行表单提交与多行换行；仅无条件 ime_commit('\n') 可能绕过网页键盘语义，不应作为未经验证的替代。移动端 beforeinput/input 的 null-data 编辑操作也需要纳入明确模型。
- 测试：textarea 与 contenteditable 的 Enter/Shift+Enter、input 的 Enter submit、keydown preventDefault、composition 确认 Enter。断言 DOM 键盘事件和最终文本/提交次数，避免仅检查 input.result。

### F5 [P2] 移动输入法纯编辑操作被忽略，隐藏 textarea 无法代表远端编辑上下文

- 位置：`control/client/remote-viewport.tsx:217,225–234,306–317`；IME wire 类型见 `endpoint/include/remotekit/core.hpp:120–131`、`browser/webview.cc:1331–1340`。
- 触发：移动输入法通过 InputEvent `deleteContentBackward`（data=null）、`insertReplacementText` 或联想替换编辑。移动键盘可能只提供 Process/Unidentified keydown，不提供可用 Backspace。这里的确定事实是这些 InputEvent 不被编码，真实设备事件排列尚待测。
- 坏状态：null-data 操作直接丢弃；有 data 的替换一律按 ime_commit 追加。每次输入又清空本地 textarea，既没有远端 surrounding text，也没有 replacement range，因此无法准确实现移动输入法删除/改词。硬件 Backspace 可由 RawKeyDown处理，不能作为移动 InputEvent 路径的验证证据。
- 建议：root 确认编辑协议范围：至少区分插入、删除、换行、composition、replacement，并绑定远端 editable identity；若使用 surrounding text，需要限定密码/敏感数据与同步范围。现有 UTF-16 边界校验有效，不能以 byte/codepoint 代替 code unit；不要因添加新操作削弱它。
- 测试：Android/iOS 实机中文/英文键盘、emoji 后退格、自动纠错替换、选中替换、composition cancel；以远端值和 selection 验证，单测假 InputEvent 只能证明编码分支。

## 最新目标的契约差距

### G1 客户端 Pinch/Fling 与浏览器原始 touch passthrough 尚未分工

`remote-viewport.tsx:174–192`、`touch-input.ts` 只编码触点/时间/历史；`browser/webview.cc:801–829,1053–1073,1110–1131` 使用官方 TouchEmulator 生成网页滚动、缩放和 fling。`docs/control-protocol.md` 也明确声明仍由 Chromium 生成 gesture。source clock 的价值是消除速度估计使用到达间隔的问题，但没有把识别或 fling 计算移到 Client。

当前 wire 没有 gesture ownership、允许的 touch-action 反馈、browser raw-touch ACK/result 或 client pinch/fling 序列。`OnTouchProcessed()` 只处理注入完成计数，不向 Client 反馈网页消费/ownership。不能直接将所有 touch 改成客户端 wheel，否则会破坏 touch-action:none、preventDefault、自定义手势和 OOPIF。

交由 root 决定新契约：首触命中/文档身份、何时及由谁确认默认手势 ownership、允许轴/pinch、raw passthrough 与 client-generated gesture 的互斥、取消/跨文档/丢 ACK 的收尾，以及双方时间轴。Client↔Endpoint 数据保持 WebRTC；Control 只负责产品与鉴权/信令，不让 Control 进入逐手势时序。建议用等价源轨迹 + 中途延迟/UP延迟验证最终距离及惯性，再单独验证 raw touch 页面真实事件。现有 QA 的官方注入路径不能当成新 client gesture 路径的证据。

### G2 移动键盘未跟随远端 editable 焦点

`remote-viewport.tsx:155–160` 在任意 canvas pointerdown 都立即 focus 隐藏 textarea；空白、按钮、滚动起点也一样。远端 input 失焦时，没有服务反馈触发本地 textarea.blur，所以键盘不能按远端编辑焦点隐藏。

已有基础不是零：`browser/webview.cc:557–606` 从 TextInputManager 提取 type、active、selection、composition 和 root-DIP caret，`browser/harness.cc:277` 写 shared atlas；但 `endpoint/src/atlas_client.cpp:359–396` 是原生窗口候选位置路径。正式串流 `endpoint/src/service.cpp:1087–1103` 的 Layout 没传 text_input，Viewer Surface/RemoteViewport 未消费这些状态。不能把原生 demo 的 IME 位置支持说成移动 Viewer 键盘已完成。

建议 root 定义 WebRTC 上的远端 editable 状态（需绑定 instance/document/focus 与 focused editable identity，并有 inactive/失效消息）；Client 以此决定显示/隐藏和 inputMode 等属性。移动浏览器的用户激活限制需实机验证：异步收到 focus 反馈后 `.focus()` 不一定允许弹软键盘。需要设计合规的本地用户激活衔接，而不是先对任意触点弹键盘。

### G3 visualViewport 变化缺少固定内容的 resize 事务

`window-frame.tsx:158–181` 在 ResizeObserver/visualViewport resize 时直接读取当前内容 rect 并 onGeometry；`remote-viewport.tsx:259–263` 与 `style.css:164–179` 的 canvas 跟随容器尺寸，frameReady=false 时直接隐藏。没有“软键盘切换中保留已呈现内容尺寸→等待匹配远端布局→原子切换”的状态。若浏览器只改变 visualViewport、layout viewport 不变，measure 又只读容器 rect，未必会把可见高度传给远端。

因此当前代码不满足用户新增的“视觉 viewport resize 等待期间固定内容避免闪烁”。建议把 desired bounds、当前可见 visual bounds、已确认 presentation bounds 分开，保留旧内容的呈现必须同时保持旧坐标输入门禁，不能只把 frameReady 强行设 true。需覆盖键盘动画多次 resize、横竖屏、地址栏展开/收起、异步 layout/IDR 延迟、DPR2，以及显示与隐藏键盘时 caret 可见性。该条是实现差距；没有通过真实手机复现特定闪烁次数。

## 已覆盖且未新增确认缺陷的路径

| 模块 | 本次确认内容及边界 |
|---|---|
| `keys.ts` | DOM buttons→Blink held bits映射，code/key身份与非BMP dom_key；未新增确认映射缺陷。代码表静态审阅不是全键盘布局验收。 |
| wheel / drag | Browser复用Aura MouseWheelPhaseHandler、非零delta建立序列、mouse move按held bits推导button、InputEventRouter路由；没有重跑4de343c真实wheel/drag组。 |
| focus / OOPIF | Browser FocusedWidget针对focused frame；keyboard owner区分不同widget与共享widget frame切换，避免旧frame释放投新frame；pointer维持root router；touch首点async hit-test，检查token/document和root view。 |
| touch ownership / ACK | native/CDP互斥、128 ACK上限、受理前busy、Endpoint同sequence 250ms预算、cancel drain及2秒超时owner lost；accepted async失败不重放。未将完成ACK当网页消费ACK。 |
| touch clock | 固定首down wall→ticks、同序列source/fallback、历史单调/有界、24小时上限；仅上面的多指客户端历史有确认问题。未验证跨机器Control/Endpoint的时钟部署假设。 |
| UTF-16 / composition | core.cpp ValidateInput拒绝非法UTF16和拆代理对selection；Browser ImeSet/Commit选中focused widget。replacement/span缺口已有当前状态记录，本文没有称其完成。 |
| 换文档 / lifecycle | Browser的ReleaseKeyboard/Pointer、RenderFrameDeleted/Changed、ApplyLayout→InvalidateLayoutInput已审阅；客户端composition owner缺口见F2。 |
| `foreground-request.ts` | split阈值、active Window优先与page/file dialog查找；未发现范围内确认缺陷。不是输入焦点或软键盘状态来源。 |
| 断线 | transport关闭会清pendingFocus/input队列与inputFocus；Endpoint ClosePeer停止输入worker、清队列、失效layout并关闭output。未把该观察当成丢失终止包必然已被清理的证据；F3仍需故障注入测试。 |

## 验证与后续范围

本次没有运行新增构建或旧性能组；没有引用旧项目目录。仅执行一次 `node control/node_modules/tsx/dist/cli.mjs -e ...`，导入生产TouchInput确认F1时间交错与F3最后end后owner清空行为。所有运行手感、移动键盘平台差异、真实软键盘动画和原生候选窗口应由后续独立功能测试验证。建议先由root决定G1/G2/G3契约，再修关联模块，避免将现有touch-source历史验收覆盖到新实现。
