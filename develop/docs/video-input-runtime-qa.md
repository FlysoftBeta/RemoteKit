# 默认video滚动与焦点回归

2026-11-02，Sol6.1。8423204旧版问题已复现；最终新production Viewer与新Browser的157/89连续输入组均通过。依据为远程网页真实wheel/scroll事件及scrollY/scrollTop，非只计DC sent或input.result。

## 隔离环境

使用host-managed Playwright启动独立157.0.8103.15及89.0.4389.90 headless contexts，无Computer Use或宿主鼠标键盘操作。旧Viewer静态资产直接来自`develop/tmp/RemoteKit-win-x64-streaming-qsv-nvenc-20261102-230531/control/dist/client`；Browser为`C:/src/chromium/src/out/dev/remotekit_browser.exe`，Endpoint为`build/endpoint-package/endpoint/endpoint_service.exe`。运行开始时无CPU构建，由root分配独占GPU窗口。没有跑性能矩阵。

工具为`tools/video-input-qa-server.mts`、`tools/video-input-qa-browser.js`及`tools/video-input-qa-regression.js`。fixture提供超过5000 DIP的真实页面滚动、1300 DIP嵌套overflow内容及原生scrollbar，未用JS模拟滚动。浏览器input采样记录原始DOM命中、transport inputTrace、DC input与后续input.result、每video身份、MediaStream身份、track、peer和inbound-rtp。远程页面上报真实pointer/wheel/focus/scroll事件及scrollY/scrollTop。所有证据在`develop/tmp/video-input-qa`，临时账户/数据库/Profile不提交。

可重复入口：`node control/node_modules/tsx/dist/cli.mjs tools/video-input-qa-server.mts`默认读取当前`control/dist/client`；历史版复现显式设置`VIDEO_INPUT_CLIENT_DIR`为对应历史包的`control/dist/client`，不把临时发布目录固化为工具依赖。然后host-managed Playwright依次运行browser.js、regression.js，调用`host._videoInputQA.launch(157|89)`及`host._videoInputQA.regression(tag)`。运行完先close所有contexts，再请求fixture `/shutdown`并关闭默认host。正式工具不依赖develop中的脚本。

## 8423204实际复现

- 157页面wheel：DOM目标CANVAS，screen 1000,650，真实DC input为x1000/y562/dy-480；inputTrace为sent，epoch8/focus4。远程页面无wheel事件、scrollY仍0。89双窗wheel同样sent，远程无wheel。此证据排除了video挡住原始DOM wheel，但尚未单独定位下游原因。
- 157已focus后拖页面原生滚动条：screen x1433/y165→520，对应远程77→432。DC down/move/up均sent；远程DOM收到pointerdown/up，同坐标，但scrollY仍0。截图中可见真实原生thumb。89首次拖动被Playwright的`Input.setInterceptDrags`版本能力阻断，不算运行通过；新回归工具改用隔离context的CDP鼠标事件。
- 157点击远程输入框时videoId1→2、MediaStream身份1→2；peer数量始终1、connectionId与track不变。导航后videoId5，双窗跨focus时14/15→18/19，仍原connectionId。89跨focus由video3/4→5/6，peer数量仍1。证明发生video/流对象重建，不能称为RTC重连。
- 157双窗实际2个video/2个MediaStream，track id一致，getStats只有1个video inbound-rtp（另1个audio inbound）。这些对象/网络计数不能证明硬件或软件decoder实例数量。

旧组主要截图：`old-157-initial.png`、`old-157-wheel.png`、`old-157-focus.png`、`old-157-scrollbar.png`、`old-157-navigation.png`、`old-157-focus-b.png`、`old-89-split.png`、`old-89-wheel.png`、`old-89-focus-a.png`。完整记录为`metrics/client-metrics.jsonl`与`fixture-events.json`。旧组observer未保留input.result，后续工具已补；不能从sent单独推断服务接受。

旧组自有contexts全部关闭、fixture shutdown成功，session97517退出0，GPU已向root释放。默认host保留作修复后短组入口，结束整个任务时关闭。

## 首轮修复定向组：通过与剩余失败

`fixed-157-*`使用新production dist及加入held-button适配的Browser。导航、点击focus、双窗B/A切换、1100×760 resize全程videoId及MediaStream身份均为1/2，没有重建；peer数量1、connectionId固定。Viewer reload才获得新connectionId，这是主动重连的独立情形。

真实页面原生thumb down→20次held-left move→up使scrollY **0→2739**，全部input.result成功。第一次nested拖动测点未扣根scrollbar15px，实际落在border，结果0不能计通过；已修工具，并在`fixed-157-nested-scrollbar-corrected`以x503/y151→280拖真实nested thumb，远程scrollTop **0→903**，对应pointerup和scroll事件以及成功input.result均已保存。

本组wheel仍失败：导航后未focus、已focus、nested、双窗B/A、resize、Viewer reload后均没有远程wheel或实际滚动。`fixed-157-page-wheel` clientSequence7/browserSequence7、`fixed-157-nested-wheel` sequence12、`fixed-157-cross-b-wheel` sequence70均收到 **ok:true/code0**，不再能归因于焦点拒绝。原始DOM与DC已送达不等于最终网页生效；已把证据交native owner继续定位，没有把本组报成全部通过。

导航门禁定向：暂存新presentation.ready ACK后，两video ready=false；拿导航前旧Surface调用sendInput返回false，trace为`unmatched-or-unpainted-frame`。释放ACK后两个原video恢复ready。该检查证明客户端旧身份/未呈现门禁，没有伪造服务端输入或绕过服务端epoch校验。

`fixed-157-pre-nested-drag.png`目视确认新输入框focus与真实两个Window；`fixed-157-page-scrollbar.png`、`fixed-157-nested-scrollbar-corrected.png`显示滚动后的真实远程内容。该组没有重新测GPU性能。contexts及服务全部关闭，session89788退出0，GPU再次释放供后续修复构建。

## 最终新Browser与production Viewer：89/157连续组通过

Native owner为wheel补入官方Aura phase handler后，使用同一套工具实际运行`final-157-*`、`final-89-*`。Browser仍为本轮`out/dev/remotekit_browser.exe`；客户端为production dist `index-B-SMdBbp.js`。接收端版本分别157.0.8103.15和89.0.4389.90，均DPR1、默认video、实际两个Window。每个动作保留前后截图、inputTrace、DC输入及input.result，远端另存fixture-events。

| 连续行为 | 157实际结果 | 89实际结果 |
| --- | --- | --- |
| 明确blur后不点击，直接wheel360 | 页面0→360，真实wheel/scroll | 页面0→360，真实wheel/scroll |
| 导航重置→输入框focus→wheel480 | 页面0→480 | 页面0→480 |
| 连续3次wheel120 | 480→600→720→840 | 480→600→720→840 |
| 停顿至少650ms后wheel90 | 840→930 | 840→930 |
| 导航重置→嵌套overflow wheel300 | nested0→300，页面0 | nested0→300，页面0 |
| 页面原生thumb down→20 move→up | 页面0→2739 | 页面0→2739 |
| nested原生thumb down→20 move→up | nested0→903，页面0 | nested0→903，页面0 |
| B/A跨窗focus后各wheel240 | B0→240、A0→240 | B240→480、A0→240；B保留前组滚动位置 |
| resize到1100×760→导航→wheel200 | 页面0→200，远程548×672 | 页面0→200，远程548×672 |
| Viewer reload→导航→wheel200 | 页面0→200 | 页面0→200 |

所有wheel都实际到远程DOM，所有上述scroll值都有独立scroll事件或pointerup后scrollTop证据。drag使用CDP鼠标down/连续held-left move/up操作原生thumb，没有直接赋值scrollTop。原生滚动条测点按根scrollbar占宽修正，第二版工具已统一使用修正计算。

两版导航/点击focus/双窗focus/resize全程viewport videoId **1/2**、MediaStream身份 **1/2**、trackId保持不变，PeerConnection数量1；无需要新video恢复的伪重连。主动reload后是新页面JS环境，videoId计数重新起始，connectionId实际改变，不将其误报成跨reload对象保留。双窗仍1个video inbound-rtp、共同track和2个viewport video；没有据此声称只有1个decoder。

两版都执行一次暂存新ACK的导航门禁：新布局的两个video ready=false，导航前旧Surface调用sendInput返回false；释放ACK后原两个video恢复ready。此检查只覆盖客户端门禁；没有发送伪造旧epoch输入来替代服务端协议回归。

本次最终各22个快照（共44个）实际采集默认呈现读数：`backend=video/backendReason=negotiated-video`；MSTP构造0、viewport drawImage0、plane2dDraws0、atlasSnapshotCopies0。所有viewport video均controls=false、disablePictureInPicture=true、disableRemotePlayback=true、tabIndex=-1、draggable=false、muted=true、playsInline=true。这些是本次读数，没有引用旧QA代替。最终快照内input.result没有拒绝；门禁用例由客户端直接拒绝，因此不产生服务端拒绝结果。

Sol已直接打开并目视`final-157-page-wheel-after-idle.png`和`final-89-nested-scrollbar.png`：页首固定状态分别显示page930、nested903，thumb位置与实际内容一致，两窗口独立、布局与工具栏无串窗。另有`final-{157,89}-page-scrollbar.png`、`final-{157,89}-cross-a-wheel.png`、`final-{157,89}-resized-wheel.png`、`final-{157,89}-reconnected-wheel.png`及`final-{157,89}-old-epoch-gate.png`可追溯。

已目视的完整截图路径（另打开了resize及reload后截图，确认1100×760双窗内容与滚动位置正确）：

- `C:/Users/Flysoft/Desktop/remotekit2/develop/tmp/video-input-qa/final-157-page-wheel-after-idle.png`
- `C:/Users/Flysoft/Desktop/remotekit2/develop/tmp/video-input-qa/final-89-nested-scrollbar.png`
- `C:/Users/Flysoft/Desktop/remotekit2/develop/tmp/video-input-qa/final-157-resized-wheel.png`
- `C:/Users/Flysoft/Desktop/remotekit2/develop/tmp/video-input-qa/final-89-reconnected-wheel.png`

这次是短组功能验收，没有重跑性能/长稳定矩阵、硬件输入设备或decoder资源对照。没有覆盖OOPIF wheel latching、触控板惯性、横向wheel或实体鼠标驱动特性。Native构建/CPU检查归实现owner，Control182项/生产build/smoke归client owner，不把它们当成这份远端运行证据。

最终自有157/89 contexts全部关闭、fixture shutdown成功、session70658退出0；默认host page也已关闭，工具返回No open tabs。GPU已向root释放。没有修改产品文件、commit或push。
