# 回环崩溃热修真实运行验收（2026-11-03）

修复后的源码产物在Chrome89/DPR1与Chromium157/DPR2普通Viewer中通过本次定向验收：真实远端设备枚举、Chromium输出target→Opus→Viewer双声道PCM、RTC及ViewerWS断连后的文档内存保留、resize/导航及实际Google搜索页均完成。两客户端实际运行均超过60秒；全程仅一个Browser启动，PID和incarnation不变，没有用户包中出现的音频/Viz致命断言。此报告验证源码运行产物，不能代替后续修复包验收。

## 产物和隔离

- Root在构建完成、无其他GPU任务后给GO；未与构建并发。采用host-managed Playwright隔离context，没有Computer Use、用户Profile或已运行用户包操作。
- Browser：`C:/src/chromium/src/out/dev/remotekit_browser.exe`，SHA256 `dc6351322e7b934d2c4d7e172d158cce06b6157227787e360f259fa3c712b501`。Endpoint：`build/endpoint-package/endpoint/endpoint_service.exe`，与`develop/tmp/loopback-hotfix-build-manifest.json`相同。Endpoint从Browser目录加载当前SDK。
- 独立Node运行`control/dist/server.mjs`生产入口；自有端口33591/33592、数据`develop/tmp/loopback-crash-qa/endpoint`、独立ControlDB及临时账号。服务/fixture/浏览器自动化代码均在该临时证据目录。
- Browser主进程命令行没有QA注入`--disable-features`；其子进程实际生效列表含`AudioServiceOutOfProcess`关闭，来源是本次生产main_delegate修复。完整命令行证据`processes-89-start.json`。

## 结果

|检查|89.0.4389.90 / DPR1|157.0.8103.15 / DPR2|
|---|---|---|
|远端真实enumerateDevices|播放前连续10次，播放时再1次；均返回audiooutput|播放前连续10次，播放时再1次；均返回audiooutput|
|实际Viewer解码PCM|左右主频430.66/882.86Hz，RMS约0.056|左右主频430.66/882.86Hz，RMS约0.056|
|纯RTC故障|关闭实际DataChannel→自动新建RTC；JS nonce、未提交文本、scrollY640完全保持|相同故障→新RTC；nonce、文本、scrollY320.08194完全保持|
|Viewer↔Control WS重连|正常close4002后自动恢复；nonce/文本/scroll640保持，RTC按lease契约替换|nonce/文本保持；首次几何变化有0.187744CSSpx舍入差，后续相同几何精确保留319.8941956；RTC替换|
|resize / 导航|1440→1100→1440及fixture→Google保持RTC/video/stream/track身份|同样通过；稳态video、MSTP0、drawImage0，resize仅2次有界freeze|
|实际外站|Google搜索结果已流式呈现，截图逐图核对|Google搜索结果已流式呈现，截图逐图核对；最终loading=false|
|持续运行|首个Browser22:08:49至89 Google截图22:11:43，约174秒，含注入故障|157 Viewer最终performance.now约90.3秒，含注入故障|

Browser PID **20012**、incarnation **0dd0c526c539cd4b99872b719a3f21a1**，从22:08:49直到157最后进程快照22:13:20保持不变，约271秒。Endpoint日志只有一次`browser launched pid`。自有`browser.log`及`server.stderr.log`无`FATAL`/`Check failed`，未出现音频`enable_remote_client_support_`及Viz当前帧同步完成断言。STUN10051、Chrome89首次offer的BUNDLE payload碰撞/兼容回退及外站SSL/CSP日志仍可见，均未导致本组Browser退出；不把它们隐去或视为致命断言已复现。

## 失败尝试和判据校正

1. 89初次点击播放按钮有focus排队但未产生播放事件，`89-play-click-failed.png`及inputTrace保留。第二次相同真实鼠标点击后远端报告AudioContext running、播放中枚举成功，随后实际PCM通过。没有用直接调用远端onclick替代点击；初次点击未生效仍作为观察保留，不能宣称所有输入边缘均通过。
2. 首个WS故障脚本误用保留码4001，被生产逻辑正确识别为lease撤销；Viewer停止自动重连。用真实“在此处继续”按钮恢复后，远端nonce、未提交文本及scroll640仍保留。正常网络故障组改为4002。
3. 89正常WS重连最初错误断言RTC身份必须保持而失败。Root核对`control.ts`的detachViewer/attachViewer及`http.ts` lease路径：ViewerWS断开结束旧lease及媒体，新lease重建RTC是当前行为；它不同于Endpoint管理WSS同进程重连。`89-control-ws-observed`保留真实结果，本组只要求Browser/文档状态保留。
4. 157第一次WS重连的严格scroll相等判据失败：viewport1441×813→1440×812，fractional effectiveDPR约1.33169，scroll320.0819397→319.8941956，差0.187744CSSpx；nonce与文本完全相同。原始`157-ws-scroll-difference`保留。此项只记为几何改变时近似保持；后续相同几何重连精确保留。最终复用脚本规定：相同几何scroll必须精确相等，仅几何变化允许≤1CSSpx并报告原始差值。

## 证据与收尾

完整事件`develop/tmp/loopback-crash-qa/fixture-events.json`由实际远端网页POST上报，包含JS随机nonce、真实表单文本、scroll及视口/inputBounds；不是Viewer mock或Control产品快照替代。详细检查及时间保存在`metrics/client-metrics.jsonl`，主要name为`89-enumeration`、`89-playback-memory`、`89-rtc-reconnect-preserved`、`89-control-ws-observed`、`89-resize-idle`、`157-enumeration`、`157-playback-memory`、`157-rtc-preserved`、`157-ws-scroll-difference`、`157-control-ws-preserved`、`157-resize-idle`、`157-final`。

实景`89-google.png`、`157-google.png`均已逐图检查。主进程证据`processes-89-start.json`、`process-89-reconnect.json`、`process-89-final.json`、`process-157-mid.json`、`process-157-final.json`。临时README保留下一位发布验收代理的复用方式，并支持显式指定包内Control/Endpoint/Browser及新数据目录。

自有Playwright contexts已关闭，fixture `/shutdown`已完成；supervisor、Control PID1856、Endpoint10060、Browser20012均退出，端口33591/33592不再监听。没有按进程名批量清理、没有触碰用户包。没有注入NativeIPC timeout，没有重复历史性能矩阵；本组不是吞吐性能或实体硬件覆盖声明。
