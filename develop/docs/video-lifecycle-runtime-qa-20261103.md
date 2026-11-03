# Video 生命周期定向运行验收（2026-11-03）

当批源码产物在Chrome89/DPR1与Chromium157/DPR2普通Viewer中完成Google HelloWorld→Wikipedia导航、真实表单输入、popup独立Window创建/关闭、并排、1100/390/1440 resize与idle。正常组分别142.072秒、62.942秒；RTC及原有video/stream/track身份保持，默认video、MSTP0、canvas draw0。自有Native日志无FATAL/CHECK、GPU退出或Browser重启。真实整个文档hidden未能由host headless后台tab产生，因此不宣称真实后台/恢复通过。

用户最初canvas-2d/track-processor截图的原始原因仍未知。独立能力缺失fixture仅验证本次诊断能准确呈现真实生产回退；不冒充原截图复现。Native Scheduler重复接纳有独立实际日志证据，本组不以无崩溃运行证明所有时序已覆盖。

## 范围与隔离

- 使用 `develop/tmp/video-lifecycle-qa` 新数据目录、独立生产 Node Control→Endpoint→Browser；明确记录当批产物绝对路径、hash、版本及进程身份。采用33593/33594端口。
- 使用 browser-use 技能与 host-managed Playwright 隔离客户端89/DPR1、157/DPR2；不使用Computer Use、用户Profile或用户正在运行的包。
- 等待root明确GO后才启动浏览器及服务；不与CPU构建或其他GPU实验混跑。只结束本任务创建的context及服务，不按进程名清理。
- 各版本至少60秒，正常导航Google HelloWorld→Wikipedia HelloWorld；再使用自有轻量静态表单页面检查输入、独立Window开关、并排、resize及idle。不是历史性能复验，不故意触发Native崩溃或负CHECK。

## 判定与证据计划

1. 导航、resize保持RTC、video元素、stream、track身份；Window新增/删除允许相应plane增删，现有RTC保持。默认video，MSTP创建0，稳态canvas draw不增长；有界resize freeze单独记录。
2. 所有阶段记录实际 `document.visibilityState`、transport rendering诊断、布局ACK、每plane bounds/ready/retries及输入资格。外站实际画面截图与Control最终URL分别留证。
3. 通过host浏览器正常后台tab或受支持CDP生命周期取得真正hidden，只有实际 `visibilityState=hidden` 才算后台覆盖。不得覆盖visibility属性或派发虚假事件冒充后台。若host能力无法取得真实hidden，明确保留限制，transport定向测试作为独立证据。
4. 真实hidden超过旧watchdog预算后返回；记录visible、新有效帧及真实输入，并验证没有意外canvas回退。若正常后台操作不改变visibility，停止这一路，不扩大到用户UI操作。
5. 独立157能力缺失fixture在页面启动前移除rVFC能力，通过生产正常协商触发 `video-capability-unavailable`，验证实际统计叠层的Video回退原因、2D原因及可见状态。该fixture与正常默认video组隔离；如果正常能力路径不能安全呈现，不强行注入协议，仅报告诊断呈现与能力限制。
6. 自有Browser/Endpoint日志检查FATAL/CHECK/GPU进程退出及Browser重启，记录Browser PID/incarnation与启动次数。结束后关闭自有context及服务，并释放host默认浏览器避免后续发布Profile锁。

## 实际产物和身份

Root在当批构建及生产Control build/smoke完成后明确GO。采用生产Node `control/dist/server.mjs`、Endpoint `build/endpoint-package/endpoint/endpoint_service.exe`、Browser `C:/src/chromium/src/out/dev/remotekit_browser.exe`，新数据在`develop/tmp/video-lifecycle-qa/run`。

Browser exe SHA256仍为`dc6351322e7b934d2c4d7e172d158cce06b6157227787e360f259fa3c712b501`；0012修复实际位于 `C:/src/chromium/src/out/dev/components_viz_service.dll`，SHA256 **e78fcd73384f23a07508df57b6e9be01a8dcfdef647423f753131793259e75ae**。`run/loaded-viz-module.json`确认实际Browser加载该绝对路径；与`develop/tmp/video-lifecycle-build-manifest.json`对应。完整hash在`run/artifact-hashes.json`。

实际当批Control bundle为`index-CjfQEW6_.js`，hash见`run/control-asset-hash.json`；独立fallback组实际叠层出现新字段，排除仅检查源码而运行旧前端。

主组Browser PID **22068**、incarnation **42e1c813e7e4c5439bf97e3c5da6cf08**，两客户端顺序验收期间保持。Endpoint日志只有一次browser launched；`process-start.json`、`process-157.json`、`process-final.json`保存身份与GPU子进程信息。自有`browser.log`和`server.stderr.log`无FATAL、Check failed、GPU process exited。

## 正常组结果

|检查|89.0.4389.90 / DPR1|157.0.8103.15 / DPR2|
|---|---|---|
|Google→Wikipedia|URL与video身份保持，Google实景可读；原Wikipedia截图空白，独立短补验取得可读内容，详见失败记录|实际两外站实景可读，导航保持原媒体身份|
|实际远端输入|同一未提交表单依次出现visible-89、resume-89|同一未提交表单依次出现visible-157、resume-157|
|popup独立Window|鼠标点击window.open，两个独立Window并排；更多→关闭此窗口恢复原Window|相同通过|
|1100→390→1440|390当前plane ready，旧plane bounds0/current=false/ready=false/retries0，超过30秒仍video；恢复双窗、关闭子窗通过|相同布局转换通过；当前plane ready，隐藏plane retries0，恢复双窗、关闭子窗通过|
|原媒体身份|connectionId640eedc0-5aee-48c4-9574-c9b895db9e44，peerCount1、video2/stream3/track保持|connectionId5641a6c5-a6be-40e6-b4e2-bf115b50909d，peerCount1、video2/stream3/track保持|
|绘制|MSTP0、draw0，resize freeze2|MSTP0、draw0，resize freeze5|
|实际运行|142.071955秒|62.941700秒|

## 可见状态与独立fallback

两版本均实际创建第二个host-managed tab并bringToFront，原Viewer的`document.visibilityState`仍为visible。没有覆盖visibility属性、派发虚假事件或切用户窗口。`89-real-visibility`、`157-real-visibility`明确supported=false。因此真实运行只覆盖**窄屏隐藏的保留plane**及其返回后的新帧与真实输入；没有整个Viewer真实hidden恢复覆盖。transport确定性hidden/watchdog测试属于独立层次，不能填充此缺口。

正常157组结束后，通过更多→设置→显示连接统计开启实际叠层，然后只在该隔离context启动前移除rVFC能力并reload。生产正常协商触发`video-capability-unavailable`；无media协议注入或private fallback调用。实际canvas-2d、track-processor、visible，MSTP1、2D draw2；叠层显示 **Video 回退：Video 能力不可用**、**2D 原因：单平面 / 等待平面**，没有误报GL初始化失败。`run/157-capability-fallback.png`已目视检查；`157-capability-fallback-separate-fixture`保存实际诊断与文本。此主动能力fixture与正常组MSTP0/draw0分开。

## 失败尝试与判据修正

1. 首次popup点击错误坐标590，未点到按钮，没有popup事件、Window数仍1。随后按钮中心440实际鼠标点击成功；未调用onclick代替输入。保留`89-popup-attempt.png`。
2. 旧通用`qa.ready`错误要求隐藏plane也ready，390时超时。真实当前plane ready、旧plane bounds0/current=false/retries0且仍video。后续改用既有`final.defaultVideo`的current-plane-only判据，没有修改产品代码。
3. 157初次Wikipedia检查在等待与第二次采样间遇到plane readiness变化而失败；随后原连接自然收敛，无重连/reload。事后保存`157-wikipedia-first-readiness-observation`，不将事后状态冒充瞬间现场。
4. 89原`89-wikipedia.png`内容空白，尽管当次诊断为video/ready且Control最终URL已变为Wikipedia；当时loading及远端内容状态未同步保存，**空白原因不能确认**。主组清理后只做一次独立89 Wikipedia短补验，等待实际tab loading=false和正确标题，再截图得到可读内容。补验`wiki89-supplement/89-wikipedia-content.png`已检查；其Browser PID12176/incarnation8a73a5743d34b94fa7959f1833dce4db，日志无fatal/GPU退出，不混进主组连续性证明。

## 证据与收尾

目录`develop/tmp/video-lifecycle-qa/`保存supervisor、轻量表单/popup fixture和browser helpers；实际网页事件在各run的`fixture-events.json`，诊断/摘要在`metrics/client-metrics.jsonl`，主要name为各版本google、wikipedia、fixture、split、resize390、resize1440、final、summary及独立fallback记录。Google、157 Wikipedia、89补验Wikipedia、两版split及fallback截图均已逐图检查。

主组与短补验自有contexts全部关闭，fixture `/shutdown`完成，supervisor/Control/Browser退出，33593/33594无listener，各自`cleanup.json`保存空进程/端口列表；host默认browser也调用browser_close释放。无按进程名批量清理，无Native IPC timeout或负CHECK，无历史性能矩阵复跑。
