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

所有组件使用同一组错误码（`control/shared/errors.ts`、`endpoint/src/util/error.hpp`、`protocol/control.h` 中的 `ErrorCode`）。**错误码就是处理指令**：调用方只按 code 决定重试、对账、刷新、重新认证或放弃；`message` 只是给人看的文字（用户提示或运维诊断），任何代码都不按 message、`reason` 或 HTTP 状态文字分支。

| code | 调用方怎么做 | 可能已执行 |
|---|---|---|
| `busy` | 短退避（抖动，秒级以内）后原样重试，次数有上限 | 否 |
| `rate_limited` | 等 `retryAfterMs`（缺省用生产方默认值）后重试 | 否 |
| `unavailable` | 指数退避，或等对端/能力恢复的事件后重试 | 否（未送达） |
| `outcome_unknown` | 不重做；用同一操作身份查询或对账。只读请求重新读取即是查询；幂等请求可以用**同一身份**重新提交 | **可能** |
| `conflict` | 刷新状态后重新决定 | 否 |
| `not_found` | 刷新状态，放弃这个请求 | 否 |
| `locked` | 等用户解锁后重试 | 否 |
| `unauthenticated` | 重新登录 | 否 |
| `forbidden` | 显示无权限，不重试 | 否 |
| `limit_exceeded` | 需要用户释放空间/配额或缩小输入；不自动重试 | 否 |
| `invalid_request` | 调用方缺陷：记录，不重试 | 否 |
| `rejected` | 对这个输入、这个构建是最终结果；不重试 | 否 |
| `canceled` | 调用方自己取消；不重试、不提示 | 否 |
| `internal` | 记录并报告，不自动重试；带操作身份的变更按 `outcome_unknown` 对账 | — |

**生产方按处理方式选 code，而不是按"出了什么事"。**
- 暂时饱和（在途槽位、队列、KDF 并发、发送缓冲）是 `busy`；容量被别的租户占满、节点或工具缺失、IO 失败是 `unavailable`；只有用户能自己释放的配额和输入本身超出上限才是 `limit_exceeded`。
- 输入本身无法处理（不支持的格式、损坏、加密文档、转换器在该输入上失败或超出计算预算）是 `rejected`；我们自己的协议/状态不变量被破坏是 `internal`；调用方请求的格式错误才是 `invalid_request`。
- 过期的身份、代次、授权 epoch 是 `conflict`；被替换的授权要求解锁时是 `locked`，要求登录时是 `unauthenticated`。
- **送达证据决定 `unavailable` 与 `outcome_unknown`**：每条传输记录请求是否已写出。写出前失败（连接已关、写失败、本地排队超时）是 `unavailable`；写出后超时、断开、回复格式错误或过大是 `outcome_unknown`。服务端处理已经执行后才发现回复无法编码，同样是 `outcome_unknown`。执行后才发现授权或目标已变化，结果是 `outcome_unknown`，披露另由授权门禁控制。健康探测超时不会成为被阻塞动作的结果：那个动作没有发出，是 `unavailable`。
- 外部服务与工具在边界处按其类型化证据分类一次：HTTP 401 → `unauthenticated`，403 → `forbidden`，404 → `not_found`，429 → `rate_limited`（读取 Retry-After），408/5xx 与读请求的传输失败 → `unavailable`，变更请求发出后的传输失败 → `outcome_unknown`，无法归类的上游失败 → `internal`。

**线上形状**：Native（Endpoint、Browser）与管理通道是 `error:{code, message, reason?, retryAfterMs?, errorId?}`；Control → Viewer 是 `error:{code, message, reason?, retryAfterMs?, errorId?}`（`reason` 只取协议里封闭的 Native 原因枚举，供 Viewer 区分例如 `browser_restarting` 与最终失败）。产品状态里的 Endpoint 错误、学习与会话导入的失败记录同样是带 code/reason/errorId 的结构，不是字符串。
- `retryAfterMs` 只随 `busy`、`rate_limited`、`unavailable` 出现（0…86 400 000 的整数）；其他 code 带上它会在校验时被丢弃。提示只调整允许重试时的等待，永远不会让不可重试的 code 变得可以重试。HTTP 同时设置 `Retry-After` 头，但客户端只读 JSON。
- Native（Endpoint、Browser）的 `message` 是英文运维诊断；需要向用户区分的情形（如加密文档与损坏文档、单文件过大与配额已满）带一个 `reason`，取自协议里封闭的枚举，只用于选择展示文字。Control 是展示边界：把 Native 错误转换成 Viewer 用的中文 `message`（按 `reason`，否则按 code 的通用句），原始诊断进日志和诊断包。Viewer 直接显示 `message`；code 的通用句只有 `shared/errors.ts` 一张表。Endpoint 经 DataChannel 直接回复 Viewer 的请求（文件服务、文档阅读）不经过 Control，回复里同样带 Native 的错误形状；这条路径的展示边界是 Viewer 的 DataChannel 解码处。两处用同一个转换（`control/shared/errors.ts` 的 `nativeError` 与原因文字表），英文诊断进 `detail`。
- Browser 控制回复：`{version:1, id, ok:false, error:{code, message, reason?, retryAfterMs?}}`，code 用名称字符串。SDK 的类型化调用把 Browser 的应用错误原样交给调用方，不折叠成传输状态；SDK 传输状态区分"未发出"（通道已关、写失败）与"已发出、结果未知"（超时、发出后断开、回复无效）。
- 操作收据的失败是 `status:'failed'` 加结构化 `error:{code, message}`；`expired`（generation 已轮换）是 `failed` + `conflict`。Viewer 按收据里的 code 处理，与直接回复的错误走同一套处理。
- 每个边界只转换一次；中途转发保留 code、`reason`、`retryAfterMs` 与 `errorId`，包装时原始异常放进 `cause`，不替换。

**错误 ID**：`internal`、`outcome_unknown`、`unavailable` 在第一次离开产生它的进程时获得一个 ID（Control `c-`、Endpoint `e-`、Viewer `v-`，后接 10 位十六进制），同时写一条带完整诊断（code、reason、英文诊断、OS 错误码、cause 链与栈）的结构化日志；之后各层原样转发，不再生成新 ID。Control 转发 Endpoint 错误时沿用 `e-` ID，并在自己的日志里记一条同 ID 的记录。只在浏览器里发生的失败（解码、页面挂载、摄像头、呈现协议）由 Viewer 自己生成 `v-` ID 并立即显示，再经 WS `client.error{errorId, context, error}` 报给 Control（内存队列最多 50 条，在线时发送），Control 用同一 ID 记一条 `viewer.error`。管理 App → 诊断按 ID 查找：`c-`/`v-` 查 Control 日志，`e-` 经 `node.logs.search` 查各节点的 `endpoint.log`。其余 code 是调用方能自己处理的结果，不分配 ID。

**处理规则集中在一处**：`control/shared/error-policy.ts` 与 `endpoint/src/util/error_policy.hpp` 把 code 映射为处理方式和默认等待（`busy` 250ms 起翻倍、上限 5 秒；`unavailable` 1 秒起翻倍、上限 5 分钟；`rate_limited` 无提示时 30 秒）。后台调度（文档转换、学习附件下载、会话导入、下载导入、更新器）都从这里取策略：只有 `busy`、`rate_limited`、`unavailable` 自动重试，`outcome_unknown` 先对账，其余 code 记录为最终结果，等用户操作或构建、输入、配额变化后再评估。持久化的失败记录保存 code、诊断、`retry_at` 与构建 ID；`rejected`、`internal` 只对产生它的构建有效。

- Endpoint 的 Session 状态错误用 `reason` 说明原因：`browser_crashed`（Browser 非正常退出）、`browser_restarting`（替换中）、`output_failed`（GPU 输出无法继续），错误码为 `unavailable`；在途操作仍按 `outcome_unknown` 处理。内部原因（例如 render generation 未决的 GPU 工作）只进日志和诊断。
- 本地持久状态损坏（读得到但解不开）与读不到（IO 失败）是两件事：前者是 `internal` + `reason: corrupt_state`（Endpoint Session 数据）或 `corrupt_record`（Control 存储文档），不自动重试、不改写数据；后者是 `unavailable`，数据原样保留。"读不到"从不当作"不存在"。
- 意外异常在请求边界和线程入口被捕获：请求返回 `internal`，线程入口把所属组件标记为失败，而不是终止进程。只在校验调用方请求时才把解析异常归为 `invalid_request`；解析对端回复或本地存储时的异常是 `internal`（已送达的请求则是 `outcome_unknown`）。
- 不确定的 GPU 工作、编码任务和原生回调不靠超时"放弃"：资源保留到有证据为止，必要时保留到进程结束。
- 控制 RPC 超时只使本次结果成为 `outcome_unknown`，不关闭 SDK 通道、不清除 Endpoint 的控制句柄。SDK 使用每通道请求 ID 匹配回复，丢弃迟到回复并释放其 Mojo 附件与本地资源句柄；后续健康检查有界等待。只有管道确实断开或进程退出才允许替换 Browser，连续失败最多启动三次，按 1/2/4 秒退避，健康运行一分钟后恢复额度。拒绝重启的错误附带最近一次真实失败（进程退出码及其含义、控制管道超时或 `output.status` 错误）和 Session 目录下 `browser.log` 的路径；Endpoint 自己终止的进程（退出码 0）不算失败。GPU 输出启动失败通过现有 Session 错误投影显示在标签页/工作区。

### Viewer 怎样呈现失败

按"谁能处理"而不是按错误码堆横幅，规则只在 `control/client/failures/` 一处（`presentFailure(error, context)`）：

| 类 | 谁处理 | 典型 code / reason | 呈现 |
|---|---|---|---|
| 正在恢复 | 系统 | `busy`、`rate_limited`、`unavailable`、确认中的 `outcome_unknown`、`browser_restarting`/`browser_crashed`、连接中断 | 受影响的东西上显示进行中的状态（"正在重新连接…"），没有错误措辞、没有重试按钮；重试在后台自动进行，预算用完后放慢但不停止。1.5 秒内恢复的不显示；20 秒后改用"仍在…/暂时无法…，恢复后自动继续"；连接类 30 秒后进入平静的持续状态 |
| 用户能处理 | 用户 | `unauthenticated`、`locked`、容量与输入超限、带文档/照片原因的 `rejected`、用户输入导致的 `invalid_request`、自己操作的目标已变化（`conflict`/`not_found`，先静默刷新） | 只给一个具体动作（登录、解锁、管理窗口、换一个文件、重新拍摄……）。"空间不足 / 打开我的文件"只用于真正的存储、目录与文件篮容量 |
| 谁都处理不了 | 管理员 | `internal`、`forbidden`、`corrupt_record`/`corrupt_state`、非输入导致的 `invalid_request` | 说明什么没有发生、东西现在是什么状态，另起一行显示可复制的错误 ID；没有重试 |
| 静默 | — | `canceled` | 不显示 |

位置按作用域：输入框下（field）、出问题的那个条目上（item：文件卡、上传/拍照任务、附件行、标签页）、所在的窗口/面板（surface：活动内容上是顶部居中的浮动小条，只覆盖、不挤压——挤压会改变远端视口尺寸）、全局通知（只放不属于任何可见界面的事：Control 连接、窗口已关闭的后台任务；右下角，按 key 去重，最多 3 条）、全屏（登录、锁定、连接被接管）。错误一路保持类型化直到呈现处，只有 `presentFailure` 生成文字。

## 持久化格式

每种落盘格式属于一个存储，有显式版本和唯一一对解码器与编码器（同一份格式定义）。

- **解码严格**：形状与类型精确，必需字段必须存在，未知字段拒绝，枚举封闭，范围检查。合法缺省的字段在格式定义里声明为可选，读取处不补默认值、不强制转换、不静默修复。单条记录违反为 `corrupt_record`，整个存储违反为 `corrupt_state`，按[错误模型](#错误模型)带错误 ID。编码器写之前用同一定义校验。
- **默认值属于创建者**：新值（新账户的设置、新 Session 的副本记录）由创建它的代码给全，读取方从不代造缺失的记录或字段。
- **唯一的缓存例外**：checkpoint 增量索引是按定义可重建的缓存，内容非法时按不存在处理并整体重建；其他格式都不这样处理。
- **迁移集中在一处**：格式变化只通过该存储唯一的迁移模块，每一步把版本 N−1 的值变成 N；当前每个列表都是空的，也没有任何读取旧格式的代码。

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
    session/       Session（组装）、BrowserRuntime/BrowserRpc、ViewController、导航恢复
    rtc/           PeerController、授权、DataChannel 路由与通道、发件箱、service peer
    media/         Comp 节拍、Slot、输出、媒体管线、呈现屏障、编码器（QSV/NVENC）、适配器、音频、追踪
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
