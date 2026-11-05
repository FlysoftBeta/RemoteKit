# 搜索输入框软键盘反复开合

2026-11-05。用户报告 Google 搜索结果页的二次搜索框、哔哩哔哩顶部搜索框偶发反复弹出软键盘，补充为第一次点开就触发。本轮先复现，再修改键盘判定和尺寸过渡。本文区分真实网站、可控远端页面、模拟客户端键盘尺寸与实体设备。

## 基线证据

当前生产 Control、隔离 Endpoint/Browser、Chrome 157 Viewer，默认 video/QSV H.264。可控远端搜索页在 resize 时撤销旧编辑节点，130ms 后聚焦替代节点。Viewer 以实际本地 textarea focusin/focusout 驱动模拟 visualViewport 820↔520；没有实体软键盘。

一次可信触控之后，5 次远端输入节点替换使 native target 从 1 变到 6，本地出现 4 次 focusin、3 次 focusout、7 次模拟尺寸变化，布局 epoch 从 5 变到 23。peer、两条 DataChannel、video、srcObject 与接收 track 保持。原始证据保存在 `develop/tmp/keyboard-search-fixture-baseline/` 的 `trace.json`、`fixture-events.jsonl`、`keyboard-results.jsonl`。

这证明当前产品能把页面编辑节点变化放大为开合循环；尚不能据此认定两个真实网站的起始事件完全相同。

真实站点对照：哔哩哔哩首页顶栏搜索接受可信触控，得到 target=1、一次本地聚焦和一次模拟收缩，观察 6 秒没有循环（`develop/tmp/keyboard-search-bili-tap/`）。Google 搜索结果页面能够显示，但可信触控和鼠标对照未取得 editable；一组触控收到明确拒绝 `Renderer widget required`（`develop/tmp/keyboard-search-google-tap3/trace.json`）。未以脚本强制网页焦点绕过该路径，因此 Google 的现场键盘症状仍未实测。

## 已核对的责任边界

- Browser `WebView::UpdateEditableTarget` 遇到 NONE、失效 widget/frame 或不可用文档立即撤销 target。恢复后的同一节点也可得到新 target。它用于最后派发时拒绝旧输入，不应为了键盘外观而弱化。
- Browser 将编辑状态写入 `latest_layout`，独立于编码帧与 GPU ready；Endpoint 读取当前池的权威状态。普通 reconfigure 会停止旧媒体循环、清理待发状态，再发送临时空布局，不直接构造假失焦。
- Client 旧逻辑对任意 target 变化主动 blur 本地代理，并重置自动弹出与手动隐藏记录。直接 A→B 与 A→NONE→B 都可能产生新的本地开合。
- 同文档 B 的 editable 消息早于 focus ACK 时，旧 Client 只在 target 相同的情况下保留 A；不同 target 的候选阶段表现为暂时无编辑目标。
- 旧尺寸模型把粗指针环境任意 1px 高度下降视为键盘，以变化前一帧作恢复基线；恢复计数又直接触发本地 blur。visualViewport 与 ResizeObserver 的不同事件顺序也会丢失一次性的 peek 判定。

## 本轮实现契约

键盘意图与严格 IME owner 分开。目标换代、布局、focus token、状态重发均不得重新授权自动弹出；已经隐藏的键盘由真实用户交互或显式切换自动策略重新授权。文档/连接/锁定边界立即撤销。

同文档 active A→B 保留本地代理焦点，但旧 composition、held keys、暂存文本不能转交 B。NONE 立即撤销编辑资格；仅本地键盘外观允许最多 200ms 的失焦确认，以容纳页面快速替换节点。持续 NONE 收起键盘，后续无用户交互的 active 不自行重开。候选状态可以维持 UI 连续性，不能绕过 focus ACK、新布局和新帧输入门禁。

尺寸模型维护稳定基线和持续的过渡类别。视口平移不改变远端 DIP；缩放、旋转、宽度变化不作为键盘关闭事件。几何观测不直接 blur 或完成 IME。键盘仍使用顶部同比 peek，普通布局仍使用最后帧模糊拉伸，快照不授予输入资格。

## 实现与定向审查

Client修改限于键盘意图、编辑状态、IME隔离与尺寸过渡六个模块，Native的严格target语义不变。新target早于focus ACK时仅提供UI候选，原target可在布局屏障中有界暂存，新target不能提前发输入。候选超时触发重评估。视口模型使用稳定高度基线、48px可视遮挡/80px布局下降阈值、2px噪音容差及140ms恢复确认，区分过渡提示与实际内容尺寸，几何观察不调用blur。

局部Astra审查发现持续NONE收尾丢失桌面硬键盘代理，已补回仅fine pointer、无观测键盘、原代理仍聚焦时的一次同文档恢复；真实方向键/Tab回归见下表。文档换代不会因关闭旧代理而提前消费新许可；粗指针环境不把DOM focus当作系统键盘已打开，可信显示按钮可补救系统拒绝自动显示的情况。

定向35项、TypeScript检查、Control生产构建和启动smoke通过，最终客户端bundle为`index-C1ca75zq.js`。构建记录为`develop/tmp/keyboard-search-build/control-build-final.log`。原生源码未改，没有为本轮重复Native构建或性能矩阵。

## 修后真实串流与移动IME模拟

| 用例 | 证据目录（均在develop/tmp） | 结果 |
| --- | --- | --- |
| Chrome157正式键盘/触控与搜索替换 | `keyboard-search-fix-157` | 首次搜索触控后target 6→NONE→7，仅一次本地focus、一次520px模拟收缩、一次远端resize和节点替换；NONE期间合成beforeinput探针零输入包；新目标继续输入及持续失焦收起通过 |
| Chrome89同组 | `keyboard-search-fix-89` | 搜索替换、单次开合、替换后输入、手动设置、尺寸屏障与触控恢复通过；89本地候选事件仍为合成，远端均为Native |
| 移动IME旧包对照 | `keyboard-search-mobile-ime-baseline2` | 157 mobile、820×1040、DPR约2、coarse与单触点；首次触控后以229对包围两次真实CDP候选更新，交错VV/innerHeight；target 1→6，第一观察窗新增3次focusout/2次focusin及5次非预设高度往返 |
| 移动IME修后同条件 | `keyboard-search-mobile-ime-fix2` | 7步交错几何中一次原生目标替换，零追加本地焦点事件；旧commit零包，新目标真实接收“新”及compositionend；模拟Back不失去DOM焦点、不自开，可信show重开，真实远端blur后普通Latin输入通过 |
| 桌面fine pointer | `keyboard-search-fine-pointer-fix3` | Blink原生媒体特征模拟读回fine=true/coarse=false/touch=0；持续NONE后无需再次点击，ArrowDown/Tab均成为远端trusted keydown |
| Bili修后对照 | `keyboard-search-bili-fix` | 顶栏搜索可信触控processed、一次focus/收缩，6秒无循环 |
| Google修后对照 | `keyboard-search-google-fix` | 仍被`Renderer widget required`拒绝，没有editable；未核对真实站点软键盘症状 |

以上功能组检查同peer、DataChannel、video、srcObject与接收track保持。Chrome157的候选由CDP驱动真实Blink，229键事件另外注入；视口尺寸、候选栏变化及系统Back均为模拟，没有运行Android系统InputConnection或实体键盘。不能把这些结果写成UD710/Brave现场已修复验收。

Native在远端resize/blur时结束原节点已显示的“你好”，fixture主动把原value复制到替代节点；这与Viewer迟到旧commit被拒绝是两件事。新目标光标在0，唯一的新commit“新”产生“新你好”。157与89正式组均实际命中NONE窗口探针，分别为revision 38/36，零文本包发出。

正式工具为[键盘/触控/搜索替换回归](../../tools/test-keyboard-viewport.mjs)和[移动IME专项](../../tools/test-mobile-ime.mjs)，共享[远端fixture](../../tools/test-keyboard-viewport.html)。移动专项接受可选Control server路径，可直接核对成品中的Control及Native；不依赖develop中的代码。

前两次fine-pointer尝试及初次移动模拟失败保留在同前缀目录：移动检查首次用严格相等比较DPR而实际读回约2.00000006；后一次预期字符串没有考虑clone后光标位置为0。测试修正只依据实际几何/选区，不放宽产品输入断言。

## Android行为核对与保留边界

独立subagent核对当前Chromium、89源码与官方Android/Chrome文档，见[移动IME行为调查](mobile-ime-behavior-20261105.md)。Android节点换代可restartInput而不hide，Back可保留DOM焦点；CDP不包含实际Android输入连接。不能用清空textarea或移动选区伪造可靠的旧IME结束边界，旧候选隔离保留到compositionend、新compositionstart或真实blur。未收到end且后续只有direct commit的实体序列仍未知，不能为该假设放行旧文本。

实体设备、用户真实IME版本与Google输入阻碍仍未验收。交付包与上传结果另见本轮交付记录。
