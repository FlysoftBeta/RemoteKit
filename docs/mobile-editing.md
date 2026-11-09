# 移动编辑与尺寸过渡

移动编辑分别管理文档身份、远端编辑目标、键盘意图和本地输入连接。键盘与候选窗只遮挡稳定平面，在编辑窗口内缩短页面 viewport；输出纹理、atlas 布局与呈现代次保持稳定。

## 四个独立状态

| 状态 | 权威来源 | 能做什么 |
|---|---|---|
| 文档身份 | 非零 generation 布局里的 session/view/instance/document；连接、授权、组件生命周期 | 换文档、view 移除、Tab/Window 失活、锁定时结束旧会话 |
| 远端编辑目标 | 有序的 `input.editable` + 精确的焦点 ACK | active 授予编辑资格；NONE 立即撤销；未知不等于 NONE |
| 键盘意图 | `KeyboardSession`：armed / attached / dismissed | 点按等待新的 pointer focus，显式键盘按钮直接授予一次打开；开启聚焦时自动打开键盘后，进入新文档与打开这项设置也能授予；媒体 ready 只执行已有的请求 |
| 本地输入连接 | textarea 的实际 DOM 焦点和 composition 事件 | 保持同一个代理；真实 blur 结束本地输入；窗口 blur 只释放按住的键、指针和触点 |

另有两个观测量：可视区域（visualViewport、innerHeight、ResizeObserver）只更新稳定内容 bounds 和遮挡量，从不调用 focus/blur；画面与输入坐标由[布局屏障](presentation.md#布局屏障)决定，旧布局和过渡快照永远不授予输入。

## 浏览器的真实行为

- Android Chrome 108 起软键盘默认只缩小 visual viewport；Chrome89 同时缩小 layout viewport。两者都不能把高度变化解释成 DOM blur；visualViewport 的 offset 是光标平移，不是新的页面尺寸。
- Android 的返回键可以收起输入法但保留编辑焦点。候选面板、输入法自己的窗口和 InputConnection 更新都不是远端输入框失焦。Chromium `ImeAdapterImpl.updateState` 把"节点或类型变化时 restartInput"和"show/hide"分开处理；`onWindowFocusChanged` 特意不因输入法语言对话框抢走窗口焦点而隐藏键盘。

## 远端编辑目标

- Browser `UpdateEditableTarget` 给实际的可编辑节点/frame/文档分配一个稳定的非零目标 ID，真实失焦（NONE）时发布 `"0"`。布局或焦点输入租约轮换时，只要节点没变，目标 ID 就不变。IME 事件在 Browser 最终派发前再次核对目标 ID，旧节点迟到的 commit/cancel 不能落到新输入框。
- 共享映射里每个 view 带文本输入状态（类型、标志、选区、组合区间、根 DIP 的光标几何）和目标 ID，不传正文。Endpoint 从权威的最新布局读取编辑状态，而不是从碰巧完成编码的那一帧读取；元数据缺失表示未知，不发送假失焦；像素 stale 不等于编辑目标失效；真实的 inactive 立即发布。编辑状态更新不引起布局换代。
- `input.editable` 有自己单调递增的十进制 `revision`。`editable.focusSource` 为 `pointer / keyboard / script / other`，`focusRevision` 只在焦点观测变化时推进，光标或组合变化不能伪造点按聚焦。
- Browser 从 `OnFocusChangedInPage` 的 `FocusType` 读取来源，绑定 frame/document/node。补丁 `0020-pointer-refocus-observation` 使 `MouseEventManager::HandleMouseFocus` 点按已聚焦的同一元素时再次发送 `FocusedElementChanged(kMouse)`；脚本聚焦保持 `kScript`。

## MobileEditingState

- 独立保存最后确认的文档目录，与媒体布局分开。**所有** `generation:"0", views:[]` 都只是输出屏障，无论是否带 `reconfiguring`：暂停严格输入，保留同文档的本地键盘与合法组合，等待新布局与编辑反馈。只有非零 generation 布局中真的缺失某个 view、文档换代、锁定、断链，才撤销目录。
- 同文档的早到编辑反馈可作为候选保留 1.5 秒，等精确焦点 ACK 和布局赶上。候选只维持键盘 UI，不授予输入，也不改写焦点 token。过期的 revision 即使对应文档已不存在也要消费掉水位。
- 同文档 active A→B：本地代理保持聚焦，但 A 的组合、按住的键和暂存文本立即作废。
- NONE 立即撤销编辑资格；只给键盘外观最多 200ms 的宽限，以容忍站点快速替换节点；宽限期内不向未知目标发文本，也不为未来目标暂存。确认失焦后收起键盘，之后没有用户激活的 active 不能自行重新弹出。

**暂存**：`DeferredEditingInput` 绑定 attempt/session/view/instance/document/target，最多 32 个事件、64KiB UTF-16 文本、3 秒。只有相邻的 `ime_set` 可以互相替换，commit/delete/Enter 保序。只有在新布局、精确焦点 token、同目标的权威编辑状态和新画面屏障全部满足后才一次性发出。早于焦点 ACK 的新目标候选只维持键盘 UI，不获得暂存资格。这种连续性不放宽旧布局的坐标门禁，也不重建 RTC、DataChannel 或 video。

## 输入法候选窗位置

系统输入法和 Chrome 把候选窗放在本地编辑代理（不可见的 textarea）的光标处，所以代理跟随远端光标：代理聚焦且 `input.editable` 属于当前 surface 的同一文档、带有效光标时，把根 DIP 的光标矩形按 `surfaceDipSize` 与画面元素的布局尺寸（offsetLeft/offsetWidth，不受外壳缩放与过渡变换影响）换算到视口内坐标，放在光标处并把字号设为光标高度（至少 12px），候选窗就出现在远端文字行下方。没有有效光标时退回固定位置；尺寸过渡期间保持上一个位置；定位从不调用 focus/blur。代理保持 1px 宽、opacity 0.01、不接收指针。

## KeyboardSession

用显式意图替代"从可见性推断"：

```
dismissed → armed     点按远端内容；自动打开开启时还有：进入新文档、设置从关改为开
armed     → attached  有资格的打开命令；请求立即被消费
armed     → dismissed 自动打开关闭时，点按后 1500ms 内没有观察到新的 pointer focus
attached  → grace     权威 inactive
grace     → attached  宽限内 active 回来
grace     → dismissed 200ms 到期
```

- 一次打开尝试即使被系统拒绝也会被消费；重复渲染不会重试。
- 目标替换、焦点 token 或布局轮换、状态重发都不能重新授权，也不能撤销用户的手动隐藏。媒体恢复本身永远不会重新打开被收起的键盘。
- 窗口 blur 而代理仍聚焦时不结束 IME（输入法自己的窗口可能暂时拿走窗口焦点）；页面真正 hidden 或代理 DOM blur 仍按失焦处理。

**自动打开设置**：设置 → 输入 →"聚焦输入框时自动打开键盘"（`autoKeyboard`，默认关闭，Control 保存，对所有站点生效）。关闭时点按记录当前 revision 水位，必须在 1500ms 内观察到 active、`focusSource:pointer` 且 `focusRevision` 高于水位；按钮触发的脚本 focus 不满足条件。满足后可以等待媒体就绪。开启时恢复按文档进入自动打开。改这项设置不收起已打开的键盘，关闭只撤销尚未执行的自动意图。当前 Window 有编辑目标时始终提供"显示键盘 / 隐藏键盘"悬浮按钮。手动隐藏优先使用本地 compositionend 完成组合；没收到时以同目标最后的组合文本完成一次提交；目标或文档失效则取消。

**外壳自己的输入框**（开始屏幕搜索、对话框、设置、我的文件、文档跳页、锁屏）统一用 `useAutoFocus`（`client/editing/local-autofocus.ts`）代替 `autoFocus`：仍然在出现时获得焦点，硬件键盘可以直接输入；设置关闭且是粗指针设备时先把 `inputmode` 设为 none 再聚焦，第一次 pointerdown（点按处理之前）或 blur 时恢复原 inputmode，因此点按输入框才弹出软键盘。

## 手动收起与菜单生命周期

用户点击“隐藏键盘”或观测到系统收起时，先结束本地组合，再通过与按键、IME 相同的有序队列发送一次 `editing.dismiss`，携带完整 InputTarget、editable `target` 与 `revision`。Endpoint 校验连接、授权和 sequence，转换成 Browser 的 `input.event`。Browser 核对文档、焦点 token 与当前编辑目标后调用 `WebContents::ClearFocusedElement()`，只 blur 元素，页面仍保有窗口焦点。旧目标或旧文档请求成功但不操作。远端主动失焦、换 view、禁用输入和销毁代理只做本地清理，不发送用户收起命令。

普通文本长按选词；空输入框长按显示可用的粘贴，已有文本还可全选；按住插入手柄不移动时也能打开快捷菜单。“更多”进入 Browser 页面上下文菜单。选区高亮由网页绘制，水滴手柄和按钮由 Viewer 绘制，见[统一文本选择](input.md#统一文本选择)。

命令、点外部、Escape、切 view 或失活都要关闭远端菜单：`selection_command {command:dismiss}` 或 `context_command {command:dismiss}` 走有序输入；过期菜单的 dismiss 成功但不操作。关闭同时清理 selection controller 的拖动/触控状态和页面 context-menu 状态。Endpoint 在 DataChannel 关闭、授权撤销和 peer 清理时发 Session 级 `menus.close` 并释放远端输入。收尾仍校验连接与授权，允许跨媒体屏障送达；旧文档请求不操作新页面。

## resize 事务

1. 本地内容 bounds 开始变化，或者 Transport 即将撤销旧帧时（在清除 ready、RTP、布局信息之前同步通知），抓取最后一个合法 ROI 的快照。
2. 每个 viewport 最多一张快照，最多 4Mi 像素，超过时按比例缩小。不做逐帧拷贝。
3. 过渡原因贯穿整个事务：键盘引起的过渡用顶部锚定、保持比例并裁剪的 peek；其他 resize（分栏拖动、窗口变化、旋转）用最后一帧的模糊拉伸。visualViewport 和 ResizeObserver 先后到达、跨帧到达都不丢失原因。
4. 快照一直保留到新布局真实呈现、且两个轴都与最终期望 DIP 相差不超过 1 DIP。短暂的 settle 只用于等待动画停止，不决定快照寿命。文档/连接/授权边界和组件卸载立即释放。
5. 普通 resize 不显示"正在恢复页面"。连接失败、视频错误、休眠标签页唤醒各有自己的状态显示。
6. 快照永远不授予媒体 ready 或坐标输入资格。

**键盘遮挡判断**（`KeyboardViewport`）：在稳定的无遮挡基线上，2px 以内视为噪声；visual viewport 被遮挡 48px 以上，或粗指针设备的布局高度下降 80px 以上，判为键盘。宽度变化或缩放偏差 ≥0.02 重置为普通 resize。高度完全恢复后 140ms settle。这些判断不授予新的键盘意图。

**外壳**：Viewer 外壳按 visualViewport 的宽高布局，`offsetTop/Left` 只移动外壳。远端 DIP 取 Window 内容区实际大小；可视区域平移（光标平移）不提交 resize、不启动新的输入屏障。曾经把内容矩形与移动中的 visualViewport 求交，导致光标平移期间远端尺寸来回变化。视口提交在约 100ms 内合并；浮层 UI（对话框、文件篮、连接与同步提示）覆盖在工作区上，不占用内容布局，因此打开设置或出现"正在恢复连接"之类的提示不会让远端页面 resize；外壳提示统一叠放在工具栏下方的通知栈里。

**悬浮按钮**：开始、键盘开关、退出全屏（×）、开启声音、停止诊断都是 36px 的圆形图标按钮，由所属组件按需登记（`FloatingActions`），标签放在 tooltip 与隐藏文本里。每个按钮停靠在八个边缘槽位之一（四角、四边中点），可以拖动到它允许的槽位：退出全屏只允许上沿三处，其他按钮四周都可以；拖动时显示可停靠的目标，松手吸附到最近的槽位，同槽位的按钮沿边缘排开。位置只保存在当前页面内存里。需要注意的操作有提示样式（自动播放被拦截时脉冲，收集诊断时红点）。按钮在 pointerdown 时阻止默认行为，不抢走远端编辑代理的焦点，点键盘按钮不会让输入法失焦；没有移动的按下在按钮自己的 click 上执行（键盘激活同样走 click），拖动不会触发；不在 pointerup 上执行，因为那时打开的叠层（例如开始屏幕）会位于手指下方，触摸点按随后的 click 会落到叠层背景上把它立即关掉。

## 验证边界

`test-keyboard-recovery.mjs` 和 `test-keyboard-viewport.mjs` 在真实 H.264 栈中模拟 visual-only 与 layout+visual 键盘模式，核对代次、屏障、页面高度、解码空带与输入坐标；157 用 CDP 驱动组合，89 使用直接文本。系统键盘显隐是几何模拟，不包含 Android InputConnection 或 iPadOS 原生插入手柄。
