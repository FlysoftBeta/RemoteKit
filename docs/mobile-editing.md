# 移动编辑与尺寸过渡

移动设备上，用户点进远端输入框后，本地软键盘需要弹出；键盘弹出会缩小可视区域，进而改变远端页面尺寸；尺寸变化又会触发布局换代。如果把这些因果关系处理成一个混合状态，很容易形成"键盘弹出→resize→失焦→收起→恢复→再弹出"的循环。本文描述把它们拆开后的状态机。

## 四个独立状态

| 状态 | 权威来源 | 能做什么 |
|---|---|---|
| 文档身份 | 非零 generation 布局里的 session/view/instance/document；连接、授权、组件生命周期 | 换文档、view 移除、Tab/Window 失活、锁定时结束旧会话 |
| 远端编辑目标 | 有序的 `input.editable` + 精确的焦点 ACK | active 授予编辑资格；NONE 立即撤销；未知不等于 NONE |
| 键盘意图 | `KeyboardSession`：armed / attached / dismissed | 用户激活、进入新文档、恢复自动策略可授予一次打开；媒体 ready 只执行已有的请求 |
| 本地输入连接 | textarea 的实际 DOM 焦点和 composition 事件 | 保持同一个代理；真实 blur 结束本地输入；窗口 blur 只释放按住的键、指针和触点 |

另有两个观测量：可视区域（visualViewport、innerHeight、ResizeObserver）只更新内容 bounds、遮挡判断和 peek，从不调用 focus/blur；画面与输入坐标由[布局屏障](presentation.md#布局屏障)决定，旧布局和过渡快照永远不授予输入。

## 浏览器的真实行为

- Android Chrome 108 起软键盘默认只缩小 visual viewport；Chrome89 同时缩小 layout viewport。两者都不能把高度变化解释成 DOM blur；visualViewport 的 offset 是光标平移，不是新的页面尺寸。
- Android 的返回键可以收起输入法但保留编辑焦点。候选面板、输入法自己的窗口和 InputConnection 更新都不是远端输入框失焦。Chromium `ImeAdapterImpl.updateState` 把"节点或类型变化时 restartInput"和"show/hide"分开处理；`onWindowFocusChanged` 特意不因输入法语言对话框抢走窗口焦点而隐藏键盘。

## 远端编辑目标

- Browser `UpdateEditableTarget` 给实际的可编辑节点/frame/文档分配一个稳定的非零目标 ID，真实失焦（NONE）时发布 `"0"`。布局或焦点输入租约轮换时，只要节点没变，目标 ID 就不变。IME 事件在 Browser 最终派发前再次核对目标 ID，旧节点迟到的 commit/cancel 不能落到新输入框。
- 共享映射里每个 view 带文本输入状态（类型、标志、选区、组合区间、根 DIP 的光标几何）和目标 ID，不传正文。Endpoint 从权威的最新布局读取编辑状态，而不是从碰巧完成编码的那一帧读取；元数据缺失表示未知，不发送假失焦；像素 stale 不等于编辑目标失效；真实的 inactive 立即发布。编辑状态更新不引起布局换代。
- `input.editable` 有自己单调递增的十进制 revision。

## MobileEditingState

- 独立保存最后确认的文档目录，与媒体布局分开。**所有** `generation:"0", views:[]` 都只是输出屏障，无论是否带 `reconfiguring`：暂停严格输入，保留同文档的本地键盘与合法组合，等待新布局与编辑反馈。只有非零 generation 布局中真的缺失某个 view、文档换代、锁定、断链，才撤销目录。
- 同文档的早到编辑反馈可作为候选保留 1.5 秒，等精确焦点 ACK 和布局赶上。候选只维持键盘 UI，不授予输入，也不改写焦点 token。过期的 revision 即使对应文档已不存在也要消费掉水位。
- 同文档 active A→B：本地代理保持聚焦，但 A 的组合、按住的键和暂存文本立即作废。
- NONE 立即撤销编辑资格；只给键盘外观最多 200ms 的宽限，以容忍站点快速替换节点；宽限期内不向未知目标发文本，也不为未来目标暂存。确认失焦后收起键盘，之后没有用户激活的 active 不能自行重新弹出。

**暂存**：`DeferredEditingInput` 绑定 attempt/session/view/instance/document/target，最多 32 个事件、64KiB UTF-16 文本、3 秒。只有相邻的 `ime_set` 可以互相替换，commit/delete/Enter 保序。只有在新布局、精确焦点 token、同目标的权威编辑状态和新画面屏障全部满足后才一次性发出。早于焦点 ACK 的新目标候选只维持键盘 UI，不获得暂存资格。这种连续性不放宽旧布局的坐标门禁，也不重建 RTC、DataChannel 或 video。

## KeyboardSession

用显式意图替代"从可见性推断"：

```
dismissed → armed     进入新文档、站点策略从手动改为自动、直接用户激活
armed     → attached  有资格的打开命令；请求立即被消费
attached  → dismissed 用户或系统收起、禁用、进入手动策略
attached  → grace     权威 inactive
grace     → attached  宽限内 active 回来
grace     → dismissed 200ms 到期
```

- 一次打开尝试即使被系统拒绝也会被消费；重复渲染不会重试。
- 目标替换、焦点 token 或布局轮换、状态重发都不能重新授权，也不能撤销用户的手动隐藏。媒体恢复本身永远不会重新打开被收起的键盘。
- 显式的手动激活可以覆盖站点的"不自动弹出键盘"策略。
- 窗口 blur 而代理仍聚焦时不结束 IME（输入法自己的窗口可能暂时拿走窗口焦点）；页面真正 hidden 或代理 DOM blur 仍按失焦处理。

**站点策略**：`manualKeyboard` 按 HTTP(S) origin 保存在 Control，与 `tabletUa` 独立。只改键盘策略不刷新页面、不下发 UA。设置了手动时不自动聚焦本地代理；当前 Window 有编辑目标时提供"显示键盘 / 隐藏键盘"悬浮按钮。手动隐藏优先使用本地 compositionend 完成组合；没收到时以同目标最后的组合文本完成一次提交；目标或文档失效则取消。

## resize 事务

1. 本地内容 bounds 开始变化，或者 Transport 即将撤销旧帧时（在清除 ready、RTP、布局信息之前同步通知），抓取最后一个合法 ROI 的快照。
2. 每个 viewport 最多一张快照，最多 4Mi 像素，超过时按比例缩小。不做逐帧拷贝。
3. 过渡原因贯穿整个事务：键盘引起的过渡用顶部锚定、保持比例并裁剪的 peek；其他 resize（分栏拖动、窗口变化、旋转）用最后一帧的模糊拉伸。visualViewport 和 ResizeObserver 先后到达、跨帧到达都不丢失原因。
4. 快照一直保留到新布局真实呈现、且两个轴都与最终期望 DIP 相差不超过 1 DIP。短暂的 settle 只用于等待动画停止，不决定快照寿命。文档/连接/授权边界和组件卸载立即释放。
5. 普通 resize 不显示"正在恢复页面"。连接失败、视频错误、休眠标签页唤醒各有自己的状态显示。
6. 快照永远不授予媒体 ready 或坐标输入资格。

**键盘遮挡判断**（`KeyboardViewport`）：在稳定的无遮挡基线上，2px 以内视为噪声；visual viewport 被遮挡 48px 以上，或粗指针设备的布局高度下降 80px 以上，判为键盘。宽度变化或缩放偏差 ≥0.02 重置为普通 resize。高度完全恢复后 140ms settle。这些判断不授予新的键盘意图。

**外壳**：Viewer 外壳按 visualViewport 的宽高布局，`offsetTop/Left` 只移动外壳。远端 DIP 取 Window 内容区实际大小；可视区域平移（光标平移）不提交 resize、不启动新的输入屏障。曾经把内容矩形与移动中的 visualViewport 求交，导致光标平移期间远端尺寸来回变化。视口提交在约 100ms 内合并；浮层 UI（对话框、文件篮、连接与同步提示）覆盖在工作区上，不占用内容布局，因此打开设置或出现"正在恢复连接"之类的提示不会让远端页面 resize；外壳提示统一叠放在工具栏下方的通知栈里。

## 修复过的循环

两个普通远端标签放在同一 Window，一次可信点击在 6.5 秒内导致 6 次键盘打开、6 次关闭、12 次空布局：隐藏标签 resize 时 Session 输出暂停并发出未标记的空布局，客户端据此清除编辑作用域、blur 代理、viewport 扩大、同一文档回来后又重新 arm。页面本身没有替换节点或脚本聚焦。根因是文档权威没有活过输出代次。上面的 MobileEditingState + KeyboardSession 分离就是针对这一点。此前另一个版本在任何编辑目标变化时重置键盘策略，替换搜索框的站点会把一次 resize 放大成反复的本地 blur/focus。

## 测试

`tests/e2e/test-keyboard-recovery.mjs` 用隔离的 Viewer、Control 和真实 Native H.264，远端两个标签加一个不会主动换代的输入框；由本地 DOM focus/blur 和 inputmode 驱动模拟的系统键盘显隐，并反馈到视口，形成闭环；另模拟候选面板高度变化、光标平移、返回键保留焦点和 IME 窗口焦点变化。157 用 CDP 驱动 Blink 真实组合与提交并注入 Android 风格的 229 按键；89 使用 layout+visual 同时缩小模式和直接文本路径。这是 Android 行为模拟，不包含 Android 系统 InputConnection。
