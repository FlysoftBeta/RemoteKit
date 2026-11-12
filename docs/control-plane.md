# Control：产品状态、操作与对账

Control 是产品状态的唯一真相：用户、Window/Tab、地址意图、设置、站点偏好、文件目录和操作收据都只在 Control 的 SQLite 里。Endpoint 和 Browser 拥有"执行"：进程、WebContents、恢复数据、GPU 资源。Control 通过对账让执行趋向期望。Control 同时管理多个 Endpoint 节点，每个 Tenant 的请求路由到它被放置的节点（见[多节点](cluster.md)）。

## 存储与迁移

**唯一的迁移路径**：`persistence/schema.ts` 只有一种到达当前版本（17）的方式：空库先执行冻结的 v12 基线（`baseline-v12.ts`，永不修改），再依次执行 `migrations.ts` 中的编号步骤 13…17；已有库从自己的版本继续。所有建表、改表都在基线或某个编号步骤里，正常启动不执行任何 DDL。低于 12、高于当前版本、或有表却没有 `schema_version` 的库拒绝启动（`unsupported_schema`）。

**迁移前备份**：已有库需要迁移时，先 `VACUUM INTO` 到数据库所在目录的 `backups/control-v<from>-to-v<to>-<buildId>-<UTC>.db`，以只读方式打开做 `quick_check` 并核对版本，通过后才迁移；只保留最新 3 份。全部步骤与版本更新在一个事务里，任一步失败整体回滚，错误带步骤编号与原始异常。迁移后跑 `integrity_check`。备份不含 `.key`：静态密钥从不改变，恢复时把备份复制回 `control.db`（删除 `-wal`/`-shm`）即可。迁移需要静态密钥时（v17 要解开学习账户会话）密钥缺失或不符就失败并回滚，不猜。

**存储的文档有类型**：SQLite 里不透明的 JSON 值（Tab、Space、窗口状态、设置、站点偏好、App、收藏、操作收据与动作、认证设置、文件库条目与分区、选择清单、会话导入各列、加密的学习会话与人脸模板等）只经 `persistence/codec.ts` 的解码器读写：键集合封闭、类型固定，解码器的推断类型必须可赋给 `shared/` 里的类型，漂移是编译错误。`persistence/` 之外不解析也不序列化存储数据。解码失败是 `internal` + `reason: corrupt_record`（`detail` 指出表、键、路径与期望），只让需要这一行的请求失败，数据原样保留——读路径从不补默认值、不删除、不改写；缺失的字段只在迁移步骤里显式回填（例如 v17 补齐认证设置、选择清单的 `limits`，把旧动作载荷改成当前形状，把缺少 `device` 的新教育会话清除并标为 `expired`）。

**启动自检**：每次打开都运行 `quick_check`（失败拒绝启动）、`foreign_key_check`，并把每一行存储文档解码一遍；外键与解码问题逐条记 `store.integrity_problem`（error），保留运行，结果（最多 200 条）显示在管理 App → 概览。

**迁移测试**：`control/test/fixtures/control-v12.sql`…`v16.sql` 是由各版本历史代码真实生成的库（文件头记录来源 commit），每个文档列都有当时代码写过的形状。测试把每个 fixture 迁移到当前版本：备份存在且可用、自检没有问题、规范化后的 schema 与新建库完全一致。新增迁移必须新增对应版本的 fixture。

**文件库是关系表**：`library_state`（revision、篮子目标分区）、`library_entries`（每条目一行，条目文档经解码器）、`library_entry_objects`（条目引用的对象：当前/原始资产、照片候选，供 GC 与配额直接查询）、`library_partitions`、`library_basket`（有序）、`library_excluded_sources`。业务逻辑仍在 `LibrarySnapshot` 对象上修改，`save()` 只写与已读行不同的部分，一次变更一个事务。

## 数据归属

| 所有者 | 数据 |
|---|---|
| Control 配置文件与身份 | HTTP 监听、存储位置、每个节点的接入方式/网络/放置上限/媒体调优、配额；`control.key` 与各节点的 `node.json`（节点身份） |
| Control SQLite | 账户（含最近登录、停用时间）、口令/PIN hash、token hash、人脸模板（加密）；workspace（Space、Window、Tab、active 关系、地址意图、恢复阶段、窗口视图状态）；已安装 App 与图标；收藏；使用记录；设置；站点偏好；操作收据；弹窗收养收据；文件目录、分组、篮子顺序、选择事务；剪贴板；会话放置与加密的 Tenant 密钥；对象索引与副本；checkpoint；被移除的节点；待各节点清理的已删除 Session |
| Control 内存 | Viewer 租约、实际内容区尺寸、页面对话框/全屏/文件请求的临时投影、节点连接状态与指标、Memory Saver 计时 |
| Endpoint Session | Browser 进程、Session 目录里的 `session.db`（期望 view 配置的执行副本、自然关闭事件、导航恢复数据、下载导入交接、文件库资产元数据/草稿/选择回执/派生映射，见[多节点 · Session 存储](cluster.md#session-存储)）、站点偏好（只在内存，由 Control 推送）与 UA、媒体策略的运行缓存、文件草稿与暂存、媒体/输入/GPU 资源、内存中的 Profile 密钥与集群对象密钥 |
| Endpoint 节点 | 加密对象（文件库资产、缩略图、checkpoint 块）、Session 热/冷副本 |
| Browser | Profile 存储（cookie、缓存）、WebContents、history/PageState、sessionStorage 关联、页面回调与各种代次 |
| Client | 服务端状态副本、地址草稿、待确认操作的内存投影、媒体缓冲；持久项只有 HttpOnly token |

一个 User 对应一个 workspace，即一个 Tenant/Session。workspace 由 App、Window 与 Space 组成（见[工作区](workspace.md)）：Window 承载一个 App，browser 与网页 App 窗口通过 `windowId` 拥有 Tab（最多 32），Window 最多 16 个，每个窗口组（Space）并排 1–3 个 Window。Tab 的 `kind` 为 `remote | start`：start（简易起始页）在 Viewer 本地渲染，不产生远端渲染需求，但 Session 的数据通道仍在，首次导航直接创建远端页面，不插入伪造的 about:blank 历史。files 与 settings 窗口完全在 Viewer 本地渲染。

## 连接

**Viewer ↔ Control**：WebSocket `/api/socket`，承载认证状态、产品快照、设置与文件目录等元数据服务、视口观测、RTC 信令、操作收据查询。

**Viewer ↔ Endpoint**：WebRTC。视频、音频、输入、产品动作、文件字节、照片分析都走它。产品动作经 DataChannel 到 Endpoint，再由 Endpoint 经管理连接转交 Control 的唯一提交器（见下文"操作"）。

**Control ↔ Endpoint**：集群通道（Noise 握手 + AES-GCM，见[多节点 · 集群通道](cluster.md#集群通道)）上的 JSON 请求/回复/事件。本地节点由 Control 启动，走 stdio；远端节点主动连接 `/api/node`（WebSocket）。请求超时 20 秒，JSON 消息上限 1MiB，5 秒握手期限，每节点最多 256 个在途请求。

- `endpointIncarnation` 是 Endpoint 进程身份，跨 socket 重连保持；`connectionEpoch` 只代表一次管理连接。同一进程重连时，Control 保留 Viewer、RTC 租约和媒体代次，只做快照对账；只有进程真正被替换才整体失效。旧连接的回复不能完成新连接的请求，未知结果的变更不盲目重放。
- 管理断线不销毁已有 Session 与 RTC，但立即撤销 Endpoint 侧的产品授权；恢复后以更高的授权代次重新授权（见[认证](auth.md)）。
- Control 与 Endpoint 不共享文件系统、时钟或进程。

**信令**：只用 trickle ICE。offer 不等完整候选收集，Endpoint 接受后异步发 `rtc.signal`（answer、candidate、complete、error），Control 按 Tenant、Viewer 租约、`connectionId`、`attemptId` 路由给对应 Viewer。早到的候选有界排队；候选不排在等待 answer 的 Tenant 队列后面，其他 Tenant 也不等这次协商；接管、退出或取消清除旧绑定。接收能力探测在页面启动时预热并缓存，鉴权不等待探测。

**重建连接**：Viewer 丢弃一次 RTC 尝试时本地立即关闭 peer，并尽力发一次 `rtc.close`；这个请求失败（例如 WebSocket 当时已断）只记入诊断，不阻塞下一次建立。"同一 Viewer 最多一个活 peer"由服务端保证：Control 处理新 offer 时先关闭该 Tenant 上一条连接（含断开但未清理的 peer），再开始新的尝试；客户端每个异步步骤（createOffer、setLocalDescription、answer、setRemoteDescription）之后核对 attempt，迟到的结果直接丢弃。曾经客户端把 `rtc.close` 带重试的 Promise 当作下一次建立的屏障，断网时它一旦失败就永久保持 rejected，之后每次重试都卡在这里，只有刷新页面才能恢复。

**Viewer 租约**：每个账户同时只有一个活跃 Viewer。新连接接管旧连接，旧端收到 `lease revoked` 后停止媒体，不自动争抢。租约绑定 token 身份：注销某个 token 只撤销该 token 的租约，不会踢掉另一个 token 的新 Viewer（曾经按 Tenant 选择要踢的 Viewer，导致旧 token 注销踢掉了新登录）。排队中的工作在执行时重新校验租约和认证。

## 操作

产品交互既要即时反馈，又不能出现第二份产品真相。

```
Client  生成 operationId（UUID）+ operationGeneration，本地显示 pending 投影
        → DC product.action{version:1, operationId, operationGeneration, action}
Endpoint 校验当前 peer 与授权代次 → 管理事件 client.action → Control
Control  每 Tenant 串行：
         校验 connection/Viewer 租约
         → 写入收据 accepted（同 ID 同 payload：直接返回原收据；同 ID 不同 payload：冲突）
         → 分配 Tenant 内单调的 operationSequence
         → applying → 执行（改 workspace + 调用 Endpoint）
         → workspace 变更与收据在同一个 SQLite 事务中提交
         → rtc.actionResult 回给 Endpoint → DC product.result 回给 Client
         → 新的 workspace 快照经 WS 推送
```

收据状态：`accepted → applying → committed | failed | unknown`。`failed` 带结构化 `error:{code, message}`，调用方按 code 处理（见[错误模型](architecture.md#错误模型)）；generation 已轮换的旧收据是 `failed` + `conflict`。

- **unknown** 表示可能已经执行。Endpoint 转发后 15 秒没有结果、或 Native 调用超时，都是 unknown；把超时当作失败会让用户用新 ID 重做，造成重复副作用。unknown 通过 `operation.status` 查询收敛，从不用新 ID 重做。Endpoint 在转发前就失败的操作是 `failed` + `unavailable`，可以原样重试。
- 收据状态由错误码决定，不由异常类型决定：`outcome_unknown`（以及已受理变更的 `internal`）→ unknown；其余 code 都是确定没有执行 → failed，code 原样保存在收据里。
- 导航和带确认的关闭在获得明确的 Native 证据前保持 applying。
- 只改产品数据的操作可以先 committed，而 Endpoint 应用仍在 pending（例如站点偏好）。
- Control 重启时，持久化的 accepted/applying 收据变为 unknown。每 Tenant 最多 4096 条收据；只有在没有未决执行时才轮换 generation；快照携带最近 64 条。
- `unknown + resolved` 表示执行结果仍未知，但其目标已退役（例如 Tab 已关闭、Browser 已替换），不再阻塞。

**快照是权威**：WS 快照携带 `serverIncarnation` 和单调的 `snapshotSequence`（独立于 workspace.revision）。只有内容变化时序号才前进、快照才推送；不改变任何东西的 `viewer.viewport` 不产生新快照，Viewer 也不重发与上次确认相同的视口，收到内容相同的权威快照时不替换自己的快照对象。较旧的运行态快照不能覆盖较新的对话框、Endpoint 或 ready 观测。DC 回来的收据只更新对应 pending 操作的资格，不直接改 workspace。committed 的投影保留到权威 workspace revision 追上收据 revision。新 Viewer 不继承旧端的 pending 投影；已受理的旧操作可以完成，但迟到的结果不投给新 peer。UI 只在 committed 时显示"已保存"。

历史问题：创建 Window 的回复丢失后用户重试，会因为传输层请求 ID 只在连接内有效而创建出第二个 Window——加长超时解决不了重复副作用，稳定的操作 ID 和可查询的 unknown 才能。导航曾在 Control 保存地址意图之前就在 Endpoint 执行，崩溃窗口内执行与产品状态不一致——现在意图在外部执行之前持久化，之后的结算绑定到 Native 导航身份。

## 标签页顺序

workspace 只有一份全局 Tab 顺序，每个 Window 的标签栏是它按 `windowId` 过滤的结果，所以不需要单独的位置字段。`tab.move{tabId, windowId, index?}` 同时负责同窗口排序和移到其他 Window：`index` 是移除自身后在目标 Window 内的位置，省略时排到末尾；服务端命令和客户端 pending 投影共用 `placeTab`，被移动的 Tab 成为目标 Window 的活动 Tab。

Viewer 里鼠标/触控笔移动超过 5px 开始拖拽，触摸需要长按 400ms，这样横向滑动仍然滚动标签栏；长按后不移动就松开会打开标签页菜单。拖拽状态是页面内唯一的一份，所以可以拖进并排的另一个 Window 的标签栏。落点按各 Tab 的 `offsetLeft` 计算（不受拖拽动画的 transform 影响），靠近边缘时滚动标签栏；Esc 取消。键盘用 Ctrl+Shift+←/→ 移动当前 Tab。

## 导航

RPC 受理、导航开始、文档提交、资源加载完成是不同结果。

- Browser 为每个产品命令绑定真实的 Chromium `NavigationHandle`：URL 导航用 `LoadURLWithParamsForResult` 的句柄；history 操作收集 controller 返回的所有句柄（包括只影响 iframe 的）；reload 绑定 void API 创建的主 frame `NavigationRequest`；redirect 更新已绑定的记录。
- 导航消息携带 `operationId`、`operationGeneration`（各 ≤128 字节）和非零 u64 十进制 `operationSequence`。快照的 `navigationOperations` 报告 accepted/started/committed/cancelled/failed/superseded、navigationId、URL/错误和是否提交了文档。
- 新命令取代旧的 pending；终态记录不能被迟到回调改写。`DidFinishNavigation` 结算真实的提交/错误/中止；beforeunload 等路径可能销毁句柄却不回调 finish，由 50ms 定时器检查失效的 WeakPtr。
- 每个 view 最多 128 条未确认记录，满了拒绝新身份，不淘汰 pending 或终态证据。Control 持久化结果后发 `view.navigation.ack`，ACK 过的身份仍受 sequence 高水位保护。
- `loading=false` 不是导航回执：它可能描述旧文档、取消或只影响 iframe 的操作。
- 网络失败也可能提交一个 Chromium 错误文档：收据 failed 与 `documentCommitted=true` 同时成立，Tab 保持 remote 并显示真实失败 URL。只有未提交文档的失败或取消才恢复到之前的本地页（start/files）。错误页是转义后的静态 HTML（失败 URL、网络错误、提示用工具栏刷新），没有脚本、外部资源或隐藏重试。
- `stop` 有自己的收据，不替换 Tab 当前的导航 owner 和之前的 kind/URL。首次远端导航在提交前被停止时，原 owner 回滚到 start 并清除 loading；已有的 Native 执行实例用 `requireRunning` 隐藏，而不是重新 ensure。
- POST reload 明确返回 `reload_post_confirmation_unsupported`；导航恢复也拒绝 POST 历史。不悄悄把请求转成 GET，也不重放上传。
- 地址栏与起始页共用 `resolveNavigation`：去空白，允许真实的 about:blank 和合法 HTTP(S)，识别裸域名/localhost/IP 主机，其他文本交给保存的搜索引擎（Google 默认，另有 Bing、DuckDuckGo、Baidu，`encodeURIComponent` 编码），不执行任意 scheme。输入上限 8192 个 UTF-16 单元，规范化/编码后的 URL 另限 8192 个 UTF-8 字节（Unicode 展开曾让合法长度的输入生成巨大的快照），超限在记录意图前拒绝而不是截断。`tab.create` 的 `query`（页面上下文菜单的"搜索"）不经过地址识别，总是生成搜索 URL，与 `url` 互斥，长度限制相同。组合输入中（isComposing / 229）的回车不提交。

## 对账

Control 约每 1.5 秒对每个活跃 Tenant 做一次维护（不同 Tenant 互不阻塞）：

1. **在线**：先下发完整站点规则和媒体策略，再 `session.ensure`，再恢复或创建需要的 WebView。只在值变化时 `view.configure`，避免反复打断输出和输入。未确认的导航不会被普通 ensure 重复执行。
2. **恢复**：Endpoint 优先使用自己的内部导航恢复数据；没有可用数据时才用 Control 保存的有限地址信息。恢复由 Endpoint 的定时状态机分步推进，`session.ensure` 立即返回 accepted，不逐页等待导航。恢复期间 Control 保留产品 URL 与导航意图，显示 restoring，不把中间的 about:blank 写回产品状态。
3. **离线维护**：`session.snapshot` 只观察，不启动 Browser；Browser 已退出时返回 `running:false`。离线时不补建缺失的 WebView。对仍在运行的页面做隐藏/回收时带 `requireRunning`，避免快照之后进程退出、维护请求又把 Browser 拉起来。
4. **缺失对象**：用有限的产品信息重建，并清理 orphan。自然关闭（`view.closed` 持久事件）与崩溃丢失用不同证据处理：缺页本身不是关闭证据。

## 页面对话框、关闭与弹窗

- alert/confirm/prompt 和导航 beforeunload 是临时的 `pageDialogs`。对话框身份绑定不可复用的 browserIncarnation、view、instance、document 和原生请求号；公开 ID 是完整身份的 hash，原生请求号只在服务端保存（PID 和本地计数器会重复）。回复前刷新快照校验，Endpoint 只发给同一个运行实例，Browser 执行点再校验一次。可见 activeTab 的请求用 MUI Dialog 处理，后台 Tab 显示待处理标记。
- 关闭 Tab 的 beforeunload 走 pendingClose 流程（避免重复对话框）：`无 → 等待 prompt → 等待用户 → 等待关闭证据`。取消不删 Tab；离线或 Browser 替换时取消旧的关闭意图并保留 Tab。只有明确的关闭回复、状态或持久事件才删除 Tab。
- **自然关闭**（`window.close`）是可重放的持久事件：Browser 产生 `view.closed`；Endpoint 先持久化事件和期望 view 移除，再 ACK Browser；Control 先持久化产品删除，再 ACK Endpoint。重放幂等。未确认事件达到 256 时拒绝新建 view，不静默丢事件。Browser 删除完整墓碑后保留本进程的紧凑关闭 ID 集合，防止旧 ID 复活。
- **弹窗**：`window.open` 产生的真实 WebContents 先进入 pending 容器（不进入普通 orphan 集合），记录 provisionalId、opener view、disposition、URL、是否有用户手势。Control 先持久化产品 Tab/Window 和分配的 viewId 以及收养收据，再 `view.adopt` 绑定这个真实对象，保留 opener 和 sessionStorage。前台/后台 Tab 进入 opener 所在 Window；new window/popup 产生新 Window。pending 上限 16、30 秒过期；过期或已关闭的对象不会按 URL 重新打开来冒充收养成功——重新打开会丢失 opener/WindowProxy 和克隆的 sessionStorage。无用户手势的弹窗被阻止。真实的 about:blank 弹窗保持 remote（可以被 document.write），不会被识别成起始页。

## 站点身份与全屏

- **平板版网站**：按 origin 保存，切换 Android 平板身份（`mobile=false`），不改变 viewport、DPR、触控或指针特征。首次导航、redirect、history、reload 和 restore 在请求之前选择身份，子 frame 继承页面身份。只有 UA 实际变化才需要确认 Browser 已应用并刷新当前页，`beforeunload` 可以取消这次刷新。其他同站点页面下次导航生效。
- **网站设置**：Control 按 origin 持有兼容性选项、持久权限决定和协议处理器。`session.sitePreferences` 将 UA、权限和协议处理规则同步给 Endpoint 与 Browser。权限或协议处理器的持久决定先入库并应用，再按原请求身份回复页面。仅本次允许与关闭提示不写入设置，HTTP 登录凭据只经当次回复传递。
- **Viewer 全屏**：设置"打开或激活时全屏"（默认关闭，Control 保存）。打开或回到前台时尝试 Fullscreen API；浏览器要求用户手势而拒绝时，等下一次可信的非 Esc 交互重试；用户主动退出后本次激活不再抢回。
- **网页全屏**：网页自己的 Fullscreen API 只让该页面内容铺满整个 Viewer，隐藏外壳与其他 Window，不调用本地 Fullscreen API。状态绑定 browserIncarnation、instance、document，作为临时 `pageFullscreen` 投影，不写数据库。网页自己退出、悬浮退出按钮（×）、Esc 都可结束；显式退出携带当前目标身份，旧文档的退出不影响新页面。导航、关页、锁定、断线清除投影；Native 状态随约 1.5 秒的周期对账同步。
- **窗口全屏**：浏览器与网页 App 窗口的"更多 → 全屏"让该窗口的当前页面按网页全屏的方式铺满 Viewer（隐藏外壳、标签栏与其他窗口，只有它可见），Viewer 尚未全屏时同时请求 Fullscreen API（菜单点击就是用户手势）。这是 Viewer 本地的显示模式（`client/app/window-fullscreen.ts`），不进 Control：网页自己的全屏优先；悬浮退出按钮（×）、退出本地 Fullscreen（若是它请求的）、窗口离开当前窗口组或被关闭都会结束它。它不拦截 Esc，Esc 仍交给页面。

## 账户与管理 App

没有公开注册。空库时登录页变为"创建管理员账户"（`/api/auth/setup`），第一个账户成为管理员；之后 setup 返回 forbidden，并发的两次 setup 由提交事务内的再次检查保证只有一个成功。其余账户都由管理员在"管理 App → 用户"中用用户名和初始密码创建（可随机生成），登录页只提供登录。管理员唯一（`users` 上的部分唯一索引），可以转让，转让后原管理员立即失去权限。

管理是一个内置 App（`appId: 'admin'`），像设置一样是单例、在 Window 里本地渲染，只出现在管理员的开始屏幕（以及管理员空工作区的入口）。`window.open{appId:'admin'}` 在操作管线入口按数据库里的管理员身份检查，非管理员得到 forbidden。转让管理员时，Control 在返回前关闭原管理员工作区里的管理窗口。窗口宽度不足 640px 时分区导航变为顶部标签；当前分区是窗口 `state` 的 `section`。每个分区在可见时每 5–15 秒刷新。所有 `admin.*` 方法都要求当前未锁定的产品租约，并在服务端按数据库里的管理员身份检查；参数用用户名指定目标，不能携带 tenant/user 字段，也不能对自己执行停用、删除、强制下线等操作。

| 分区 | 内容与操作 |
|---|---|
| 概览 | 节点在线数、用户与在线数、运行中/休眠的会话、对象总量；Control 与发布包版本；节点离线、版本不一致、副本不足、待清理会话等提示 |
| 用户 | 在线状态、会话位置、存储用量（设置了配额时显示占比）、最近登录。新建；重置密码（撤销该用户所有 token 并断开 Viewer）；清除 PIN 与人脸；强制下线；立即休眠（用户离线且无阻塞项时，跳过 Memory Saver 与空闲时间条件）；重置浏览器数据（仅已休眠：删除放置与全部 checkpoint，下次从空白 Profile 按 URL 恢复标签页，"我的文件"与设置保留）；停用/启用（停用账户的 token 不再有效，登录返回"账户已停用"）；转让管理员；删除用户（输入用户名确认） |
| 公告 | 发布、编辑、删除；每条显示发布/修改时间与"已读/启用用户数"。编辑可选"重新提醒已读的用户" |
| 节点 | 见[多节点 · 管理 App](cluster.md#管理-app) |
| 存储 | 对象数、内容与单副本占用、副本不足、孤立副本与待清理会话；每个用户的存储用量（及配额）、文件数与最近 checkpoint |
| 诊断 | 服务端保存的诊断包（ID、用户、时间、大小、结束原因），下载与删除 |

**删除用户**是彻底删除：先停用并撤销 token、断开 Viewer；在该 Tenant 的串行队列里，一个事务删除账户、安全设置、公告读记录、工作区、设置、站点偏好、操作与弹窗收据、文件目录与选择事务、放置、checkpoint 与对象索引。对象副本转为首次发现时间为 0 的孤立副本，下一次对象维护即向持有它的节点发送 `object.delete`；离线节点在下次连接对账时清理。Session 本身按节点排队到 `session_deletions`（每个配置的节点一行），节点就绪时发送 `session.delete`，成功后删除该行，因此离线节点重新上线后也会删掉其热/冷副本。最后删除该用户的诊断包目录（若仍在采集，先结束采集）。每张表只由其所有者删除：账户、安全、工作区、操作、文件目录各自的 repository，Placement 删除放置与 checkpoint，对象索引删除对象，`SessionPurge` 负责节点上的 Session 数据。

**公告**是全局的，由管理员发布给所有用户。`announcements(id, title, body, published_at, updated_at)` 保存公告，`announcement_reads(announcement_id, user_id)` 记录谁已读；标题至多 100 字、内容至多 5000 字纯文本（Viewer 保留换行，不解析 HTML/链接）。每个用户的 `ProductState.announcements` 是全部公告按发布时间倒序、带本人的 `read` 标记；发布、编辑、删除后向所有在线 Viewer 推送新快照。Viewer 在产品就绪且开始屏幕未打开时，用对话框从最早的未读公告起逐条显示，关闭即 WS `announcement.read{id}`（幂等）；设置 → 公告列出全部公告。读记录只属于一次发布：编辑时选择重新提醒会更新 `published_at` 并清空该公告的读记录，否则保留。删除用户时删除其读记录；已读统计只计启用的用户。

**诊断下载**是普通 HTTP GET，不能证明 Viewer 已解锁，所以由 `admin.downloadDiagnostic` 在已解锁的租约上签发 60 秒有效、只能使用一次的票据，下载路由 `GET /api/admin/diagnostics/<票据>` 另外要求管理员 cookie。

## 剪贴板

Control 保存每用户一份最新剪贴板，Browser 是本地粘贴缓存；历史片段也保存在 Control，不进入对象存储。Browser 重启、休眠或 Session 换节点后先回填再创建 view。

- 最新值为纯文本（≤1 MiB UTF-8）与 HTML（≤2 MiB），有单调 revision。超限保留旧值，只报告大小；图片等无文本格式记录为空。正文不进入日志、追踪、诊断或错误消息。
- `ClipboardBridge` 观察页面、脚本与 Browser 菜单写入，递增共享映射的 `clipboard_sequence`。Endpoint 按序号取 `clipboard.read`，发 `clipboard.changed {viewId?,excludeFromHistory,text,html,…}`；Control 按当前 Session/Tenant 串行接受，更新 revision 和片段，再向已授权 Viewer 推送 `{type:clipboard,revision,text}`。
- 写入来源由 Chromium ClipboardEndpoint 的 WebContents 映射到 view/tab/app，记录页面 URL 与可用标题；无法归属时为 browser App。Chromium `kNoDisplay / kNoLocalClipboardHistory` 由补丁 `0019` 保留，`excludeFromHistory` 阻止片段记录，最新剪贴板仍正常更新。
- `session.open / session.ensure` 携带 `{revision,text,html}`，只在 Browser incarnation 需要时回填。在线的 `clipboard.set {text}` 与 `library.copySnippet {id}` 通过独立 Endpoint `clipboard.write` 更新缓存，不被后续 ensure 的旧 seed 覆盖。Browser 用明确作用域抑制回填上报，不使用计时器。
- Viewer 用 `clipboard.get {}` 恢复应用缓存，返回 `{revision,text}`；本地选择操作不依赖设备同步开关。`clipboard.set` 接受设备或本地选择写入，返回 `{revision}`。`library.snippet {id}` 按 Tenant 读取全文；复制片段返回 `{revision,text}`，保留原始来源。
- 片段只记录非空纯文本，按用户+SHA-256 去重，重复复制更新时间和来源。`library_snippets(entry_id,tenant,text,hash,origin,copied_at)` 保存正文；目录带 `kind:snippet`、字节大小和首个非空行的 ≤200 字符预览。未整理保留最新 200 条，移入分区的保留；排除 `clipboard/''` 来源停止收集，清除来源删除未整理片段，已整理的保留。
- “与本机剪贴板同步”（`clipboardSync`）默认开启。远端新值写设备剪贴板，未聚焦时只保留最新待写值；设备粘贴事件先同步再投远端。回到前台仅在 clipboard-read 已 granted 时读取，不自动请求权限；显式远端粘贴可发起读取。本地选择粘贴只在已授权时刷新设备，其余用应用缓存。scope/revision/文本 hash 防止跨账号和回声。
- “重置浏览器数据”要求 Session 已休眠，清除最新剪贴板；历史片段仍由文件库管理。删除用户同时删除最新值与片段。
- 集群帧按类型限制：`clipboard.changed` 4 MiB；带剪贴板的 `session.open/ensure` 20 MiB；在线 `clipboard.write` 20 MiB；其他 1 MiB。Viewer WS 普通请求仍为 1 MiB，`clipboard.set` 可容纳 1 MiB 文本最坏 JSON 转义，传输上限为 6 MiB+64 KiB。


## 设置

设置统一在"更多 → 设置"，全部由 Control 保存：质量（优先高画质 / 自动 / 优先流畅）、界面缩放、顶部留空、Memory Saver、搜索引擎、左右声道（多选；"不播放"即清空）、音视频同步（默认关闭）、打开时全屏、锁定策略、统计叠层。当前站点的偏好与权限在"更多 → 网站设置"。Control 下发给 Endpoint 的媒体策略是 `{degradationPreference, maxFps, audio}`：maxFps 来自 Viewer 显式上报的刷新能力，未知时 60；audio 为左右声道至少选中一个。音视频同步不属于运行期策略，而是 peer 的创建参数：Control 在转发 offer 时读取当时的设置传给 Endpoint，Endpoint 在应答中回显该 peer 实际采用的值；Viewer 发现权威设置与当前 peer 不一致时立即重建 RTC 连接（不计入失败重试、不经过退避）。
