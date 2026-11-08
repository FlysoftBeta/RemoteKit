# 系统架构

RemoteKit 在 Windows 服务器上运行 Chromium，把网页渲染为离屏纹理，经 H.264 硬件编码和 WebRTC 直接串流到用户的浏览器，并把用户的键鼠、触控和文本输入送回页面。它是一个独立的 Chromium content embedder，不装配 Chrome 的 Browser/TabStripModel/BrowserView 产品对象图；对网页而言它的 UA、Client Hints 和 `window.chrome` 与 Google Chrome 一致。

## 组件

```
            ┌────────────── Viewer（用户的浏览器）──────────────┐
            │  React/MUI 外壳 · video 呈现 · 输入 · 文件篮/相机   │
            └───────┬──────────────────────────────┬──────────┘
          WebSocket │ 认证、产品状态、信令            │ WebRTC：视频/音频/输入/
                    │                              │ 产品动作/文件/人脸图像
            ┌───────▼───────┐  集群通道（Noise）┌──────▼──────────────────────┐
            │   Control     │◄────────────────►│  Endpoint（每台算力节点一个）  │
            │ Node + SQLite │  stdio 或 WS      │  Session × N                 │
            └───────────────┘                  │   ├ Comp：节拍、Slot、编码    │
                                               │   ├ RTC peer（SDK）          │
                                               │   ├ 对象存储 ◄──TCP──► 其他节点
                                               │   └ Browser 进程 ──Mojo──┐   │
                                               └──────────────────────────┼───┘
                                                ┌─────────────────────────▼───┐
                                                │ Browser（GN content embedder）│
                                                │  WebView × N · Rend · Viz OSR │
                                                │  Renderer/GPU/网络（Chromium） │
                                                └─────────────────────────────┘
```

| 组件 | 语言/构建 | 职责 |
|---|---|---|
| **Control** | TypeScript，Node，better-sqlite3，Vite/React/MUI | 产品状态的唯一真相：账户、Window/Tab、地址意图、设置、站点偏好、文件目录、操作收据。节点配置、会话放置、Tenant 密钥、对象索引与 checkpoint。认证、Viewer 租约、信令转发、对账、Memory Saver 与休眠策略、更新包分发。提供 Viewer 前端。 |
| **Endpoint** | C++20，独立 CMake/Ninja | 算力节点，可与 Control 分机部署，配置由 Control 下发。Tenant→Session；每个 Session 一个 Browser 进程。GPU atlas 消费、硬件编码（QSV/NVENC）、WebRTC、输入校验与路由、照片处理、人脸推理、加密对象存储与节点间传输、checkpoint。 |
| **Updater** | C++20，同一 CMake 工程的独立可执行文件 | 节点上的 `remotekit_node.exe`：监管 Endpoint 进程，从 Control 下载并安装与之相同版本的节点运行时。 |
| **Browser** | C++，Chromium GN | 承载 WebContents 与 Profile；页面生命周期、输入派发、页面请求（对话框/文件选择/权限/下载）、导航状态；Rend 驱动离屏绘制并合成 atlas。 |
| **SDK** | C ABI DLL（在 Chromium 树内构建） | 把 Mojo（与 Browser 的控制和渲染管道）和 libwebrtc（peer、视频源、外部编码器桥、音频源）包成 C 接口给 Endpoint 用。跨 DLL 不传任何 C++ STL/libc++/Abseil/Chromium 对象。 |
| **Viewer** | Control 提供的 Web 前端 | App 外壳：浏览器、我的文件、设置与网页 App；Space 分屏多任务与开始屏幕；video 呈现；输入、IME、触控手势；文件篮与相机。 |

## 隔离与身份

- 一个 User = 一个 workspace = 一个 Tenant = 一个 Session。Session 是多租户数据隔离边界：独立的 Browser 进程、Profile 目录、本地 Mojo 通道、GPU atlas、Tenant 密钥与对象命名空间。Session 由 Control 分配的 sessionId 标识，任一时刻只在一个节点上运行，Browser 关闭后可以在任何节点上从 checkpoint 重新打开（见[多节点](cluster.md)）。Window 与 Tab 是 Session 内的产品关系，不是隔离边界。当前每 Session 一个 Profile，层级上为多 Profile 留了位置。
- 网络用户只能通过已认证的 Control 会话和 RTC 会话进入；Session ID 不是凭据。Tenant 身份由认证用户映射得到，客户端不能指定。
- 稳定的逻辑身份与可替换的执行实例分开：WebView 是稳定的，WebContents（instance）、文档（document）、焦点（focus）、输出布局（outputGeneration/layoutEpoch）、Browser 进程（browserIncarnation）、Endpoint 进程（endpointIncarnation）、管理连接（connectionEpoch）、会话放置（placementEpoch）、RTC 尝试（attemptId）、产品授权（authEpoch）各有自己的代次。异步结果总是带着它产生时的身份回来，与当前身份不符就作废——旧请求永远不会被改投到新对象上。

## 主要数据流

**看到页面**：Comp 发 Begin → Rend 驱动 Viz 把各页面绘制到 plane 目标 → 在 GPU 上合成 atlas Slot → Signal Fence → Comp 观察到 Fence → WebRTC `AdaptFrame` 决定编码尺寸 → VPP + 硬件编码 → RTP → Viewer 解码 → 每个 Window 一个 `<video>` 裁剪出自己的区域。详见[渲染](rendering.md)、[节奏与补帧](pacing.md)、[编码](encoding.md)、[呈现](presentation.md)。

**操作页面**：DOM 事件 → 客户端门禁（平面 ready、焦点租约）→ DataChannel → Endpoint 校验 peer/授权/序号/布局 → 本地控制 RPC → Browser 校验文档与焦点 → Chromium 输入路由。详见[输入](input.md)、[移动编辑](mobile-editing.md)。

**改变产品状态**：Viewer 发 `product.action`（DataChannel）→ Endpoint 校验 peer → 管理事件交给 Control → 每 Tenant 串行提交（收据 + workspace 同一事务）→ Control 调用 Endpoint 执行 → WS 推送新快照。详见[Control](control-plane.md)。

**稳态下的连接**：resize、焦点切换、导航、锁定都不销毁 RTC 连接；只有布局换代时有一次屏障。Viewer WebSocket 断开决定产品 visible=false 及回收资格；RTC 断开只决定渲染/编码需求。

## 服务参数独立于宿主

服务端的渲染与输入不依赖服务器的显示器、DPI、刷新率或 RDP 会话：虚拟 Screen（DSF=1），页面 DPR 由 Viewer 上报（设备 DPR × 界面缩放）；节拍由 Comp 的高精度定时器和 WebRTC 反馈决定；触控惯性在客户端计算，不经过原生 fling 物理参数；剪贴板不使用系统剪贴板。客户端的 DPR、刷新能力和产品媒体策略仍作为适配输入。

## 错误模型

所有组件使用同一组错误码（`control/shared/errors.ts`、`endpoint/src/util/error.hpp`、`protocol/control.h`（Browser 控制错误码） 中的 `ErrorCode`）：

| code | 含义 | 执行确定性 |
|---|---|---|
| `invalid_request` | 输入格式或语义无效 | 未执行 |
| `unauthenticated` / `forbidden` / `locked` | 认证、权限、锁定 | 未执行 |
| `not_found` / `conflict` | 目标不存在；版本过期、ID 复用、并发修改 | 未执行 |
| `limit_exceeded` / `rate_limited` | 容量、配额、资源预算；认证尝试限流 | 未执行 |
| `busy` | 对端暂时忙，可以原样重试 | 未执行 |
| `unavailable` | Endpoint 离线、Browser 未运行、能力缺失 | 未执行（未发出） |
| `rejected` | 对端明确拒绝 | 未执行 |
| `outcome_unknown` | 已发出，结果未知（超时、回复丢失） | **可能已执行** |
| `internal` | 本地缺陷或意外故障 | — |

- 错误码同时表达"是什么错"和"有没有可能已经执行"。操作收据由此决定 rejected 还是 unknown；`outcome_unknown` 的操作只查询，从不用新 ID 重做。
- 每个边界只转换一次：HTTP 返回 `{error:{code,message}}` 和对应状态码；WS 返回 `{type:"error", id, error:{code,message}}`；Endpoint 管理回复 `{ok:false, error:{code,message}}`；Browser 控制回复 `{ok:false, code, error, detail}`。`message` 可以展示给用户；内部细节只进日志。
- Endpoint 的 Session 状态错误额外带一个 `reason`：`browser_crashed`（Browser 非正常退出）、`browser_restarting`（替换中）、`output_failed`（GPU 输出无法继续），错误码为 `unavailable`；在途操作仍按 `outcome_unknown` 处理。Control 在网关处把 reason 转成一次面向用户的文字（如"浏览器异常退出，正在恢复…"），内部原因（例如 render generation 未决的 GPU 工作）只进日志和诊断，不出现在 Viewer。
- 意外异常在请求边界和线程入口被捕获：请求返回 `internal`，线程入口把所属组件标记为失败，而不是终止进程。
- 不确定的 GPU 工作、编码任务和原生回调不靠超时"放弃"：资源保留到有证据为止，必要时保留到进程结束。
- 控制 RPC 超时只使本次结果成为 `outcome_unknown`，不关闭 SDK 通道、不清除 Endpoint 的控制句柄。SDK 使用每通道请求 ID 匹配回复，丢弃迟到回复并释放其 Mojo 附件与本地资源句柄；后续健康检查有界等待。只有管道确实断开或进程退出才允许替换 Browser，连续失败最多启动三次，按 1/2/4 秒退避，健康运行一分钟后恢复额度。拒绝重启的错误附带最近一次真实失败（进程退出码及其含义、控制管道超时或 `output.status` 错误）和 Session 目录下 `browser.log` 的路径；Endpoint 自己终止的进程（退出码 0）不算失败。GPU 输出启动失败通过现有 Session 错误投影显示在标签页/工作区。

## 代码结构

```
control/
  shared/          Viewer 与服务端共用的契约：product（产品模型）、errors、security、file-library、diagnostics
  server/
    main.ts, application.ts, config.ts   组合根与配置
    http/          HTTP 路由与 WebSocket 分发表
    auth/          账户、Viewer 锁定与 peer 授权、人脸挑战、密码学
    admin/         管理员的用户管理（创建、凭据重置、停用、转让、休眠、删除）
    persistence/   schema 与各仓库（账户、安全、workspace、操作收据、文件库）
    cluster/       集群通道（Noise、帧、节点链路）、放置、密钥派生、对象索引、指标、更新包、节点管理、Session 清理队列
    endpoint/      类型化网关（按 Tenant 路由到所在节点）与管理消息类型
    tenants/       每租户运行时状态
    viewers/       Viewer 租约与 RTC 信令
    workspace/     纯命令、操作管线、对账、导航、生命周期与 Memory Saver、页面请求、弹窗、站点策略
    session-import/  会话导入：HPKE 信封、IMAP 拉取、账密校验与写入
    files/ diagnostics/ quality.ts atlas-plan.ts navigation-url.ts
  client/
    main.tsx, viewer-session.ts          入口与控制器组装
    app/           React 外壳：舞台（stage）、叠层编排（overlay-host：开始、管理员、对话框）、Window 框与
                   browser/app chrome、菜单、视口、设置、统计叠层、管理 App（admin/）；组件与同名 .css 并置
    theme/         tokens.css（颜色、圆角、阴影等设计变量，含暗色）与 mui.css；MUI 主题读同一组变量
    control/       ControlSession（WS）、OperationsStore（待确认操作与收据）
    rtc/           RtcSession、DataChannel 协议（类型化编解码）
    auth/          授权作用域、锁屏、空闲策略、人脸相机
    presentation/  PresentationSession、VideoPlane、帧/epoch 匹配、尺寸过渡
    input/         InputPipeline、触控会话与手势、坐标、键码
    editing/       编辑会话、键盘会话、IME 翻译
    media/         音频、接收能力、统计与反馈、时钟、诊断收集
    files/         文件通道、文件库/拍照任务/导入队列、文件篮与相机 UI
  test/            Control 单元与集成测试
endpoint/
  src/
    main.cpp, options.*, service.*       入口、配置、租户注册与管理分发循环
    cluster/       集群通道库（Noise/CNG、帧、stdio/WebSocket/TCP 载体、node.json 与 build.json）
    management/    ClusterLink（管理链路）与方法表
    objects/       加密对象存储、节点间传输（PeerServer/PeerClient）
    platform/      Windows 作业与进程
    persistence/   Session 的持久文件
    session/       Session（组装）、BrowserRuntime/BrowserRpc、ViewController、导航恢复
    rtc/           PeerController、授权、DataChannel 路由与通道、发件箱
    media/         Comp 节拍、Slot、输出、媒体管线、呈现屏障、编码器（QSV/NVENC）、适配器、音频、追踪
    input/         InputController、序号、校验
    auth/          人脸推理、原始相机帧
    files/         文件库、暂存、照片处理、DC 文件服务
    diagnostics/ util/
  updater/         remotekit_node.exe：服务、监管、下载、zstd + tar 解包、自我替换
  tests/           CTest 单元测试
browser/
  browser_runtime.*, view_registry.*, layout_transaction.*, popup_registry.*, closed_views.*
  control_dispatcher.*, control_{views,page,navigation,output,input,snapshot}.cc, control_input_codec.*
  webview.*, webview_{execution,lifecycle,navigation,input,touch}.*, device_configuration.*
  osr_renderer.*, osr/（device, plane_pool, scheduler, atlas, retirement）, offscreen_host.*, render_channel.*
  page_requests.*, profile_*, browser_context.*, navigation_*, audio_target.*, compat*, view_model.*
  sdk/             sdk_{runtime,control,render,resources}.cc、rtc_{peer,encoder,video_source,audio,stats}.cc
android/           会话导入 App（Kotlin、Compose）
protocol/          跨组件契约：控制版本与错误码、渲染线格式、Slot 与音频共享内存、触控时钟、atlas 规划与 fixture、集群 Noise 测试向量
sdk/               公共 C 头与独立的 SDK 消费者 smoke
patches/           有序的 Chromium 补丁与 manifest
tools/             构建、补丁、SDK 导出、打包；tools/measure/ 性能测量；tools/tests/ 工具自身的测试
tests/             e2e/（真实栈产品场景）、integration/（原生 Endpoint/Browser 集成）
```

### Viewer 外壳约定

- 样式与组件并置（`foo.tsx` 导入 `foo.css`），全局 `style.css` 只留重置与根布局；外壳颜色取 `theme/tokens.css` 的变量；字面色值只用于数据色（App 主题色、文件类型色）和压在相机画面上的叠层。
- 拖放目标走一个注册表：`useDropTarget(kind, payload)` 返回 `{ref, hovered, replace}`，拖动方按指针位置查询登记的矩形，目标自行渲染高亮；开始屏幕的磁贴拖动与窗口把手拖动共用它。
- 不常用的界面（管理 App、会话导入）按需 `import()` 成独立 chunk，核心包是 MUI + React + 舞台；Vite 的 chunk 告警阈值按核心包实际大小设置，超过即说明核心包在增长。
- 自动化钩子 `window.__remotekitTest` 只在开发构建里由 `main.tsx` 动态导入（`import.meta.env.DEV`），发布产物不含它。

## 文档索引

| 文档 | 内容 |
|---|---|
| [多节点](cluster.md) | 配置文件、集群通道与握手、版本锁定与更新、放置与密钥、对象存储、checkpoint 与休眠、指标、节点移除 |
| [工作区](workspace.md) | App、Window 与 Space 多任务、开始屏幕与 frecency、安装网页为 App、设置拆分、我的文件的来源与分区 |
| [Control](control-plane.md) | 数据归属、连接、操作与收据、导航、对账、对话框/关闭/弹窗、站点身份、全屏、设置 |
| [页面生命周期](page-lifecycle.md) | 可见性、freeze/discard/unload/restore、Memory Saver、不确定恢复、导航导出、Profile |
| [渲染](rendering.md) | OSR 输出设备、plane、atlas、Slot/Fence、渲染管道协议、换代、几何 |
| [节奏与补帧](pacing.md) | Comp 节拍、背压、Idle/Wake、尾 IDR、呈现刷新 |
| [编码](encoding.md) | 适配器、EncoderWorker、QSV/NVENC 参数、H.264 level、WebRTC 适配、码控声明、发送 pacing |
| [呈现与音频](presentation.md) | video 平面、布局屏障、RTP 匹配、接收端缓冲、统计口径、音频管线 |
| [输入](input.md) | 身份与门禁、键鼠/IME、触控时钟、客户端手势、惯性、终止账本、坐标 |
| [移动编辑](mobile-editing.md) | 编辑目标、键盘会话、resize 事务 |
| [文件与相机](files-and-camera.md) | 原生文件选择、文件库、拍照选帧、文档扫描 |
| [认证](auth.md) | 账户、锁屏、授权代次、人脸验证 |
| [会话导入](session-import.md) | 部署配置与账户、HPKE 信封、邮箱队列、Control 导入与写入、Android App |
| [兼容性](compatibility.md) | UA/Client Hints、window.chrome、Chrome89 |
| [诊断与测量](diagnostics.md) | 诊断收集、追踪、测量方法 |
| [调优经验](tuning.md) | 被否决的方案与原因 |
| [协议参考](protocols.md) | 各边界的消息与字段 |
| [构建与发布](build.md) | 构建、补丁、SDK、打包、测试 |
