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
| **Control** | TypeScript，Node，better-sqlite3，Vite/React/MUI | 产品状态的唯一真相：账户、Window/Tab、地址意图、设置、站点偏好、文件目录、操作收据。节点配置、会话放置、Tenant 密钥、对象索引与 checkpoint。认证、Viewer 租约、信令转发、对账、回收策略（停止与提交）、更新包分发。提供 Viewer 前端。 |
| **Endpoint** | C++20，独立 CMake/Ninja | 算力节点，可与 Control 分机部署，配置由 Control 下发。Tenant→Session；每个 Session 一个 Browser 进程。GPU atlas 消费、硬件编码（QSV/NVENC）、WebRTC、输入校验与路由、照片处理、人脸推理、加密对象存储与节点间传输、checkpoint。 |
| **Updater** | C++20，同一 CMake 工程的独立可执行文件（静态 CRT） | 节点上的 `remotekit_node.exe`：监管 Endpoint 进程，从 Control 下载并安装与之相同版本的节点运行时。Control 主机上的 `remotekit_control.exe`：按加密的发布 manifest 从 GitHub Releases 下载增量或完整包，安装、切换并监管 Control，自更新。 |
| **Browser** | C++，Chromium GN | 承载 WebContents 与 Profile；页面生命周期、输入派发、页面请求（对话框/文件选择/权限/下载）、导航状态；Rend 驱动离屏绘制并合成 atlas。 |
| **SDK** | C ABI DLL（在 Chromium 树内构建） | 把 Mojo（与 Browser 的控制和渲染管道）和 libwebrtc（peer、视频源、外部编码器桥、音频源）包成 C 接口给 Endpoint 用。跨 DLL 不传任何 C++ STL/libc++/Abseil/Chromium 对象。 |
| **Viewer** | Control 提供的 Web 前端 | App 外壳：浏览器、我的文件、设置、学习、题库与网页 App；Space 分屏多任务与开始屏幕；video 呈现；输入、IME、触控手势；文件篮与相机。 |

## 隔离与身份

- 一个 User = 一个 workspace = 一个 Tenant = 一个 Session。Session 是多租户数据隔离边界：独立的 Browser 进程、Profile 目录、本地 Mojo 通道、GPU atlas 与 Profile 密钥。文件字节不是隔离边界的一部分：对象存储按内容寻址、跨 Tenant 去重，读取权限来自 Control 按 Tenant 记录的引用。Session 由 Control 分配的 sessionId 标识，任一时刻只在一个节点上运行，Browser 关闭后可以在任何节点上从 checkpoint 重新打开（见[多节点](cluster.md)）。Window 与 Tab 是 Session 内的产品关系，不是隔离边界。当前每 Session 一个 Profile，层级上为多 Profile 留了位置。
- 网络用户只能通过已认证的 Control 会话和 RTC 会话进入；Session ID 不是凭据。Tenant 身份由认证用户映射得到，客户端不能指定。
- 稳定的逻辑身份与可替换的执行实例分开：WebView 是稳定的，WebContents（instance）、文档（document）、焦点（focus）、输出布局（outputGeneration/layoutEpoch）、Browser 进程（browserIncarnation）、Endpoint 进程（endpointIncarnation）、管理连接（connectionEpoch）、会话放置（placementEpoch）、RTC 尝试（attemptId）、产品授权（authEpoch）各有自己的代次。异步结果总是带着它产生时的身份回来，与当前身份不符就作废——旧请求永远不会被改投到新对象上。

## 主要数据流

**看到页面**：Comp 发 Begin → Rend 驱动 Viz 把各页面绘制到 plane 目标 → 在 GPU 上合成 atlas Slot → Signal Fence → Comp 观察到 Fence → WebRTC `AdaptFrame` 决定编码尺寸 → VPP + 硬件编码 → RTP → Viewer 解码 → 每个 Window 一个 `<video>` 裁剪出自己的区域。详见[渲染](rendering.md)、[节奏与补帧](pacing.md)、[编码](encoding.md)、[呈现](presentation.md)。

**操作页面**：DOM 事件 → 客户端门禁（平面 ready、焦点租约）→ DataChannel → Endpoint 校验 peer/授权/序号/布局 → 本地控制 RPC → Browser 校验文档与焦点 → Chromium 输入路由。详见[输入](input.md)、[移动编辑](mobile-editing.md)。

**改变产品状态**：Viewer 经 WS 发 `operation.submit` → Control 每 Tenant 串行提交（收据与 workspace 同一事务）并回复收据 → WS 推送新快照 → Control 发布新的期望状态，Endpoint 收敛并报告观察状态。外壳不依赖 Session 所在的 Endpoint：Session 不能运行时，只有浏览器窗口的页面区域显示不可用（见[Control · 连接](control-plane.md#连接)）。Control 与 Endpoint 之间的协调见[多节点 · 协调协议](cluster.md#协调协议)。详见[Control](control-plane.md)。

**稳态下的连接**：resize、焦点切换、导航、锁定都不销毁 RTC 连接；只有布局换代时有一次屏障。Viewer WebSocket 断开决定产品 visible=false 及回收资格；RTC 断开只决定渲染/编码需求。

## 服务参数独立于宿主

服务端的渲染与输入不依赖服务器的显示器、DPI、刷新率或 RDP 会话：每个视图一块虚拟显示器（尺寸等于视图 viewport，DSF 为 Viewer 上报的 DPR，即设备 DPR × 界面缩放），主 frame 与跨进程 iframe 读到同一块屏幕；指针/触控能力与配色偏好是固定值，不读服务器硬件与 Windows 主题（见[兼容性](compatibility.md)）；节拍由 Comp 的高精度定时器和 WebRTC 反馈决定；触控惯性在客户端计算，不经过原生 fling 物理参数；剪贴板不使用系统剪贴板，由 Control 保存、Browser 缓存。客户端的 DPR、刷新能力和产品媒体策略仍作为适配输入。

## 错误模型

三端共用一组错误码，错误码就是处理指令：生产方按调用方该做什么选 code，各边界只转换一次，消费方只按 code 决定重试、对账、刷新或放弃，并且失败之后不能留下非法的状态组合。完整规则——错误码表、生产方选择、线上形状、错误 ID、消费方契约与重试单元、错误路径上的状态、执法测试与 Viewer 呈现——见[错误模型](errors.md)。

## 持久化格式

每种落盘格式属于一个存储，有显式版本和唯一一对解码器与编码器（同一份格式定义）。

- **解码严格**：形状与类型精确，必需字段必须存在，未知字段拒绝，枚举封闭，范围检查。合法缺省的字段在格式定义里声明为可选，读取处不补默认值、不强制转换、不静默修复。单条记录违反为 `corrupt_record`，整个存储违反为 `corrupt_state`，按[错误模型](errors.md)带错误 ID。编码器写之前用同一定义校验。
- **默认值属于创建者**：新值（新账户的设置、新 Session 的副本记录）由创建它的代码给全，读取方从不代造缺失的记录或字段。
- **唯一的缓存例外**：checkpoint 增量索引是按定义可重建的缓存，内容非法时按不存在处理并整体重建；其他格式都不这样处理。
- **迁移集中在一处**：格式变化只通过该存储唯一的迁移模块，每一步把版本 N−1 的值变成 N；每个迁移步骤都带一个从上一版本记录升级的测试；除迁移模块外没有任何读取旧格式的代码。

| 存储 | 版本所在 | 格式定义 | 迁移模块 |
|---|---|---|---|
| Control 数据库（含所有 JSON 文档列） | `schema_version` | `control/server/persistence/{baseline,documents,sealed-documents}.ts` | `control/server/persistence/migrations.ts`（见[控制面 · 存储与迁移](control-plane.md#存储与迁移)） |
| `control.json`、`control.key`、`node.json` | 文件内 `version` | `control/server/config-formats.ts`；原生读者 `endpoint/src/persistence/config_formats.hpp` | `control/server/config-migrations.ts`、`endpoint/src/persistence/format_migrations.hpp` |
| `manager.json`、`snapshot-owner.json` | 文件内 `version` | `endpoint/src/persistence/config_formats.hpp` | `endpoint/src/persistence/format_migrations.hpp` |
| Session 数据库 `session.db`（views、事件、下载交接、导航恢复、文件库记录） | `PRAGMA user_version` | `endpoint/src/persistence/session_documents.hpp`、`files/library_records.hpp` | `endpoint/src/persistence/session_migrations.cpp`（迁移前 `VACUUM INTO` 备份、校验、保留与回滚，与 Control 数据库相同） |
| 副本记录 `<id>.copy.json`、变更日志 `.changes`（每行带版本）、checkpoint manifest、增量索引 | 记录内 `version` | `endpoint/src/persistence/checkpoint_formats.hpp` | `endpoint/src/persistence/format_migrations.hpp` |
| 对象存储文件 | 文件头 `RKO2` 与头版本 | `endpoint/src/objects/store.cpp` | 文件头版本 |
| 诊断归档 manifest 与 `.reason` | 文件内版本 | `control/server/diagnostics/formats.ts` | — |

发布与更新的 manifest、载荷、签名与增量有各自的严格协议（见[构建与发布 · 发布](build.md#发布)）。Viewer 只持久化用户 token（Cookie），不使用 localStorage、sessionStorage 或 IndexedDB 保存产品状态。

## 代码结构

```
control/
  shared/          Viewer 与服务端共用的契约：product（产品模型）、errors、security、file-library、diagnostics
  server/
    main.ts, application.ts, config.ts   组合根与配置
    http/          HTTP 路由与 WebSocket 分发表
    auth/          账户、Viewer 锁定与 peer 授权、人脸挑战、密码学
    admin/         管理员的用户管理（创建、凭据重置、停用、转让、停止、转移 Session、删除）
    persistence/   迁移（冻结基线 + 编号步骤）、存储文档解码器、完整性自检与各仓库（账户、安全、workspace、操作收据、关系化文件库）
    recovery/      损坏数据库的凭据恢复（入口 recover-credentials.ts，单独打包）
    cluster/       集群通道（Noise、帧、节点链路）、放置、密钥派生、对象索引、指标、更新包、节点管理、Session 清理队列
    endpoint/      类型化网关（按 Tenant 路由到所在节点）与管理消息类型
    tenants/       每租户运行时状态
    viewers/       Viewer 租约与 RTC 信令
    workspace/     纯命令、操作管线、对账、导航、生命周期与自动回收、页面请求、弹窗、站点策略
    session-import/  会话导入：HPKE 信封、IMAP 拉取、账密校验与写入
    learning/      学习与题库：服务客户端（providers/）、登录、同步与附件下载、题库查询、富文本与媒体代理
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
    files/         文件通道、文件库/拍照任务/导入队列、文件篮与相机 UI、文件预览
    documents/     文档阅读器（虚拟滚动、pdfrender 页面挂载）与 DataChannel 文档源
    learning/      学习与题库 App、登录视图、题目渲染
    ui/            通用虚拟列表
  test/            Control 单元与集成测试
endpoint/
  src/
    main.cpp, options.*, service.*       入口、配置、租户注册与管理分发循环
    cluster/       集群通道库（Noise/CNG、帧、stdio/WebSocket/TCP 载体、node.json 与 build.json）
    management/    ClusterLink（管理链路）与方法表
    objects/       加密对象存储、节点间传输（PeerServer/PeerClient）
    platform/      Windows 作业与进程
    persistence/   Session 存储（session.db、SQLite 封装、格式定义与迁移）、checkpoint 与增量扫描、运行中的版本与快照客户端
    session/       Session（组装）、BrowserRuntime/BrowserRpc、ViewController、导航恢复；
                   MediaPipeline（媒体线程与会话状态）、输出生命周期、呈现、音频、编码器的会话侧接线
    rtc/           PeerController、授权、DataChannel 路由与通道、发件箱、service peer
    media/         媒体核心（endpoint_media 静态库）：CompEngine、Slot、跨租户准入、EncoderSet 与
                   编码器（QSV/NVENC）、适配器、节拍与刷新策略、呈现屏障、追踪
    input/         InputController、序号、校验
    auth/          人脸推理、原始相机帧
    files/         文件库、暂存、照片处理、文件服务（service peer 上的对象文件与 Session 上的原生选择）
    documents/     文档渲染：类型判断、LibreOffice 转 PDF、pdfrender、渲染队列、归档读取
    diagnostics/ util/
  snapshot/        remotekit_snapshot.exe：VSS 卷影副本、按租约读取（由监管者启动）
  updater/         remotekit_node.exe：服务、监管、下载、zstd + tar 解包、自我替换（与管理器共用）
  release/         发布格式：HKDF/AES-GCM、manifest、分片资产、HTTP、更新规划、patch 解码、payload 安装；remotekit_release.exe 发布工具
  manager/         remotekit_control.exe：Control 主机的管理器
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
tools/             构建、补丁、SDK 导出、打包；tools/measure/ 性能测量（含调度实验台 schedlab）；tools/tests/ 工具自身的测试
tests/             e2e/（真实栈产品场景）、integration/（原生 Endpoint/Browser 集成）
```

**媒体核心与会话层**：`endpoint/src/media/` 只依赖 `media/`、`platform/`、`util/`、`protocol/` 与 SDK 头，不知道 Session、授权、RTC 控制器或 `RuntimeOptions`；配置经媒体自己的结构（`CompConfig`、`AdapterConfig`、`EncoderSettings`）传入。CTest `endpoint_media_layer` 扫描该目录的 include，越界即失败。`media::CompEngine` 是每个租户流的 Comp 循环：节拍与源限制、Begin 决策（尾 IDR、呈现刷新、保活、恢复采样、准入优先级）、Poll、AdaptFrame、H264 采样、提交与节拍等待。宿主每轮给它一个不可变的 `CompStream`（peer、接收 level、流作用域、输出是否打开），它经窄接口 `CompHost` 回调布局观察、刷新作用域、失效与首帧里程碑；致命失败以 `CompFailure`（错误 + 呈现失效原因）返回，由宿主处理。`media::EncoderSet` 持有 RTC 编码器回调与编码统计。产品里宿主是 `session/` 的 `MediaPipeline`（授权切换、输出开闭、剪贴板、RTC 事件、统计发布），调度实验台 schedlab 是另一个宿主，两者跑同一份媒体核心代码。

### Viewer 外壳约定

- 样式与组件并置（`foo.tsx` 导入 `foo.css`），全局 `style.css` 只留重置与根布局；外壳颜色取 `theme/tokens.css` 的变量；字面色值只用于数据色（App 主题色、文件类型色）和压在相机画面上的叠层。
- 拖放目标走一个注册表：`useDropTarget(kind, payload)` 返回 `{ref, hovered, replace}`，拖动方按指针位置查询登记的矩形，目标自行渲染高亮；开始屏幕的磁贴拖动与窗口把手拖动共用它。
- 不常用的界面（管理 App、会话导入）按需 `import()` 成独立 chunk，核心包是 MUI + React + 舞台；Vite 的 chunk 告警阈值按核心包实际大小设置，超过即说明核心包在增长。
- 自动化钩子 `window.__remotekitTest` 只在开发构建里由 `main.tsx` 动态导入（`import.meta.env.DEV`），发布产物不含它。

## 文档索引

| 文档 | 内容 |
|---|---|
| [错误模型](errors.md) | 错误码与处理、生产方选择、线上形状、错误 ID、消费方契约与重试单元、错误路径上的状态、执法、Viewer 呈现 |
| [多节点](cluster.md) | 配置文件、集群通道与握手、版本锁定与更新、放置与密钥、对象存储、Session 副本与提交、指标、节点移除 |
| [工作区](workspace.md) | App、Window 与 Space 多任务、开始屏幕与 frecency、安装网页为 App、设置拆分、我的文件的来源与分区 |
| [Control](control-plane.md) | 数据归属、连接、操作与收据、导航、对账、对话框/关闭/弹窗、站点身份、全屏、设置 |
| [页面生命周期](page-lifecycle.md) | 可见性、freeze/discard/unload/restore、自动回收与挂机模式、不确定恢复、导航导出、Profile |
| [渲染](rendering.md) | OSR 输出设备、plane、atlas、Slot/Fence、渲染管道协议、换代、几何 |
| [节奏与补帧](pacing.md) | Comp 节拍、背压、Idle/Wake、尾 IDR、呈现刷新 |
| [编码](encoding.md) | 适配器、EncoderWorker、QSV/NVENC 参数、H.264 level、WebRTC 适配、码控声明、发送 pacing |
| [呈现与音频](presentation.md) | video 平面、布局屏障、RTP 匹配、接收端缓冲、统计口径、音频管线 |
| [输入](input.md) | 身份与门禁、键鼠/IME、触控时钟、客户端手势、惯性、终止账本、坐标 |
| [移动编辑](mobile-editing.md) | 编辑目标、键盘会话、resize 事务 |
| [文件与相机](files-and-camera.md) | 原生文件选择、文件库、文档预览、拍照选帧、文档扫描 |
| [学习与题库](learning.md) | 学习/题库 App、服务登录与登录视图、附件同步与保留、题库查询、富文本与媒体代理 |
| [认证](auth.md) | 账户、锁屏、授权代次、人脸验证 |
| [会话导入](session-import.md) | 部署配置与账户、HPKE 信封、邮箱队列、Control 导入与写入、Android App |
| [兼容性](compatibility.md) | UA/Client Hints、window.chrome、Chrome89 |
| [诊断与测量](diagnostics.md) | 诊断收集、追踪、测量方法 |
| [调优经验](tuning.md) | 被否决的方案与原因 |
| [协议参考](protocols.md) | 各边界的消息与字段 |
| [构建与发布](build.md) | 构建、补丁、SDK、打包、测试 |
