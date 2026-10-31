# Control 集成与验证

2026-11-01。Control保存Tenant、Tab、地址、设备、激活与分屏配置；Endpoint管理Session与浏览器恢复。SQLite会话由随机HttpOnly / SameSite cookie绑定，POST校验Origin，拒绝客户端自报Tenant。

## 构建与部署

在control执行npm ci、npm run build、npm start。start直接运行生产bundle dist/server.mjs；开发用npm run dev和npm run client（5173代理3001）。实测Node24.22.0、native ABI137。

build检查TypeScript、构建Chrome89客户端和server，并在独立临时目录做生产启动smoke。部署只需同ABI的Node、control/dist/server.mjs、control/dist/client、control/node_modules；最小依赖由tools/verify-control-build-server.mjs组装至dist/runtime/node_modules，包括better-sqlite3、bindings、file-uri-to-path及native binding/license。运行包无需TS源码、tsx、Vite或React Node包。

REMOTEKIT_ENDPOINT与JSON数组REMOTEKIT_ENDPOINT_ARGS指定服务程序和参数。REMOTEKIT_CONTROL_DB、REMOTEKIT_CONTROL_ORIGINS、REMOTEKIT_METRICS_DIR配置DB、允许来源与指标目录；默认指标目录develop/tmp/metrics自动创建，程序不读取develop输入。REMOTEKIT_CONTROL_HOST默认127.0.0.1，可显式设LAN IP/0.0.0.0；同时设置REMOTEKIT_HTTPS_KEY/CERT启用HTTPS与Secure cookie。README有LAN/TLS示例。本机可信TLS和0.0.0.0绑定已自动验证；实际无线LAN访问尚未实测。

## 生命周期与输入

父子进程JSONL限制1MiB、唯一请求ID、20秒超时。Endpoint退出1.5秒后重启；每1.5秒读snapshot，缺失对象才ensure、配置变化才configure，先隐藏旧前台再显示新前台。active/split占atlas，后台Tab保留。url/title/loading/导航能力从实际snapshot更新，pendingUrl与提交地址区分。viewId稳定映射为非零十进制uint64字符串。

正常关闭保留产品Tab直到snapshot确认页面移除。明确pending_close.requestId即进入确认，即使browser close_state仍为closing；取消通过view.close.reply拒绝，接受后继续等待实际onclose，force用于orphan回收。后退/前进/刷新-停止使用实际浏览器状态；Ctrl+L聚焦本地网址框。设备模式变化配置后正常reload，纯尺寸/DPR变化不强制刷新。

RTC offer/ICE/close绑定cookie租户与当前connectionId。RTC失效或endpointGeneration变化后按2/5/10秒最多3次自动重连，保留同Tenant产品状态；禁止并发建连，显式断开与卸载清timer。收到匹配布局的真实帧才重置故障预算。

layout.epoch与实际wire rtpTimestamp匹配rVFC帧。256项映射、一个最新待确认canvas与授权canvas交换，未知RTP/旧epoch暂停显示和输入。input/focus均带layoutEpoch；focusRequestId关联明确ACK并校验当前epoch、view/session/instance/document，同token的成功no-op也放行。A→B→A旧ACK不放行。canvas pointerdown取消默认行为，防止隐藏IME框立即失焦而丢触控队列。坐标、wheel和marker使用DPR×mediaScale，网页viewport/DPR保持独立。

## 呈现与诊断

Viewport在授权新帧事件内立即draw，resize同RTP重绘不增加FPS；draw完成报告每plane paintedAt/paintedWallTime。raw rVFC、解码、授权、画布paint和Marker抽样Hz分别计数。Marker读同RTP的授权atlas小区域，延迟使用对应plane的paint时间，读回与CRC完成耗时另记。

Marker默认10Hz，可选5/10/30/60Hz；输入刺激待响应期间逐paint识别首个回应，之后恢复抽样。报告最多2000有效原始样本、p50/p95/p99、invalid、包含主动抽样的frame-id gaps、实验参数及候选/relay计数。输入响应使用客户端单调时钟；明确选择同机时钟才计算画面Date.now差。

HUD默认关闭、pointer-events:none，沿用现有界面样式，显示画布FPS、解码FPS、抽样Hz、Marker百分位、RTT、capture→ready、GPU copy、encode、码率/encoder及source/encoded尺寸和mediaScale。下行BWE取真实senderRtcStats，缺测显示—。小tablet按容器缩放，全部指标保持可见。

无已存选择时，精确Desktop Chrome/89.0.4389.90默认CB4.2，其他客户端默认原生offer；显式选择持久保存且优先。原生/4.2/5.1均可选，5.1是高DPR实验档。仅改constrained-baseline mode1 fmtp，原始/有效SDP及改动记录保留。

test-pattern.html提供animation/text/static/change-stop。静态/停止后的scene与marker均冻结；停止场景黄色背景使用深色文字便于质量观察。标准meta viewport、UA/CH/platform/touch/DPR/viewport与composition信息可见。beforeunload与activationMarker查询参数用于真实关闭测试，60001表示远端hasBeenActive=true。网络实验工具与证据见network-simulation.md。

## 已获得的证据

- 最新build、25项测试与独立生产smoke通过。覆盖租户/Origin/RTC归属、真实stdio重启、对账、closing+pending关闭确认、URL重定向、模式reload、focus ACK/no-op/旧请求、epoch有界映射、mediaScale坐标、接收档默认/保存优先、重连、Marker、呈现计数、TLS与UDP有界队列。最近生产smoke：develop/tmp/control-production-LHr7jK。
- Chrome89.0.4389.90 headed，独立临时context，未操作用户鼠标键盘或Profile。rVFC实际含rtpTimestamp、expectedDisplayTime、presentationTime、presentedFrames、processingDuration、receiveTime、width/height。
- v2 UI run3通过静态首连接、Tab A/B切换、双平面、后退/前进、Ctrl+L、tablet模式reload、中文composition77。桌面1280×720、split编码2576×728、tablet820×1180@2编码1656×2376均收到真实视频。截图已逐张视觉检查。证据develop/tmp/control-ui-run3及control-ui-*.png。
- Tablet视频内UA/CH为Android、mobile=false、Linux armv81、maxTouchPoints10、DPR≈2、viewport820×1180。compositionend和lastInput包含“你好 RK:77;”。自动注入composition路径已验证，物理IME操作未代替用户执行。
- 精确kill测试复制的endpoint_service后，静态冻结画面自动恢复；Tenant与2个Tab不变、connectionId更新。watcher记录develop/tmp/control-final-ui/restart.json；恢复首decoded帧为冻结change-stop画面，证据control-ui-run3/restart-restored-source.jpg。
- 最终触控CRC回应32769、重复已focus输入回应81→82；RTC close返回200/29.91ms，2.2秒后peer=false且未连接。host实际回传保存develop/tmp/control-input-final/result.json与control-ui-final-input.png。该组带高质量JPEG的metrics超过1MiB；工具已改限额并检查上传状态。
- 最终beforeunload真实通过：收到activation CRC60001后出现requestId1的确认；取消后Tab仍1且pending=null，再次接受后Tab为0且pending=null。小tablet HUD、确认/取消/接受截图已检查，当前组metrics均实际上传成功。证据develop/tmp/control-close-pass/{result,activated-small-tablet,confirmation,canceled,accepted}.json与control-close-final/*.png。
- MediaCapabilities file avc1.42E02A/1920×1080@60/24Mbps与file avc1.42E033/1640×2360@60均返回supported/smooth/powerEfficient=true；89的type=webrtc抛invalid enum TypeError。实际H264解码与API查询分别记录。

性能矩阵和结论由媒体实验记录；短UI功能片段不用于判定>50FPS或<100ms目标。
