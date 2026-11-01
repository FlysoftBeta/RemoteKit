# 产品真实运行与视觉检查

2026-11-02，Sol。此轮是功能联调，不新增性能验收组。使用正式Control客户端与真实Endpoint/Browser、QSV H.264、真实接收canvas；未用mock替代服务。

## 环境与证据

- 隔离服务：Control `127.0.0.1:33171`，测试站点 `127.0.0.1:33172`，全部SQLite/Profile/日志在 `develop/tmp/product-runtime-qa-1793552491055`；接收Profile在 `develop/tmp/product-runtime-qa-client-157`、`product-runtime-qa-client-89`。
- Endpoint：`build/endpoint-package/endpoint/endpoint_service.exe`；Browser：`C:/src/chromium/src/out/dev/remotekit_browser.exe`。构建由native/server代理完成后释放窗口，本检查未并发构建或性能采样。
- 客户端：Chromium **157.0.8103.15** headless、官方fake60；Google Chrome **89.0.4389.90** headless。宿主Playwright启动隔离接收端，没有切换窗口或控制桌面。
- `metrics/client-metrics.jsonl`保存真实WS/DC/输入与native snapshot，`endpoint-calls.jsonl`保存真实服务调用；截图在同一证据目录。测试harness为`develop/tmp/product-runtime-qa-server.mts`及`product-runtime-qa-bootstrap*.js`。
- Chrome89需要CSS locator+force或raw mouse：当前宿主Playwright的可见性检查调用Chrome89不存在的`Element.checkVisibility`。这仅绕过测试工具自身检查，没有修改浏览器或产品页面能力。

## 已实测

| 功能 | 结果与证据 |
| --- | --- |
| 注册/登录/退出与隔离 | A/B两用户独立workspace、站点UA、ClientScale；B访问A的tab操作返回404。退出再登录恢复B自己的tab。客户端localStorage为空 |
| 正常Viewer信令 | 媒体offer/ice/close、action、viewport、clock.ping及feedback走WS；正常HTTP记录为auth与显式QA metrics上传，没有HTTP state/actions/RTC轮询 |
| Chrome89基本兼容 | MUI外壳、注册、H264解码与真实canvas、远程鼠标触发alert、产品确认、设置覆盖/退出登录通过，无pageerror。设置前后内容区均1440×812 |
| 窗口与窄屏 | 菜单新建两个独立Window；桌面各718×812 DIP，390px窄屏只显示active Window并把另一页设hidden，身份与tab归属不变。截图`split.png`、`narrow.png` |
| ClientScale与质量 | GUI三档实际下发：quality 50FPS/44–48Mbps，auto 52/36–44，smooth 60/24–36并受约60Hz显示估算上限约束；snapshot保存requested/applied。GUI scale=1.5后服务端像素预算将DPR算为1.33169，网页实际DPR1.33169、DIP1440×812不变 |
| 接收协商 | 首版157 native offer只有level3.1，真实896×508、14Mbps上限，已报告并由客户端代理修复。新bundle自动H264 level4.2后，双窗真实1938×1094解码、mediaScale=1且两canvas ready；截图`split-full-resolution.png`。这不是FPS/Pixel marker验收 |
| 每origin UA | `127.0.0.1`改平板UA，`localhost`仍桌面UA；真实请求CH为Android/Windows。保存UA时beforeunload取消保留旧文档，之后确认reload实际Android UA生效；DIP、DPR、touch/coarse没有因UA改变 |
| Popup收养/关闭 | 通过canvas真实远程鼠标触发window.open，产品创建第二Tab；Browser实际child标题证明`opener=true`、克隆sessionStorage=`qa-opener`；激活opener后远程按钮自然close删除child，没有对账重建。额外站点33173以popup features触发独立第三Window，同样保留opener/克隆sessionStorage，child远程按钮window.close后产品移除tab；截图`popup-window.png` |
| 页面dialog | 真实远程按钮触发alert、confirm取消、prompt Unicode回复`产品中文✓`；对应原始页面title证明回复到达JS。reload与地址栏导航beforeunload取消/确认均通过，取消保留原URL且不删tab。地址栏导航在新建真实Tab上重测，避免下述序号问题影响Protect按钮。截图`alert.png`、`prompt.png`、`chrome89-alert.png` |
| Memory saver | 未改120秒阈值。隐藏页1在约120秒后真实actual=2；切回Window后发restore，实际instance从1变2、actual=0、可见并有新canvas。`runtime-QA-evidence.checks[case=memory-saver-120s]`含调用与前后snapshot |
| WS断线/接管 | 主动断WS+临时offline350ms后，Control viewer.connected=false、两个实际WebView visible=false；恢复网络后恢复媒体。新Viewer接管后旧页显示“浏览器已在另一处打开”，2秒内旧页offer数保持2没有争抢，显式“在此处继续”重连 |
| 真实延迟反馈 | DC frame带captureWallTimeMs/Monotonic/uncertainty/sourceCaptureId；真实canvas paint后形成accepted WS feedback（capture-end-to-paint，示例约26–36ms、uncertainty约3ms）。静态页稳定后间隔3秒feedback数量79→79，重复sourceCaptureId未当新样本。该估算不等于Pixel marker |

Sol已查看桌面、双窗、390px窄屏、桌面/窄屏设置、prompt与Chrome89截图。外壳、设置和页面dialog布局清楚，无产品控件溢出；窄屏测试页自身固定宽度内容有页面水平滚动。视觉/交互评分4/5。本轮发现的输入阻塞已修复并真实复验通过。

## 输入阻塞修复与真实回归

初次联调发现Viewer新实例的输入序号从0开始，原Browser WebView保留上一Viewer已接受序号。Chrome89退出再登录、157接管后“在此处继续”，出现focus成功但远程点击返回`browser: Stale token or sequence`。root交input_sequence_fix代理修复为每peer校验clientSequence、Session范围单调browserSequence。本QA没有修改生产native/server文件。

同一SQLite与Profile重启新Release包，先建立已接受的旧输入序号，再作真实首输入回归：

- Chrome89：初始browserSequence 1–12；页面reload后首clientSequence=1映射browserSequence=13，退出再登录首clientSequence=1映射17；均立即触发真实alert，所有input.result成功。
- Chromium157：建立旧输入后新Viewer接管，首clientSequence=1映射browserSequence=4；旧页“在此处继续”首clientSequence=1映射7；均立即触发alert。
- Chrome89重新登录后，真实Protect按钮已执行；地址栏导航beforeunload取消保留`/page?static=1`、接受到达`/next`，通过。

最终证据为`metrics/client-metrics.jsonl`中`kind=runtime-QA-input-fix-final`。两个接收context与自有Control/Endpoint/Browser均已正常关闭，保留隔离数据。

## 额外发现与未验证范围

为释放构建包锁而结束首次QA进程树后，同数据冷启动时4个view的导航blob恢复逐个达到`RestoreNavigation`的11秒等待，stderr报告`navigation recovery did not finish`，再fallback重建；串行总时长超过Control 20秒RPC超时，UI出现`session.ensure`/`sitePreferences`超时。之后错误自行清空、两客户端恢复真实帧。该恢复慢问题已交root追踪；本轮没有清理blob来掩盖它，也没有把fallback重建记作完整导航blob恢复通过。

真实硬件IME、物理触控、多显示器DPI和物理扫描输出未在此轮验证。

## 执行边界

受控clock/quality模型测试与现有native生命周期测试由相应实施代理报告；本表仅列此轮真实产品链实测。没有运行新的45/120秒性能组；120秒等待只验证正式memory saver功能。普通window.open Tab、带popup特征的新Window以及产品菜单新Window均有真实证据。
