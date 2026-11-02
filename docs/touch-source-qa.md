# 触控源时钟有界检查

这是正式生产Viewer→DataChannel→Endpoint→Browser的自动化触摸检查，不是物理
触屏手感、性能矩阵或Pixel marker验收。接收端使用宿主Playwright启动的隔离
Chromium157，CDP只连接接收端；不接远端WebView的DevTools，避免抢占其TouchEmulator。

先完成正常增量native/Control生产构建并获得GPU独占窗口。从仓库根启动：

```powershell
node control/node_modules/tsx/dist/cli.mjs tools/touch-source-qa-server.mts
```

服务使用`build/endpoint-package/endpoint/endpoint_service.exe`、当前增量
`C:/src/chromium/src/out/dev/remotekit_browser.exe`和`control/dist/client`，端口
33281/33282。临时SQLite/Profile/结果写入`develop/tmp/touch-source-qa-*`，不读取
用户Profile或凭据。实际路径写到`develop/tmp/touch-source-qa-active.json`。

通过已启用的宿主Playwright `browser_run_code_unsafe`，以filename运行
`tools/verify-touch-source.js`。脚本仅创建/关闭自己启动的headless Chrome context。
测试注册新隔离账号，经生产WebSocket action导航固定fixture，CDP发20×16ms滑动。
三条等价轨迹为正常、途中touch包70ms暂停后保序批量发送、只延迟UP100ms。
CDP指令按固定16ms deadline有序发送，响应集中等待；逐包等待回复会人为引入
每帧等待并使实际发送历时约翻倍。result记录issuedElapsed，须先核对驱动前提。
Viewer侧记录源elapsed和真实发送时刻，远端测试页主动POST DOM事件timestamp、
dispatch时间及scrollTop曲线，不用模型替代真实结果。

最小语义包括嵌套overflow、cross-origin iframe、touch-action:none、touchmove
preventDefault、touchcancel/lostpointercapture，以及DPR1/2坐标映射。DPR2 case使用
高画质，记录实际网页DPR、Viewer DPR、layout、Control quality与backing尺寸；
requested ClientScale不能替代实际DPR。跨origin iframe通过不独立证明其renderer
进程隔离，若缺少原生进程证据应据实标注。

正式服务输入策略固定GENERIC_DESKTOP与官方96逻辑PPI（snapshot touchTiming含
configuration/logicalPixelsPerInch）；它们独立于主机屏幕/触控偏好，页面DPR与
刷新仍由Client/媒体策略控制。driver不会替产品改写这些服务参数。

结果为run目录的`result.json`与`telemetry.jsonl`；截图为
run目录的`final.png`（前两轮历史截图在`develop/tmp/touch-source-qa-final.png`）。checks中的false是失败，不能只凭已有滚动
或触发过cancel记通过。开始后10分钟为调查预算，单fixture18秒就绪超时。
结束后关闭自有context并请求：

```powershell
Invoke-WebRequest http://127.0.0.1:33282/shutdown -UseBasicParsing
```

服务会正常关闭自有Endpoint/Browser。确认进程退出后再交出GPU/构建窗口；不要
关闭用户浏览器、RDP或系统服务。修复后仅复跑失败及受影响case。

本次同步ACK修复的复验，在同一宿主工具页先执行
`async page => { page._rkTouchFailedOnly = true; }`，再以filename运行driver，
只跳过已有完整无拒绝通过的touch-action:none/preventDefault两项，其余8项重跑。
修正驱动后仅三轨迹复验，先执行
`async page => { page._rkTouchTrajectoriesOnly = true; }`，再运行同driver。
单条normal根因判别可再设`page._rkTouchModes=['normal']`。QA server的
`REMOTEKIT_TOUCH_BROWSER_DISABLE_FEATURES`仅用于已批准的受控诊断（本次曾只禁
ExperimentalFlingAnimation验证曲线路径），不是生产设置；正式验收保持该变量
未设置并检查result.browserDisableFeatures为空。默认三模式可显式设回
`page._rkTouchModes=['normal','stall70','up100']`。
