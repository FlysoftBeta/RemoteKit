# 网页兼容键盘、视口偏移与触控回执运行回归

2026-11-04。使用隔离的生产 Control、Endpoint Release 与 RemoteKit Browser，单 Viewer、单 Window，通过默认 video 播放真实 QSV H264 串流。两个版本串行运行。正式入口为 [test-keyboard-viewport.mjs](../../tools/test-keyboard-viewport.mjs)，远端页为 [test-keyboard-viewport.html](../../tools/test-keyboard-viewport.html)。

| Viewer | 结果目录 | 测试阶段耗时 | 本地 composition 驱动 | 终止回执恢复 |
| --- | --- | ---: | --- | ---: |
| Chrome 157.0.8103.15 | `develop/tmp/keyboard-touch-compat-qa/157-run2` | 14.0 s | CDP `Input.imeSetComposition` | 3756.8 ms |
| Chrome 89.0.4389.90 | `develop/tmp/keyboard-touch-compat-qa/89-run3` | 14.8 s | 本地合成 CompositionEvent | 3753.9 ms |

两组通过。Chrome 89 的 CDP 缺少 `Input.imeSetComposition`，脚本仅在本地 textarea 使用合成事件回退。远端页面均由真实 Browser 接收 Native IME，两组触控由 Viewer 的可信浏览器事件驱动。视口遮挡与偏移由脚本覆盖 `visualViewport` 的取值并派发事件。实体 Android/iOS 键盘、系统候选窗及原生视口事件顺序仍待设备验收。

## 键盘与视口

- 更多菜单打开“网页兼容性处理”，同时显示“使用平板版网站”与“不自动弹出键盘”两个独立开关。仅切换键盘模式时，平板开关保持关闭，fixture 仅加载一次，文档身份保持。
- 手动模式下，触控使远端 Field C 聚焦，本地 textarea 保持无焦点。点击“显示键盘”获得本地焦点，输入 `manual` 的 composition 后点击“隐藏键盘”。两组均收到一次 `ime_commit`、一次远端 `compositionend`，Field C 最终为 `manual`。
- 隐藏后再触控同一目标，模拟真实布局高度改变和恢复，再触控 Field B，均无新本地焦点事件。恢复自动后，触控 Field A 使本地 textarea 自动聚焦且 `inputMode=text`。触控远端退出按钮后，远端失焦、本地失焦、键盘按钮消失。
- 键盘高度过渡期间持续 composition，暂存提交在新布局生效后交付。每组只提交一次 `during`，最终 Field A 为 `beforeduringafter`。旧输入目标提交被拒，Field B 最终为 `BC`。普通尺寸调整仍显示模糊拉伸快照。
- 在模拟键盘已打开时，shell 固定为 1152×520。依次派发 top/left `0/0 → 8/4 → 16/8 → 0/0`，shell 与内容区同步平移。两组远端 resize 事件计数均保持 3、最新布局 epoch 均保持 13、Viewer resize-waiting 观测计数均保持 6。Viewer 文档滚动保持 `0,0`，焦点与媒体对象保持。

## 触控与回执

- 连续可信触控点击收到远端可信 click。双指序列在同一 `sequenceId` 中为 start、start、end、move、end。远端先观察到两指，第二指抬起后第一指仍活动并可移动，最后一指抬起后接触集合为空。两组都观察到最终 `processed` 回执。
- 可信拖动在两组均使远端 fixture 报告 `scrollY=50`，Viewer 文档始终 `scrollX=0, scrollY=0`。随后可信点击仍可交付。
- 测试只遮蔽 Viewer 生产接收回调里选定终止序号的真实 `processed` 回执，时窗 2250 ms。两组均遮蔽四条收到的 `processed`，包括首条原生回执与前三次查询返回。实际输出四次只读 `input.touchStatus`，首个约在 251 ms，第四次约在 3753–3755 ms，随即收到匹配原 `clientSequence` 和触控 `sequenceId` 的真实 `processed`。该接触在 wire 上只发出一次 start、一次 end，远端只有一次对应 click。上述恢复时间包含脚本施加的回执屏蔽和生产查询退避。
- 回执恢复后继续发送可信触控。每组从开始输入至结束始终同一 peer、两条 open DataChannel、同一 video、srcObject 和两条接收 track。触控未确认重连提示的 DOM 观测次数为零。

## 证据与清理

- 两组的 `keyboard-results.jsonl` 保存每阶段断言读数和回执时序，`fixture-events.jsonl` 保存远端事件。两组均保存 `site-compatibility-menu.png`、`manual-keyboard-hidden.png`、`manual-keyboard-shown.png`、`keyboard-peek.png`、`keyboard-peek-commit.png` 与 `ordinary-resize.png`。
- 157 和 89 成功组的 Browser PID 分别为 49080、48936，各只启动一个 Browser，无替换启动。Control、Endpoint 与 Browser 日志未出现 FATAL、CHECK failed 或 GPU 进程异常退出。ICE 日志有 Hyper-V 候选发送失败，两组的 WebRTC 和媒体断言均通过。
- 所有尝试退出后，测试 Control 与 Browser PID 已消失，按证据目录定位的 Viewer/Endpoint 进程无残留。33901/33902、33911/33912 均无监听。

## 保留的失败尝试

- `157-run1` 通过 IME、偏移和普通 resize，关闭更多菜单后第一次触控未出现在 Viewer wire。测试只等待子菜单卸载，MUI Popover 的退出动画仍覆盖远端内容。修正为等待整个 Popover 退出并在点击前验证内容 canvas 命中。
- `89-run1` 通过普通 resize，Playwright 的 locator 点击调用了 Chrome 89 缺少的 `Element.checkVisibility`。
- `89-run2` 改用真实鼠标坐标后，同一 API 又被 Playwright role 查询调用。改为浏览器原生 DOM 属性读数及真实坐标点击后，`89-run3` 全组通过。
