# 多节点：配置、通道、版本、放置与数据搬迁

一个 Control 管理多个 Endpoint 节点。节点只是算力；产品状态、节点配置、会话放置、密钥和对象索引都在 Control。一个 Tenant 的 Session 在任一时刻只在一个节点上运行；Browser 关闭（休眠）后，Session 可以在任何节点上从 checkpoint 重新打开。没有热迁移：渲染进程、GPU 资源和 WebRTC 连接本来就搬不走，冷搬迁的代价与一次 Browser 重启相同。

## 配置

**Control 配置文件**是唯一的配置来源：`REMOTEKIT_CONTROL_CONFIG` 指定路径（默认 `<control>/data/control.json`），不存在时按默认值创建。严格校验，未知键或类型错误拒绝启动；相对路径相对配置文件所在目录。包含：

- `http`：监听地址、端口、允许的 Origin、可选 TLS。
- `database`、`diagnostics`、`quotas.tenantObjectBytes`（每 Tenant 对象字节配额）。
- `cluster.keyFile`：32 字节集群密钥（base64），缺失时生成；`cluster.advertiseUrl` 设置后，Control 在配置目录写出 `node.json`（Control 地址 + 集群密钥），运维把它原样复制到节点。
- `nodeDefaults` 与 `nodes.<nodeId>`：编码器与码控参数、数据目录、Browser 路径、`maxSessions`、`peer.listen/advertise`、`diskReserveBytes`、`sessionMemoryBytes`。节点项是对默认值的部分覆盖；带 `launch` 的是**本地节点**（Control 自己启动 Endpoint，经 stdio 通信），否则是**远端节点**（主动连接 Control）。

节点生效配置 = 默认值 + 覆盖 + `nodeId`，其规范 JSON 的 SHA-256 是 `configHash`。Endpoint 不读任何配置参数或环境变量，只在握手后接收这份配置。重连时 configHash 变化，Endpoint 优雅退出（退出码 4），由监管者重启以采用新配置。

**节点端**只有 `<root>/node.json`：`control`（`ws(s)://host:port/api/node`）和 `key`，可选 `nodeId`（默认是机器的 DNS 主机名，小写）。节点必须在 Control 配置的 `nodes` 中登记才能接入。集群密钥从不进入日志、命令行或错误信息。

## 集群通道

Control 与所有节点之间、节点与节点之间用同一个握手：`Noise_NNpsk0_25519_AESGCM_SHA256`，PSK 是集群密钥，prologue `remotekit-cluster-1`，节点是发起方。

- 第一条消息的载荷是 `node.hello{role, nodeId, buildId, incarnation}`（role 为 `endpoint`、`updater` 或 `peer`）；密钥不对时解密失败，对端不回复直接断开。
- 第二条消息的载荷是 `node.ready`（connectionEpoch、buildId、生效配置、configHash、该节点上的活跃会话清单）、`node.release`（给 updater）或 `node.reject{code: build_mismatch | unknown_node | no_release}`。
- 握手后使用 Noise Split 得到的两个方向 AES-256-GCM 状态。与 Noise 规范的唯一差异：单条传输消息上限 4MiB（规范为 65535 字节）。nonce 用尽或任一次解密失败即断开。
- 明文首字节区分 JSON（≤1MiB 的请求/回复/事件）与 BINARY（u32 头长度 + JSON 头 + 原始字节，用于更新包和对象数据）。
- 载体：远端节点用 Control HTTP(S) 监听上的 WebSocket `/api/node`，一个 Noise 消息对应一个二进制帧；通道自带认证与加密，所以普通 `ws://` 也安全，不再依赖 Bearer、TLS 代理或 loopback 规则。本地节点用 stdio，`u32le 长度 + 消息`，密钥只经子进程环境变量传入且立即清除——同机部署不经过网络栈，但握手与语义完全相同。节点之间用 TCP，帧格式同 stdio。
- 双向请求：Control → Endpoint 是管理方法（20 秒超时为 `outcome_unknown`，每节点最多 256 个在途）；Endpoint → Control 只有 `object.committed`、`object.locate` 等少数请求，同样的超时语义，在独立工作线程上等待，不阻塞管理分发。
- 节点每 15 秒 `node.ping`，任一侧 45 秒没收到任何消息即断开。同一 nodeId 的新连接替换旧连接。

两侧实现（Control 用 `node:crypto`，Endpoint 用 Windows CNG）都对 `protocol/cluster-noise-vectors.json`（cacophony 向量）校验，并有 Node ↔ C++ 的互通测试。

## 版本锁定与更新

Control 包和节点运行时的根目录有相同的 `build.json{buildId}`。buildId 由打包工具对 Control 包的 `bin/`、`control/` 及节点运行时的 `node/bin/` 下文件的路径和 hash 计算。开发构建没有 build.json，buildId 为 `dev`。role `endpoint` 的连接 buildId 与 Control 不同即 `build_mismatch`，在放置、对账和节点间传输中都等同断开。由此 Control、Endpoint、Browser 与节点之间不需要任何协议版本协商。

`remotekit_node.exe` 是独立的 updater 与监管者：不依赖 SDK、Chromium 或媒体代码，只链接集群通道库、内嵌的 zstd 解压与自带的 PAX tar 读取器，只使用 Windows 10（1809+）的接口。

- `run --root=<dir>` 前台运行；`service-install/service-uninstall` 注册 Windows 服务 `RemoteKitNode`（自动启动，失败 5 秒后重启）。
- 启动 `runtime/<current>/bin/endpoint_service.exe --node-root=<root>`，stdin 是管道：关闭 stdin 即请求优雅关闭（最多等 30 秒）。Endpoint 的 stdout/stderr 写入 `<root>/logs/endpoint.log`（16 MiB 轮转，保留 `.1`–`.4`），监管自身的记录在 `logs/supervisor.log`。Control 经 stdio 启动的本地 Endpoint 用同样的文件与轮转记录 stderr，两种部署下节点日志位置一致。退出码 3（需要更新）→ 更新后启动；4（配置变化）→ 立即重启；其他 → 1、2、4…30 秒退避，健康运行 60 秒后复位。
- 更新：以 role `updater` 连接（updater 自己的 buildId 可以较旧），拿到 `node.release{buildId, sha256, size}`，用 `package.get{offset}` 断点续传下载到 `downloads/`，校验大小与 SHA-256，在进程内流式解 zstd 多帧、解 tar（只接受 `node/` 下的普通文件与目录，拒绝链接、设备名、备用数据流、绝对路径与 `..`），核对 `node/build.json`，移到 `runtime/<buildId>`，原子替换 `current`，只保留当前与上一个运行时。
- 新运行时里的 `remotekit_node.exe` 与正在运行的不同时：把运行中的文件改名为 `.old`，复制新文件，用相同参数启动新监管者后退出；替换失败则回滚 `current`。

Control 包中的 `release/node.tar.zst` 与 `release/node.json` 供本地离线安装和远端节点更新。合部署的 `run.cmd` 用 updater 的 `install` 入口校验归档并按 buildId 安装，Control 经 stdio 监管本地 Endpoint。独立节点从 Endpoint 引导包启动，由 updater 下载同一份归档并监管 Endpoint。先升级 Control，节点随即全部被视为断开，各自更新后重新上线；代价是每次发布所有用户的 Browser 冷启动一次。部署入口见[构建与发布](build.md#发布包)。

## 会话、放置与密钥

`session_placements` 记录每个 Tenant 的 `session_id`（32 位十六进制，分配一次不复用）、节点、`placement_epoch`、状态（`active | hibernated`）、最新 checkpoint 与加密的 Tenant DEK。DEK 用 Control 的静态密钥文件 `<db>.key`（与人脸模板共用）以 AES-256-GCM 封装。

- Control 在每个节点连接代次内，向某个 Tenant 发出第一个请求之前先发 `session.open{sessionId, placementEpoch, checkpoint, profileKey, objectKey, objectIdKey}`；三个密钥都由 DEK 经 HKDF-SHA256 以不同 info 派生，Endpoint 只放在内存里并在销毁时清零。Endpoint 只在 `session.open` 时创建 Session，目录 `<dataPath>/sessions/<sessionId>`；同参数幂等，同 Tenant 不同 sessionId 或 epoch 回退为 `conflict`，未打开的 Tenant 上的其他方法为 `not_found`。
- Profile 密钥经 Endpoint 新建的匿名管道交给 Browser：只把读端放进 `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 继承，参数 `--profile-key-handle=<句柄值>`；Browser 在创建任何 BrowserContext 之前读出恰好 32 字节，不足、多余或句柄无效都拒绝启动（见[页面生命周期 · Profile](page-lifecycle.md#profile-持久化)）。Browser 进程内的会话编号固定为 1，Profile 位于 `<sessionDir>/session-1/profile-1`。
- **fencing**：每次重新放置都使 epoch 加一。`node.ready` 携带该节点上的活跃会话清单；Endpoint 在每次（重新）连接时终止并遗忘不在清单中或 epoch 过旧的 Session，它们的目录变成冷副本（7 天后或磁盘压力时删除，`session.cold.delete{}`）。

## 对象存储

文件库资产、缩略图和 checkpoint 块都是对象。对象属于一个 Tenant，不可变，`id = HMAC-SHA256(objectIdKey, 明文)`：同一 Tenant 内相同内容去重，没有密钥的节点无法用内容 hash 探测是否存在某个文件。

- 存储文件 `<dataPath>/objects/<tenant>/<id 前 2 位>/<id>.rko`：头部（`RKO1`、版本、明文大小、1MiB 段大小、段数）后接逐段记录（是否 zstd 压缩、长度、AES-256-GCM 密文）。只有压缩后更小才压缩。nonce 由 objectKey 对 (id, 段号) 的 HMAC 派生，AAD 绑定 Tenant、id、段号与段数；逐段校验，读写都按段流式进行，从不把整个对象放进内存。整个文件的 SHA-256（`storedSha256`）让不持有密钥的节点也能校验副本。
- Control 的对象索引记录大小、存储 hash、副本所在节点和派生关系（缩略图 `derived_from` 源对象）。引用来源：文件库条目、未决选择、每个 Tenant 最新 2 个 checkpoint 的全部对象；无引用超过 2 小时的对象从所有副本删除。
- 副本目标为 min(2, 就绪节点数)，Control 让磁盘占用最低的节点执行 `object.fetch`（每节点最多 4 个并发）。节点上线后 Control 分页读取 `object.inventory` 对账：索引里没有、首次观察起超过 2 小时的对象删除，节点上缺失的副本从索引移除。
- 节点之间：每个节点在 `peer.listen` 上监听 TCP，握手 role `peer`，buildId 必须相同；任何持有集群密钥的节点都可读取任何对象的存储文件（只有密文），`object.get{tenantId, id, offset}` 按 1MiB 分块返回并以 `object.end{size, sha256}` 结束，可从 offset 续传；每个服务端最多 8 个并发连接。
- Endpoint 本地需要对象（给 Browser 暂存文件、缩略图、Viewer 下载、恢复 checkpoint）而本地没有时，先 `object.locate` 拿到副本地址，从对端拉取并校验后写入本地存储，再 `object.committed` 登记为新副本。Browser 自己从不访问对象存储。

文件库的条目、分组、篮子和选择事务仍在 Control；资产 id 就是对象 id，Endpoint 的 `Seal` 写入对象并 `object.committed` 后才算成功。草稿、选择与原生暂存仍是 Session 本地的。见[文件与相机](files-and-camera.md)。

## Checkpoint 与休眠

**Browser 优雅关闭**：`BrowserRuntime::Shutdown()` 先导出所有导航状态有变化的 view（总计最多 20 秒），再发 `browser.shutdown`，等 Browser 作业中的进程全部退出（最多 30 秒）；只有退出码 0 且作业为空才算干净。所有有意的停止（休眠、服务关闭、更新与配置重启）都走这条路径；强制终止只用于故障与 fencing。一次不干净的关闭之后，同一目录不再生成 checkpoint，直到 Browser 再次启动并干净关闭：重试休眠不能把不一致的数据库提交出去。

**`session.hibernate{placementEpoch}`**：

1. 有阻塞项则 `conflict`：未确认的自然关闭事件、未决原生选择、上传中、页面请求（对话框、文件选择）、下载中、RTC 连接存在、生命周期不确定。这些计数由各自的所有者组件报告在快照的 `hibernation` 字段里。
2. 优雅关闭 Browser；不干净则 `unavailable`。
3. 遍历 Session 目录。排除 `browser.log`、名为 `Cache`、`Code Cache`、`GPUCache`、`DawnWebGPUCache`、`DawnGraphiteCache`、`Shared Dictionary`、`VideoDecodeStats` 的目录、LevelDB 的 `LOCK`/`LOG`/`LOG.old`，以及文件库草稿与暂存（休眠时丢弃）。SQLite 的 `-journal`/`-wal` 保留：干净关闭才是一致性的前提，文件名是否存在不是。
4. 不超过 1MiB 的文件是一个对象，更大的按 1MiB 固定切块（SQLite 原地改页、LevelDB 只追加或整文件新建，固定切块的增量效果最好）。Session 目录之外的本地索引记录每个文件的大小、mtime、文件 ID 与块列表，未变的文件直接复用块 id，不重新读取。
5. 生成 manifest 对象（相对路径、大小、块列表、目录、sessionId、epoch、buildId），把新对象逐个 `object.committed`，回复 manifest id。Session 关闭，目录保留为热副本并记录对应的 manifest。

Control 只在 epoch 匹配时提交 checkpoint，并把放置状态改为 `hibernated`。之后任何对该 Tenant 的需要（Viewer 连接、对账）都会重新放置并以该 checkpoint 打开：节点本地的热副本正好对应时直接使用，否则拉取对象物化到 `.restore` 再原子替换。Tab 保留产品状态，经现有的导航恢复流程回到原页面。

**休眠策略**（Control，只在该 Tenant 开启 Memory Saver 时）：没有 Viewer 连接满 10 分钟（节点有压力时 2 分钟），没有处于 applying 的操作，快照报告无阻塞项。有 Viewer 连着的 Session 永远不搬。

**可搬迁性**（Chromium 157 实测与源码核对）：

- Cookie 用 Control 托管的 Profile 密钥加密（`rk1` 提供者），不再绑定 DPAPI。
- 网络沙箱对 `Network` 目录的 ACL 在每次加载 NetworkContext 时重新授予，`NetworkDataMigrated` 标记只阻止重复迁移；恢复文件时用目标机正常继承的权限，不复制源 ACL。
- 会话 Cookie 跨 Browser 重启保留（persist/restore 打开），否则每次休眠都会让依赖会话 Cookie 的网站掉登录。
- sessionStorage 通过持久化的 namespace 跨进程恢复（见[页面生命周期](page-lifecycle.md#导航状态导出与恢复)）。
- DBSC 在 content embedder 中默认关闭（`NetworkContextParams.device_bound_sessions_enabled` 为 false），保持关闭：它的密钥在 TPM 里，无法搬迁。
- 不可搬迁、也不尝试搬迁：页面持有的本机文件引用（File System Access 句柄、下载路径、PageState 中的文件字段）、平台验证器凭据、客户端证书。

## 指标与放置

Endpoint 每 5 秒发 `node.metrics`：系统 CPU 忙碌比例、内存总量/可用、每块 GPU 的 3D 与视频编码引擎利用率（PDH `GPU Engine` 按 LUID 汇总）和专用显存（PDH 用量 + DXGI 总量）、数据卷容量/剩余、打开的 Session 数、对象字节。采样在独立线程，不阻塞管理分发。

- 压力 = max(CPU, 1 − 可用/总内存, 最大 3D 利用率, 最大编码利用率, Session/maxSessions, 1 − 剩余/磁盘)；最近 30 秒持续 ≥ 0.85 视为有压力。
- 放置（新 Tenant 或休眠后唤醒）：候选为就绪、未移除、未在磁盘排空、Session 数未满、磁盘剩余 ≥ `diskReserveBytes`、可用内存 ≥ `sessionMemoryBytes` 且已有指标的节点；优先无压力的节点，都有压力时才放到有压力的节点。得分 = 压力，持有该 Tenant 最新 checkpoint 热副本的节点减 0.15；最低者胜，同分按 nodeId。
- 磁盘剩余低于保留值：停止向该节点放置，删除冷副本，仍不足 2 倍保留值时把对象副本迁到别处。

## 管理员面板

"管理员面板 → 节点"为每个节点显示：状态（在线/连接中/离线/已移除）、Control 托管或外部、对外地址、最近一次指标（CPU、内存、每块 GPU 的 3D/视频编码/显存、磁盘）、综合压力与是否持续高压、是否在腾磁盘、Session 数/上限与其上的用户、对象副本占用、版本、连接或断开时间。`NodeLink` 记录连接历史：连接与断开时间、最近一次握手拒绝（原因与节点自报的 buildId，例如版本不一致时显示节点版本）、托管进程最近一次退出码（3 需要更新、4 配置变更）；成功连接时清空旧的拒绝与退出记录。

## 节点移除

只能移除未就绪的节点，需确认：记录到 `removed_nodes`，该节点上的 Tenant epoch 加一并以最新 checkpoint（没有则为空 Profile，按 Control 的有限产品信息重建工作区）变为 `hibernated`，它的副本从索引移除；被移除的节点握手时得到 `unknown_node`，直到管理员重新加入。`removed_nodes` 由 `NodeAdmin`（`control/server/cluster/node-admin.ts`）独占，它在一个事务里调用 Placement 的 `evacuate` 与对象索引的 `forgetNode`，各自只清理自己的表。节点列表只来自配置文件。节点失联本身不会自动触发重新放置：最近 checkpoint 之后的数据只在那台机器上。
