# RemoteKit Control Demo

TypeScript + Better-sqlite3 + Vite + React 的浏览器控制面。Control 保存租户、Tab、地址与设备配置，Endpoint Session 保存浏览器恢复信息。媒体和输入通过客户端与 Endpoint 的 WebRTC 直接传输。

## 启动

在本目录运行：

```powershell
npm ci
npm run build
npm start
```

打开 `http://127.0.0.1:3001`。`npm start` 直接运行生产bundle `dist/server.mjs`；开发后端可用 `npm run dev`，另外运行 `npm run client`，访问 Vite 的 5173 端口；API 代理至 3001。

服务默认启动 `../build/endpoint/endpoint/endpoint_service.exe`。可用 `REMOTEKIT_ENDPOINT` 指定程序，`REMOTEKIT_ENDPOINT_ARGS` 指定 JSON 参数数组。Endpoint 的 browser、SDK 与硬件编码器必须完成构建才能收到远程画面；UI 不会以本地内容模拟成功串流。

每个新的浏览器会话分配独立 Tenant，随机 HttpOnly cookie 绑定身份，SQLite 持久保存产品状态。多租户测试用独立浏览器 contexts，不通过任意 tenantId 切换权限。

## 配置

| 环境变量 | 用途 |
|---|---|
| PORT | HTTP 端口，默认3001 |
| REMOTEKIT_CONTROL_HOST | 监听地址，默认 `127.0.0.1`；局域网可设本机LAN IP或 `0.0.0.0` |
| REMOTEKIT_HTTPS_KEY / REMOTEKIT_HTTPS_CERT | 同时设置PEM私钥与证书文件路径启用HTTPS |
| REMOTEKIT_CONTROL_DB | SQLite 路径，默认 `control/data/control.db` |
| REMOTEKIT_ENDPOINT | Endpoint 可执行程序 |
| REMOTEKIT_ENDPOINT_ARGS | 程序参数的 JSON 数组 |
| REMOTEKIT_CONTROL_ORIGINS | 逗号分隔的允许写请求来源，默认本机3001/5173 |
| REMOTEKIT_METRICS_DIR | 诊断指标输出目录，默认仓库 `develop/tmp/metrics`；目录可自动创建 |
| REMOTEKIT_NETWORK_SIM | 默认关闭；显式 JSON 启用本机 UDP 网络实验，见下文 |

局域网示例（替换为服务机实际地址）：

```powershell
$env:REMOTEKIT_CONTROL_HOST='0.0.0.0'
$env:REMOTEKIT_CONTROL_ORIGINS='http://192.168.1.20:3001'
npm start
```

客户端访问 `http://192.168.1.20:3001`。启用HTTPS时再设置 `REMOTEKIT_HTTPS_KEY` 与 `REMOTEKIT_HTTPS_CERT`，将允许来源改为实际 `https://...`；HTTPS会话cookie自动带Secure。证书由客户端信任，程序不会安装CA或修改系统配置。本机网络模拟仍只支持loopback实验。

## 验证与诊断

`npm test` 运行控制面契约与测量工具测试；`npm run build` 做 TypeScript 检查和 Chrome 89 目标构建。开发诊断面板显示实际 WebRTC 指标，缺测显示「—」。Pixel marker 从接收视频像素识别并保存原始样本，输入响应使用客户端自己的单调时钟；同机画面时钟比较须显式开启，不能把跨机器时钟差当作延迟。

诊断栏可开启不拦截输入的画面HUD，分别显示画布显示FPS、解码FPS和Marker抽样Hz，以及码率、Marker百分位、RTT、capture→ready、GPU copy、编码耗时与编码器。无已保存选择时，精确匹配Desktop Chrome/89.0.4389.90的客户端默认CB4.2，其他客户端默认原生offer；显式选择随本浏览器保存，优先于默认值。Chrome89也可选择高DPR的CB5.1实验档；原始/有效SDP均保留，未知客户端不会被自动提高能力声明。实际视频是否流畅仍以测量为准。

画面通过实际rVFC RTP timestamp与layout epoch匹配后显示与投递输入；媒体采样缩放使用DPR×mediaScale换算，保持网页viewport/DPR独立。RTC失效或Endpoint重启后按2/5/10秒退避尝试恢复同Tenant，最多3次；显式断开停止重试。后退/前进/刷新-停止使用实际浏览器状态，Ctrl+L聚焦工作台网址框。

## 生产目录

构建还生成 `dist/server.mjs`、`dist/runtime/node_modules` 与ABI manifest，并从独立临时部署目录启动Node，验证HTML、SQLite会话和Tab动作。运行包只需同ABI的Node、`control/dist/server.mjs`、`control/dist/client`、`control/node_modules`（从dist/runtime复制better-sqlite3、bindings、file-uri-to-path）；不需要TS源码、tsx、Vite或React Node包。正式构建工具在 `tools/verify-control-build-server.mjs`。包内启动脚本应设置REMOTEKIT_ENDPOINT到实际Endpoint程序。

接口与归属见 [串流协议](../docs/streaming-protocol.md)，实际硬件和端到端测量见 [当前状态](../docs/current-state.zh-CN.md)。

## 本机网络实验

在启动 Control 前显式设置（PowerShell）：

```powershell
$env:REMOTEKIT_NETWORK_SIM='{"oneWayDelayMs":5,"downlinkMbps":24,"uplinkMbps":1000,"maxQueueBytes":300000,"maxQueueDelayMs":100}'
npm start
```

启用模拟时，Control自动只为Endpoint子进程设置REMOTEKIT_RTC_LOOPBACK_TEST=1，允许SDK枚举真正的127.0.0.1 host候选；不修改Node父环境，正常模式不追加该开关。Native answer缺少loopback候选会明确失败，不将绑定LAN接口的端口误当成loopback端口。这个开关只用于本机实验。

每个连接独立双UDP socket，均绑定127.0.0.1；双方完整SDP只保留改写后的relay候选。5ms双向基础delay形成10ms RTT，下行按24或48Mbps实际数据包整形，含UDP/IP的28字节开销，队列有界并统计丢弃。实验只支持同机原始IPv4 host候选、BUNDLE与完整ICE收集，不接受额外trickle；不支持时明确失败，不回退直连。专用Chrome89测试实例加 `--disable-features=WebRtcHideLocalIpsWithMdns --autoplay-policy=no-user-gesture-required`，使用独立profile。正常启动不加这些flags；移除环境变量关闭模拟。

从仓库根目录运行可复用验证：

```powershell
node tools/streaming-experiment-echo.mjs
node tools/streaming-experiment-webrtc.mjs --port 3012 --downlink 24
```

第二条启动180秒有界双Peer实验页，用专用Chrome89打开输出的127.0.0.1地址。报告检查两端selected remote candidate为relay端口、真实解码帧与relay字节对应。`/api/rtc/network` 在Control中返回当前租户当前connectionId的relay计数；诊断样本包含该计数、候选和进程CPU。Windows为达到5ms调度，活跃队列使用单调deadline轮询，饱和流会消耗约一个Node CPU核心；无队列不轮询。CDP网络节流不用于证明WebRTC带宽或RTT。

## 网页合成滚动对照

`control/public/compositor-pattern.html` 是独立的 `dom-compositor-scroll-v1` 场景：文字、卡片和SVG图形一次生成，以CSS transform持续平移已有内容；JS每帧只更新256×112的原协议Marker。原test-pattern.html继续作为完整Canvas重绘负载，两种结果分别标注，不能合并。

现有benchmark和source-probe无需改代码：将新场景复制为一个独立fixture目录内的test-pattern.html，再传给prepare工具。以下命令从仓库根执行，只创建新目录，不修改冻结dist或旧实验：

```powershell
$fixtureDirectory='develop/tmp/compositor-fixture-v1'
if(Test-Path -LiteralPath $fixtureDirectory){throw '请选择新的fixture目录名'}
New-Item -ItemType Directory -Path $fixtureDirectory | Out-Null
Copy-Item -LiteralPath control/public/compositor-pattern.html -Destination "$fixtureDirectory/test-pattern.html"
Copy-Item -LiteralPath control/public/marker-codec.js -Destination "$fixtureDirectory/marker-codec.js"
tools/prepare-streaming-case.ps1 -Name compositor-1080-example -FixtureDirectory $fixtureDirectory -Width 1920 -Height 1080 -FixtureMode animation -DownlinkMbps 48
```

准备命令不代表实际执行测量。实验名称应带compositor，并保留fixture快照/hash；只在既定矩阵后有预算时做少量对照。以后构建会提供直接路由 `/compositor-pattern.html`，当前新增源文件不会自动进入既有冻结dist。

兼容参数为mode=animation/text/static/change-stop、fps、stopAfter、title；额外duration控制CSS滚动周期（秒，默认12）。保留RK:序号;输入、touch回应32768+次数、frame/time/stimulus/CRC Marker协议，以及source-probe所需的精确render(now)插桩入口。在此场景，source RAF计数仍是实际RAF，render计数指小Marker更新，CSS合成独立进行；另可读取window.rkCompositorFixture的场景标识/计数。static与change-stop停止后均冻结合成动画和Marker，输入仍可产生一次回应。
