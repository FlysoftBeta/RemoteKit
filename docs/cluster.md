# 多节点：配置、通道、版本、放置与数据搬迁

一个 Control 管理多个 Endpoint 节点。节点只是算力；产品状态、节点配置、会话放置、密钥和对象索引都在 Control。一个 Tenant 的 Session 在任一时刻只在一个节点上运行；Session 停止并把数据提交为 checkpoint 之后，可以在任何节点上重新打开；还有未提交更改的 Session 只在它所在的节点上运行（见[Session 副本与提交](#session-副本与提交)）。没有热迁移：渲染进程、GPU 资源和 WebRTC 连接本来就搬不走，冷搬迁的代价与一次 Browser 重启相同。

## 配置

**Control 配置文件**是唯一的配置来源：`REMOTEKIT_CONTROL_CONFIG` 指定路径（默认 `<control>/data/control.json`；发布包为 `config/control.json`），不存在时由 Control 写出一份完整的默认配置。格式定义在 `control/server/config-formats.ts`，与其他落盘格式同样严格（见[架构 · 持久化格式](architecture.md#持久化格式)）：带 `version`，文件是完整的——除 `http.tls`、`sessionImport`、节点内的 `media` 与本地节点的 `executable` 外每个键都必须写出，"不设"写 `null`；未知键、缺键或类型错误拒绝启动。读取处没有默认值，默认值只出现在 Control 第一次创建文件时。所有相对路径相对配置文件所在目录，开发与打包用同一套默认值。按含义分组：

```json
{
  "version": 1,
  "http": { "listen": "0.0.0.0:3001", "origins": ["https://example.org:3001"], "tls": { "key": "certs/privkey.pem", "cert": "certs/fullchain.pem" } },
  "storage": { "database": "../data/control.db", "diagnostics": "../data/diagnostics", "logs": "../logs" },
  "media": {
    "encoder": "auto", "fps": 60, "bitrate": 36000000, "maxBitrate": 48000000,
    "asyncDepth": null, "gop": null, "targetUsage": null, "qsvLowPower": "auto",
    "bufferMs": null, "rateControl": null, "idleIdrMs": 150,
    "maxEncodeWidth": 4096, "maxEncodeHeight": 4096
  },
  "quotas": { "tenantObjectBytes": null },
  "nodes": {
    "local": {
      "local": { "root": "../data/node" },
      "peer": { "listen": "0.0.0.0:3101", "address": "192.168.1.10:3101" },
      "rtc": { "ports": null, "address": null },
      "limits": { "maxSessions": null, "diskReserveBytes": null, "sessionMemoryBytes": null }
    },
    "gpu-1": {
      "remote": { "control": "ws://192.168.1.10:3001/api/node" },
      "peer": { "listen": "0.0.0.0:3101", "address": "192.168.1.20:3101" },
      "rtc": { "ports": "40000-40019", "address": "example.org" },
      "limits": { "maxSessions": 4, "diskReserveBytes": null, "sessionMemoryBytes": null },
      "media": { "encoder": "nvenc" }
    }
  }
}
```

| 分组 | 含义 | 去向 |
|---|---|---|
| `local` / `remote` | 节点怎样启动与接入：本地节点由 Control 经 stdio 拉起（`root` 是节点根目录，开发构建另有 `executable`）；远端节点主动连接 `remote.control`（`ws(s)://host:port/api/node`） | 只有 Control 用 |
| `peer` | 节点间对象传输：`listen` 在哪监听、`address` 别人从哪访问。每个节点各自写，两个本地节点不能共用监听端口 | 下发给 Endpoint，变化需要重启节点 |
| `rtc` | Viewer 媒体：`ports` 为 UDP 端口段（`null` 由系统选择），`address` 是额外对外宣告的主机名/IP（要求 `ports`） | 下发给 Endpoint，变化需要重启节点 |
| `limits` | 放置策略：`maxSessions`、`diskReserveBytes`、`sessionMemoryBytes`（正整数或 `null`）。`null` 表示没有显式上限，按实测容量尽力服务（见[指标与放置](#指标与放置)）；设置后是硬上限 | 只有 Control 用，不下发、不进 configHash |
| `media` | 编码与码控调优；顶层是完整的集群默认值，节点内可选的 `media` 只写要覆盖的键 | 下发给 Endpoint，不重启：之后启动的 Session 使用新值 |

- `storage`：数据库、诊断归档与日志位置；`quotas.tenantObjectBytes`：每 Tenant 对象字节配额，`null` 为不设。
- 节点数据目录固定为 `<节点根>/data`，Browser 固定在 `endpoint_service.exe` 旁边，不再可配置。
- 节点生效配置 = `{nodeId, peer, rtc, media}`。`configHash` 只覆盖 `peer` 与 `rtc`（需要重新监听端口的部分）：重连时它变化，Endpoint 优雅退出（退出码 4），由监管者重启；`media` 变化在下一次握手时下发，Endpoint 记住它，之后创建的 Session 和编码器使用新值，不重启。
- 加载配置只做三件"写"的事：缺少 `control.key` 时生成；为没有身份文件的节点生成身份并写出 `node.json`；删除已不在配置里的远端节点的 `node.json`。凭据恢复工具只解析配置，不做这些事。

### 节点身份

每一方都有自己的 X25519 静态密钥：Control 在配置目录的 `control.key`（`{version, privateKey}`）；节点的密钥由 Control 在该节点 ID 第一次出现在配置里时生成，写入它的 `node.json`：

| 键 | 内容 |
|---|---|
| `version` | 格式版本（1） |
| `nodeId` | 节点 ID |
| `privateKey` | 节点私钥（base64） |
| `controlPublicKey` | Control 公钥（base64） |
| `control` | 仅远端节点：要连接的 Control 地址 |

- 远端节点的文件在 `<配置目录>/nodes/<nodeId>/node.json`，运维把它复制到节点根目录；本地节点的文件由 Control 直接写到 `<local.root>/node.json`。Control 从自己写出的这个文件读取节点公钥——它就是该节点身份的唯一记录。
- 节点从配置中删除：远端节点的 `node.json` 被删除；Control 不再知道它的公钥，它的握手会失败——这就是吊销。同一个 ID 重新加入会得到新密钥。
- 本地已有的 `node.json` 必须与当前状态一致：`nodeId` 与配置中的 ID 相同、`controlPublicKey` 与 `control.key` 对应，本地节点不带 `control`；不一致就拒绝启动，不自动换新身份。更换 Control 密钥时删除 `control.key` 与各节点的 `node.json`，重新启动生成新身份，再把新的 `node.json` 复制到远端节点。只有远端地址变化时，Control 改写 `control` 字段并保留密钥（`config.bootstrap_updated`）。
- 管理 App → 节点显示每个节点公钥指纹（SHA-256 前 16 位十六进制）和远端节点 `node.json` 的路径；握手因身份不符被拒时显示"身份不匹配：请将新的 node.json 复制到该节点"。

## 集群通道

Control 与所有节点之间、节点与节点之间用同一个握手：`Noise_IK_25519_AESGCM_SHA256`，prologue `remotekit-cluster-2`，节点是发起方并已知对方的静态公钥。

- 第一条消息带发起方的静态公钥与载荷 `node.hello{role, nodeId, buildId, incarnation}`（role 为 `endpoint`、`updater` 或 `peer`）。Control 只在发起方静态公钥等于该 `nodeId` 已配置的公钥、且节点未被移除时继续；否则握手直接失败、不回复——密钥不对的一方得不到任何信息。第二条消息认证 Control 自己（`ee`、`se`），载荷是 `node.ready`（connectionEpoch、buildId、生效配置、configHash、对象密钥、该节点上的活跃会话清单、`peers`）、`node.release`（给 updater）或 `node.reject{code: build_mismatch | no_release}`。
- **节点之间**：`node.ready` 带 `peers:[{nodeId, address, publicKey}]`（其他所有已配置、未移除的节点）；集合变化（管理员移除/重新加入）时 Control 向所有在线节点推 `node.peers`。对象传输的服务端只接受静态公钥在当前集合里的发起方，并用集合里的 ID 而不是对方自称的 ID；客户端按目标节点的公钥做 IK，连到错误的服务端会握手失败。服务期间每个请求都重新确认对方仍在集合里，所以移除节点对已建立的连接也立即生效。
- 握手后使用 Noise Split 得到的两个方向 AES-256-GCM 状态。与 Noise 规范的唯一差异：单条传输消息上限 4MiB（规范为 65535 字节）。nonce 用尽或任一次解密失败即断开。
- 明文首字节区分 JSON（请求/回复/事件）与 BINARY（u32 头长度 + JSON 头 + 原始字节，用于更新包和对象数据）。
- **大小上限是一份契约**：`protocol/limits.json` 是集群通道上所有大小与数量上限的唯一来源（传输消息、管理 JSON、`session.desired`、观察状态、事件正文与积压、剪贴板文本与 HTML、view 与站点数量等）。包括队列容量、工作队列、对象分块与 locate 批量、日志窗口、RTC 信令队列等通道预算。Endpoint 构建时由 CMake 从它生成头文件，Control 直接导入；两侧各有一个测试，在上限处接受、超过一字节拒绝。文档上限按实际发送的 UTF-8 JSON 计算，并为之后才加上的 `id`/`opId` 与帧预留 `managementEnvelopeBytes`，两侧用同一种量法。
- **发送方先守上限**：Endpoint 不发出超限的事件或观察。剪贴板超限只带 `oversize: true` 与大小；登录结果、下载结果、页面自行关闭等事件超限则丢弃并记一个 `e-` 错误 ID（持久事件序号不受影响）；超限的观察状态丢弃，连续失败只记一次。
- **故障只隔离一个 Session**：帧、加密、握手或消息头（无法解析出 `tenantId/sessionId/placementEpoch`）不合法时断开整个连接。属于某个当前放置的 Session 的消息（观察、事件、该 Session 请求的回复）内容不合法时，只让这个 Session 失效：记一次带 `c-` 错误 ID 的日志，不再处理它的事件与观察，期望状态改为 `run: "stopped"`、`commit: null`（副本保持 `dirty`，数据不丢），该用户的浏览器可用性为 `unavailable` 并带这个错误 ID（C 类：文字 + 错误 ID，没有重试按钮）。Viewer 再次连上时按退避（1 分钟起翻倍，最长 30 分钟；正常运行 10 分钟后复位）重新打开。同节点的其他用户不受影响。
- 载体：远端节点用 Control HTTP(S) 监听上的 WebSocket `/api/node`，一个 Noise 消息对应一个二进制帧；通道自带认证与加密，所以普通 `ws://` 也安全，不依赖 TLS；节点自带 WebSocket 客户端（`stream_socket.cpp` 的 Schannel TLS），`wss://` 不校验服务器证书与吊销状态，也不使用系统代理——Control 的身份由 Noise 静态密钥证明。连接失败的日志带阶段与错误码（DNS、TCP、TLS 握手、HTTP 状态、Noise 握手）。本地节点用 stdio，`u32le 长度 + 消息`，与远端节点一样从节点根目录的 `node.json` 取身份——同机部署不经过网络栈，但握手与语义完全相同。节点之间用 TCP，帧格式同 stdio。
- 双向请求：Control → Endpoint 是管理方法（20 秒超时为 `outcome_unknown`，每节点最多 256 个在途）。超时只让这一个请求失败、不断开连接，哪怕字节还没写出去；之后迟到或无法匹配的回复记 `node.reply_unmatched` 并忽略。Endpoint 工作队列满时回复带原 `opId` 的 `busy`；回复超过大小上限时改发带原身份的 `limit_exceeded`，只让这一个请求失败；Endpoint → Control 只有 `object.committed`、`object.locate` 等少数请求，同样的超时语义，在独立工作线程上等待，不阻塞管理分发。
- 节点每 15 秒 `node.ping`，任一侧 45 秒没收到任何消息即断开。同一 nodeId 的新连接替换旧连接。
- **队列满是背压，不是故障**：Endpoint 的接收各层（载体读取、加密通道、管理入队）在队列满时等待空间，不断开，管道/TCP 的流控随之让发送方变慢；等待期间照常每 15 秒发 `node.ping`，等待时间不计入 45 秒静默。发送没有写超时，对端是否存活只由心跳判断。发送队列按来源有界：回复受 Control 在途请求数约束、RTC 信令受每个 peer 的信令队列约束，二者总被接收；`session.observed` 每个 Session 只留最新一份，排队中的旧观察被原位替换；事件按队列余量分批重放，未入队的不推进已发送游标；其余消息在队列满时返回失败由调用方重试，记一次 `cluster.queue_full`。容量（`managementQueueMessages`、`managementQueueBytes`）至少能容纳多份最大文档。本地节点的管理连接一断，进程就退出、同节点所有 Session 都停止，所以只有真正的故障才能让连接结束：心跳静默、读写错误、解密或帧错误、监管者关闭 stdin、配置变化。
- **断开原因必须留在日志里**：载体与通道记录第一次关闭的原因（读到 EOF、带 Win32 码的读写错误、解密失败、帧非法、心跳静默时长、对端关闭、本端关闭），Endpoint 每次连接结束写恰好一条 `cluster.link_lost{reason, detail}`。Control 每次关闭写恰好一条 `node.link_closed{reason, detail}`（握手超时或失败及失败的检查、帧解码、解密、写错误、协议违规、fencing 失败、被新连接替换、心跳超时），本地节点进程退出另记 `node.exited{code}`。`node.ready` 的完整载荷必须放进握手上限，配置加载时就按最坏情况校验，超出时拒绝该节点并记 `node.ready_oversize`。
- **Endpoint 退出前等 Browser 真正退出**：停止 Session 时终止 Browser 作业后，等作业为空且各进程句柄都已结束（最多 10 秒，超时记 `browser.job_not_empty`），否则接替的 Endpoint 进程打不开 Session 目录（Win32 错误 32）。

两侧实现（Control 用 `node:crypto`，Endpoint 用 Windows CNG）都对 `protocol/cluster-noise-vectors.json`（cacophony 的 IK 向量）校验，并有 Node ↔ C++ 的互通测试。

## 版本锁定与更新

Control 包和节点运行时的根目录有相同的 `build.json{buildId}`。buildId 由打包工具对 Control 包的 `bin/`、`control/` 及节点运行时的 `node/bin/` 下文件的路径和 hash 计算。开发构建没有 build.json，buildId 为 `dev`。role `endpoint` 的连接 buildId 与 Control 不同即 `build_mismatch`，在放置、对账和节点间传输中都等同断开。由此 Control、Endpoint、Browser 与节点之间不需要任何协议版本协商。

`remotekit_node.exe` 是独立的 updater 与监管者：不依赖 SDK、Chromium 或媒体代码，只链接集群通道库、内嵌的 zstd 解压与自带的 PAX tar 读取器，只使用 Windows 10（1809+）的接口。

- `run --root=<dir>` 前台运行；`service-install/service-uninstall` 注册 Windows 服务 `RemoteKitNode`（自动启动，失败 5 秒后重启，LocalSystem）。
- 同时监管快照进程 `runtime/<current>/bin/remotekit_snapshot.exe`（见[运行中的版本](#运行中的版本)）：它是普通子进程而不是另一个 Windows 服务，继承监管者的账户，随运行时一起更新，不需要额外的安装或权限；日志在 `logs/snapshot.log`，退出后同样 1、2、4…30 秒退避。Control 主机的管理器为本地节点做同样的监管。监管者不是以服务（LocalSystem）运行时，快照进程没有建卷影副本的权限，节点只是没有运行中的版本。
- 启动 `runtime/<current>/bin/endpoint_service.exe --node-root=<root>`，stdin 是管道：关闭 stdin 即请求优雅关闭（最多等 30 秒）。Endpoint 的 stdout/stderr 写入 `<root>/logs/endpoint.log`（16 MiB 轮转，保留 `.1`–`.4`），监管自身的记录在 `logs/supervisor.log`；两者都是 JSON 行（格式见[诊断 · 日志](diagnostics.md#日志)），子进程原始输出按字节转写。Control 经 stdio 启动的本地 Endpoint 用同样的文件与轮转记录 stderr，两种部署下节点日志位置一致。退出码 3（需要更新）→ 更新后启动；4（配置变化）→ 立即重启；其他 → 1、2、4…30 秒退避，健康运行 60 秒后复位。
- 更新：以 role `updater` 连接（updater 自己的 buildId 可以较旧），拿到 `node.release{buildId, sha256, size}`，用 `package.get{offset}` 断点续传下载到 `downloads/`，校验大小与 SHA-256，在进程内流式解 zstd 多帧、解 tar（只接受 `node/` 下的普通文件与目录，拒绝链接、设备名、备用数据流、绝对路径与 `..`），核对 `node/build.json`，移到 `runtime/<buildId>`，原子替换 `current`；自更新完成后删除其他运行时与 `downloads/`，监管者启动时也做同样的清理，只保留当前运行时。
- 新运行时里的 `remotekit_node.exe` 与正在运行的不同时：把运行中的文件改名为 `.old`，复制新文件，用相同参数启动新监管者后退出；替换失败则回滚 `current`。

`remotekit_node.exe` 静态链接 CRT，节点上只需要它和 `node.json`。

Control 版本目录中的 `release/node.tar.zst` 与 `release/node.json` 不在发布物里，由 Control 主机的管理器安装版本时从 payload 的 `node/` 记录生成，供本地节点安装和远端节点更新共用。Control 由管理器从 GitHub Releases 更新（见[构建与发布 · 发布](build.md#发布)）；Control 一换版本，节点随即全部被视为断开（`build_mismatch`），各自从 Control 下载新运行时后重新上线；代价是每次发布所有用户的 Browser 冷启动一次。

## 协调协议

Control 与 Endpoint 之间只有三种交互，没有逐方法的恢复路径：

**期望 / 观察**。Control 为每个节点维护 `node.desired{revision, sessions}`（放在该节点上的全部 Session 与 epoch、`dataState`，替代 fencing 清单），为每个 Session 维护整份 `session.desired`：运行或停止、提交请求、Profile 密钥与要恢复的 checkpoint、站点规则、媒体策略、质量、剪贴板、按产品顺序的期望 view、RTC 授权与锁定、要描述的资产（字段见[协议参考](protocols.md#control--endpoint)）。`revision` 单调递增并由 Control 持久化；Endpoint 只接受当前连接、当前 epoch 下更高的 revision，同 revision 不同内容是 `conflict`。Endpoint 为每个放置保留一个协调器（Browser 关闭后仍在），存最新期望文档，在每个 Session 自己的串行通道里收敛：先撤销授权、应用锁定，再在启动 Browser 前备好站点规则、剪贴板与媒体策略，Browser 起来后先写站点规则与剪贴板，再恢复/创建隐藏的 view、完成导航恢复，最后一次性应用布局、可见性与文件授权。Browser 重启沿用已存的期望文档重新收敛，不等 Control；Endpoint 进程重启后只有期望 view 留在 `session.db` 里，要等新的 fencing 与完整期望文档才启动 Browser——持久化的 view 不能恢复授权。Endpoint 在变化时（合并、间隔 ≥ 100 毫秒）和每次重连时发 `session.observed`：它反映了哪个期望 revision（`observedRevision`、各部分的 `applied` revision）、是否已收敛、Browser 状态与 incarnation、副本记录与已发布的 checkpoint、实际 view、待收养弹窗、恢复进度、RTC、停止阻塞项、资产描述与事件游标。

**有序事件流**。页面自行关闭、下载导入结果、剪贴板变化、登录视图结果，都先在 `session.db` 的 `events` 表里持久化（之后才确认 Browser 一侧），按 `(streamId, seq)` 发出，带不变的 `eventId`。Control 有一个持久的收件箱与游标：按顺序处理，每个事件的产品效果与游标在同一个事务里提交（关闭事件先删产品标签；下载结果先写入文件库或持久的排除决定；剪贴板先写值或冲突片段；登录结果先放进加密的持久任务），然后 `session.events.ack{streamId, upTo}` 累计确认连续已提交的前缀。重连时 Endpoint 从确认位置之后重发；checkpoint 恢复或新放置时换 `streamId` 并重新编号，`eventId` 不变，Control 用它去重。积压上限每 Session 4096 条、32 MiB，从不丢弃未确认的事件：满了就不再接收会产生事件的新工作。停止后的副本不为删除已确认事件而重新写库，等下次可写打开时再清理。

**一次性 RPC**。导航与 history 命令、页面对话框与关闭回复、生命周期动作、文件选择、会话导入写入、RTC 信令、人脸挑战、对象操作和诊断读取仍是请求/回复，但每个请求都带 `opId`（沿用已有的操作 ID、选择 ID、导入 ID，或新生成）、`replay` 与目标（Endpoint incarnation、Session、epoch）。Endpoint 按 `opId` 去重并缓存最近 1024 个结果；结果不确定的调用方用同一 `opId`、`replay:true` 再问：缓存里有就返回原结果，没有就是 `outcome_unknown`，绝不重新执行。目标在第一次接收时固定，Browser、页面或放置变了就拒绝执行——旧请求永远不会改投到新对象上。

## 会话、放置与密钥

`session_placements` 记录每个 Tenant 的 `session_id`（32 位十六进制，分配一次，重新放置时保留）、持有权威副本的节点、`placement_epoch`、`run_state`（`running | stopped`）、`data_state`（`clean | dirty`，见[Session 副本与提交](#session-副本与提交)）、未决提交 `pending_commit`、最新已提交 checkpoint 与加密的 Tenant DEK。DEK 用 Control 的静态密钥文件 `<db>.key`（与人脸模板共用）以 AES-256-GCM 封装。

- Session 由 Control 的 `session.desired{sessionId, placementEpoch, checkpoint, profileKey, run, …}` 打开（见[协调协议](#协调协议)）；Profile 密钥由 DEK 经 HKDF-SHA256 派生，Endpoint 只放在内存里并在销毁时清零。Endpoint 只在 `session.open` 时创建 Session，目录 `<dataPath>/sessions/<sessionId>`；同参数幂等，同 Tenant 不同 sessionId 或 epoch 回退为 `conflict`，未打开的 Tenant 上的其他方法为 `not_found`。
- Profile 密钥经 Endpoint 新建的匿名管道交给 Browser：只把读端放进 `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 继承，参数 `--profile-key-handle=<句柄值>`；Browser 在创建任何 BrowserContext 之前读出恰好 32 字节，不足、多余或句柄无效都拒绝启动（见[页面生命周期 · Profile](page-lifecycle.md#profile-持久化)）。Browser 进程内的会话编号固定为 1，Profile 位于 `<sessionDir>/session-1/profile-1`。
- **fencing**：每次重新放置都使 epoch 加一。`node.desired` 列出放在该节点上的全部 Session（不论运行与否，带 epoch 与 `dataState`）；Endpoint 在每次（重新）连接时终止并遗忘不在清单中或 epoch 过旧的 Session，删除它们的副本记录，目录变成冷副本（7 天后或磁盘压力时删除，`session.cold.delete{}`）；epoch 更新而清单说是 `clean` 的旧副本不再可用（例如管理员把它转移到了别的节点）：先让旧 Session 退役并释放它在目录里持有的全部文件与句柄（包括只读的 `session.db` 读取器），再删除节点级的副本记录、检查点索引与变更日志，不删除目录本身；没有副本记录的目录在打开时按请求的 checkpoint 恢复到 `.restore` 再替换。一份 `node.desired` 里每个放置独立成败：某个放置处理失败只记为那个 Session 的错误，其余放置照常收敛，节点的会话清单仍然生效。

## 对象存储

文件库资产、缩略图、文档渲染结果和 checkpoint 块都是对象。对象存储与 Tenant 无关：对象不可变、按内容寻址，`id = HMAC-SHA256(objectIdKey, 明文)`，所有 Tenant 共用一份——同一个班级的几十个用户下载同一份课件，节点上只有一个对象。Tenant 只体现在引用上：谁能读、谁付配额、对象何时回收，都由 Control 按引用决定。HMAC 而不是裸 SHA-256 让没有集群对象密钥的一方无法用内容 hash 探测某个文件是否存在。

- **密钥**：Control 首次启动时生成 32 字节集群对象密钥（`cluster_object_secret`），以 HKDF-SHA256 派生 `objectKey` 与 `objectIdKey`（info `remotekit object key 2` / `remotekit object id key 2`），在 `node.ready` 里经已认证的集群通道下发给每个节点；节点只放在内存里。Tenant DEK 只再派生 Profile 密钥。
- **存储文件** `<dataPath>/objects/<id 前 2 位>/<id>.rko`：头部（`RKO2`、明文大小、1MiB 段大小、段数）后接逐段记录（是否 zstd 压缩、长度、AES-256-GCM 密文）。只有压缩后更小才压缩。nonce 由 objectKey 对 (id, 段号) 的 HMAC 派生，AAD 绑定 id、段号与段数；逐段校验，读写都按段流式进行，从不把整个对象放进内存。整个文件的 SHA-256（`storedSha256`）让不持有密钥的节点也能校验副本。
- **索引**（Control）：`objects(id, size, stored_size, stored_sha256, created_at)`、`object_replicas(id, node_id)`、`object_derivations(id, source_id, kind)`（`kind` 为 `thumbnail` 或 `document`），节点清单对账的 `object_inventory_orphans(node_id, id)`。
- **认领与引用**：`object.committed{objectId, size, storedSize, storedSha256, tenantId?, derivedFrom?, kind?, putId?}` 登记对象，带 `tenantId` 时同时写入 `object_claims(tenant, id)`——Tenant 在持久引用出现之前（上传 seal、派生物、下载导入、Control 写入）对它的读取权。持久引用按 Tenant 计算：文件库条目、未决选择、最新 4 个版本 的 `checkpoint_objects(tenant, manifest_id, id)`，以及被引用对象的派生物。没有持久引用的认领 2 小时后过期；一个对象在所有 Tenant 都不再引用或认领时记入 `object_gc`，满 2 小时从所有副本删除（时间戳持久化，Control 重启不重置宽限期）。
- **配额**：`quotas.tenantObjectBytes` 按 Tenant 引用或认领的**不同对象**大小之和计算；共享对象对每个引用它的 Tenant 全额计费，所以去重不会让一个用户的配额依赖别人。`object.committed` 与文件库导入时检查。
- **读取授权**：Endpoint 只能为某个 Tenant 读该 Tenant 引用或认领的对象。授权集只由三处填充：本 Session 或该 Tenant 的 service peer 自己写入的对象、Control 推送的文件库描述、对本 Tenant 成功的 `object.locate{tenantId, ids}`。Control 只在请求节点有资格代表该 Tenant 时回答：该 Tenant 的 Session 放在这个节点上，或这个节点持有该 Tenant 当前的 service peer 授权（同一 Viewer 租约、已解锁、授权代次已确认）；只为有权的 id 返回副本地址，否则 `forbidden`。节点本地恰好有某个副本不构成读取权限。Viewer 下载、Browser 暂存、缩略图与照片输入、checkpoint 恢复（含热副本）都经过这个授权集。
- **与放置无关**：对象不属于任何 Session，也不需要转移；只要有一个就绪节点持有副本就能读，service peer 所在节点本地没有时照常从对端拉取。文件库为每个条目投影 `available`（它需要的对象都有就绪节点上的副本）。对象索引只在某个对象"在就绪、未移除节点上的副本数"于 0 与非 0 之间变化时报告它的 id（副本登记与删除、节点上线/离线/移除时各用一条 SQL 算出）；文件库找出引用这些 id 的用户，只重算这些用户，每个用户 250ms 内最多一次，并随库快照推送；checkpoint 与版本的对象从不触发文件库的工作；不可用的条目仍然列出，显示"暂不可用"，不能打开、选择或发送，节点回来后自动恢复。
- **副本**：目标为 min(2, 就绪节点数)，Control 让磁盘占用最低的节点执行 `object.fetch{ids, sources}`（每节点最多 4 个并发）。节点上线后 Control 分页读取 `object.inventory{cursor}` 对账：索引里没有、首次观察起超过 2 小时的对象删除，节点上缺失的副本从索引移除。只登记副本的提交不带 `tenantId`。
- **节点之间**：每个节点在 `peer.listen` 上监听 TCP，握手 role `peer`，buildId 必须相同，只接受当前节点集合里的身份（见[集群通道](#集群通道)）；集合里的任何节点都可读取任何对象的存储文件（只有密文），`object.get{id, offset}` 按 1MiB 分块返回并以 `object.end{size, sha256}` 结束，可从 offset 续传；每个服务端最多 8 个并发连接。
- **本地缺失**：Endpoint 需要对象而本地没有时，先 `object.locate` 拿到副本地址（每次最多 `objectLocateIds` 个 id，Control 每个 id 最多返回 `objectLocateSources` 个按压力挑选的就绪副本；节点 ID 与地址长度有上限，最坏情况的回复也放得进管理 JSON 上限），从对端拉取并校验后写入本地存储，再 `object.committed` 登记为新副本。Browser 自己从不访问对象存储。
- **Control 写入**：Control 自己取得的字节（学习 App 的附件）流式写入磁盘占用最低的就绪节点：`object.put.begin{putId, tenantId, sizeHint?}`，二进制帧 `{putId, offset}` + ≤1MiB 载荷，`object.put.end{putId}` → `{objectId, size, storedSize, storedSha256}`（节点同时以该 `tenantId` 提交认领），`object.put.cancel{putId}`。单对象最多 256MiB，每节点 4 个并发写入；临时文件在取消、断线和启动时清理。

文件库的条目、分区、来源、篮子和选择事务仍在 Control；资产 id 就是对象 id，Endpoint 的 `Seal` 写入对象并 `object.committed` 后才算成功。草稿、选择与原生暂存仍是 Session 本地的。见[文件与相机](files-and-camera.md)。

## Session 存储

Endpoint 自己的 Session 状态在 Session 目录的 `session.db`（SQLite，WAL，`synchronous=FULL`，版本记在 `user_version`，当前为 3）里，随目录进 checkpoint、随 Profile 搬迁。它只保存 Control 重建不出来、而 Endpoint 执行或恢复需要的东西：

| 表 | 内容 |
|---|---|
| `views` | Control 下发的期望 view 配置的执行副本；checkpoint 恢复后据此以恢复模式重建 view 并导入导航历史。冲突时以 Control 对账为准 |
| `closed_events` | 页面自行关闭、等 Control 确认的事件；没有它，Control 会把已关闭的标签当成丢失而重建。未确认事件阻止停止 |
| `navigation_recovery` | 每个 view 的导航历史与 PageState（Browser 导出的字节） |
| `download_imports` | Browser 下载 → 对象 → 文件库之间的交接记录 |
| `library_assets`、`library_derivatives` | 资产大小、尺寸与格式转换结果的缓存，可从对象重建；媒体类型以 Control 文件库为准 |
| `library_drafts` | 上传草稿（字节在 `file-library/incoming/`，先落盘再提交行）；提交前删除，从不进 checkpoint |
| `library_selections` | 原生文件选择回执 |

站点偏好不落盘：Control 在启动 Browser 前推送，Endpoint 只放内存。每个组件只通过自己的窄接口操作自己的表。一个逻辑变更是一个事务——关闭 view（删期望配置、记关闭事件、删恢复数据）、显式导航（改 URL、删旧恢复数据）、确认事件（删事件、更新下载交接）、批量取消选择——不再有跨文件的中间状态和启动时的修复重放。各列的文档格式定义在 `persistence/session_documents.hpp` 与 `files/library_records.hpp`，读写都经同一份定义；库的格式变化只在 `persistence/session_migrations.cpp` 里按编号进行，迁移前与 Control 数据库一样先 `VACUUM INTO` 备份并校验，失败整体回滚。SQLite 结果码映射到错误模型：`BUSY`/`LOCKED` → `busy`，IO、打不开、磁盘满、权限 → `unavailable`，`CORRUPT`/`NOTADB` 和不支持的 `user_version` → `internal` + `corrupt_state`。

**节点级文件**：`<sessionId>.copy.json`（副本记录）、`.changes`（变更日志）、`.checkpoint-index.json`（增量索引）描述的是"这个节点上的这份副本"，不随 checkpoint 搬迁。三者与 checkpoint manifest 的格式定义都在 `persistence/checkpoint_formats.hpp`，各带 `version`（变更日志每行一个），格式变化只在 `persistence/format_migrations.hpp` 里处理。副本记录与索引是单文件原子写（临时文件 + flush + 替换），变更日志只追加。读这些文件时"打不开"（IO 错误）与"不存在"严格区分：前者是 `unavailable`，从不当作不存在；副本记录或变更日志内容非法是 `corrupt_state`，索引是缓存，内容非法时按不存在处理（整体重建）。冷副本清理也清除这些文件的 `.new` 残留，以及该 Session 在 `logs/browser/`、`logs/crashes/` 下的日志。

## Session 副本与提交

Session 数据以**版本**（checkpoint）保存：一个版本是一份 manifest 加它引用的块，块组合起来是 Session 目录的一个完整、合法、不撕裂的状态。版本有两种来源，都是一致点：Browser 干净停止时的提交（`stopped`），以及运行中按卷影副本生成的版本（`running`，见[运行中的版本](#运行中的版本)）。节点上的 Session 目录可以比最新版本更新——模型显式接受这一点，`dirty` 只表示"有比最新版本更新的更改"。每份本地副本有一条副本记录 `<sessionId>.copy.json`：`{sessionId, placementEpoch, base, state, stoppedCleanly, changesAt, lastCommit, lastVersion}`。`state` 为 `clean` 表示目录与 `base`（manifest id）完全一致；为 `dirty` 表示目录在 `base` 之后还有更改。Session 为运行而打开时（Browser 启动之前）副本即记为 `dirty`、`stoppedCleanly:false`，只有干净停止并提交后才回到 `clean`；运行中的版本只推进 `base` 与 `lastVersion{manifestId, takenAt, kind}`，副本仍是 `dirty`。已经传输的块不等于可用：只有登记了 manifest 的版本才能用来恢复。

**同节点打开沿用本地副本**。期望状态要求运行而 Session 尚未打开时：有该 Session 的副本记录、epoch 不比请求新、且（`dirty` 或 `base` 等于请求的 checkpoint）时，**原样使用目录**，不恢复、不回退——Endpoint 进程重启（更新、配置变化、崩溃）后同节点重新打开不会丢掉上次提交之后的更改，从未提交过的 Session 也照常打开。`stoppedCleanly:false`（Endpoint 或 Browser 意外退出）时，Chromium 自己恢复它的数据库，与桌面 Chrome 崩溃后相同。其他情况按请求的 checkpoint 恢复：本地索引对得上时逐文件校验修补（warm），否则物化到 `.restore` 再原子替换（cold），然后写 `clean` 副本记录。epoch 过旧仍按 fencing 拒绝。

**变更跟踪始终开启**。每个运行中的 Session 在 Browser 启动前就用 `ReadDirectoryChangesW` 递归监视自己的目录，变化与删除的路径每 5 秒追加到节点级变更日志 `<sessionId>.changes`（带写出时间），每次提交后截断。意外退出后，变更列表 = 日志内容 ∪ 一次只看元数据的遍历：大小、last write time、文件 ID 与索引不同的文件，last write time 不早于 `changesAt − 2 秒` 的文件，以及删除的文件——不读文件内容。只有索引缺失或非法时才完整重建。NTFS 的 last write time 是变化信号，不使用 USN。开发构建用 `REMOTEKIT_CHECKPOINT_VERIFY=1` 把增量结果与完整遍历比对。

**块持续产出**。运行中的 Session 后台低优先级把静默 10 秒以上的变化文件预先切块存为对象：读前读后各记一次文件身份，读期间变化的作废；全节点共享 16 MiB/s 的速率上限，每个 Session 同时一个文件。不超过 1MiB 的文件是一个对象，更大的按 1MiB 固定切块（SQLite 原地改页、LevelDB 只追加或整文件新建，固定切块的增量效果最好）；未变的文件复用索引里的块。预存的块以该 Tenant 的认领提交，Endpoint 每 30 分钟用 `object.claims.refresh{tenantId, ids}` 续期仍未提交的块，Control 只为该 Tenant 已认领的 id 续期。

**停止时的提交**。期望状态 `run:"stopped"`，`commit` 为提交请求 ID 或 null：

1. 有阻塞项则 `conflict`（指明是哪一项）：未确认的自然关闭事件、未决原生选择、上传中、页面请求（对话框、文件选择）、下载中、RTC 连接存在、生命周期不确定、导航恢复未完成。计数由各自的所有者组件报告在快照的 `stopBlockers` 字段里。
2. 优雅关闭 Browser：`BrowserRuntime::Shutdown()` 先导出所有导航状态有变化的 view（总计最多 20 秒），再发 `browser.shutdown`，等 Browser 作业中的进程全部退出（最多 30 秒）；只有退出码 0 且作业为空才算干净，不干净则 `unavailable`。强制终止只用于故障与 fencing。
3. 不提交时到此为止：副本保持 `dirty`，`stoppedCleanly:true`。
4. 提交时：删除上传草稿与暂存，关闭 `session.db`（之后任何写入都是缺陷），只扫描变更列表并把剩下的文件切块。排除名为 `Cache`、`Code Cache`、`GPUCache`、`DawnWebGPUCache`、`DawnGraphiteCache`、`Shared Dictionary`、`VideoDecodeStats`、`blob_storage` 的目录、LevelDB 的 `LOCK`/`LOG`/`LOG.old`、上传与文件库暂存目录；SQLite 的 `-journal`/`-wal` 保留——干净关闭才是一致性的前提。读取、hash、压缩、加密在有界工作池上并行；对象登记按批发出（`object.committed.batch`，每批 ≤1024 个、一个事务）。
5. 生成 manifest 对象（版本 2：buildId、文件与块列表、目录），登记，然后写副本记录 `{state: clean, base: manifest, lastCommit: {requestId, manifestId}}` 并截断变更日志，在观察状态里报告 `data:{state, base, committed:{requestId, manifestId}}` 与 checkpoint 描述。manifest 里的 buildId 只记录生成它的构建；恢复只校验格式版本，不要求构建相同。

提交按 `requestId` 幂等：同一 id 直接从副本记录的 `lastCommit` 得到结果，即使 Session 已不在内存或 Endpoint 已重启；Session 不在内存而副本是 `clean` 时，不同的 id 直接报告当前 `{state: clean, base}`。阻塞项只推迟收敛，不清除停止请求；一旦开始关闭数据库并发布 checkpoint，必须先完成或恢复这一次提交，之后的"运行"期望不能越过它。路径超过 `MAX_PATH` 的文件同样能扫描、物化与恢复。

**优雅关闭 Endpoint**（服务停止、退出码 3/4）：停止每个 Session，并在全节点 60 秒预算内用节点生成的 requestId 逐个提交；没来得及的保持 `dirty`、`stoppedCleanly:true`——同节点重新打开仍沿用它。重连后每个 Session 的第一份观察状态带副本记录（`data`）；Control 把它没有请求过的提交当作请求过的一样校验对象并提交指针；校验完成前不重新打开该 Session，避免按旧指针恢复。

### 运行中的版本

运行中的 Chromium 一直在写 SQLite（主文件 + `-wal`）与 LevelDB（`MANIFEST`、`.ldb`、`.log`），`session.db` 也是 WAL。在不同时刻逐个读取变化的文件，可能拼出一个从未同时存在过的状态。所以运行中的版本从 **VSS 卷影副本**读取：它是整卷在某一瞬间的镜像，等同于那一刻断电，这些数据库本来就能从这种状态恢复。干净停止仍是最好的一致点，停止时照常提交。

**快照进程** `remotekit_snapshot.exe`（`endpoint/snapshot/`，静态 CRT，不依赖 SDK、Chromium 与媒体代码）由节点监管者启动，参数是节点数据根、nodeId 与监管者 PID；Endpoint 不直接接触 VSS。接口是命名管道 `\\.\pipe\remotekit-snapshot-<nodeId>`，DACL 只允许 SYSTEM 与监管者的账户，拒绝远程客户端；帧为 `u32le 长度 + JSON`，文件数据另起一个二进制帧。

- `snapshot.take{root, paths}`：`root` 必须等于启动参数里的数据根，路径必须是根下的相对路径，拒绝 `..`、绝对路径与任何一级是 reparse point 的路径。为该卷建一个非持久、不调用 writer 的卷影副本（`VSS_CTX_FILE_SHARE_BACKUP`、`VSS_BT_COPY`），在副本里递归枚举这些路径，返回 `{snapshotId, takenAt, files:[{path, size, mtime, fileId} | {path, directory} | {path, missing}]}`。目录在卷影副本里枚举，因此快照瞬间的新建、改名与删除都如实反映。`takenAt` 取卷影副本的创建时间。
- `snapshot.read{snapshotId, path, offset, length ≤ 1 MiB}`：只能读 `take` 返回过的路径。
- `snapshot.release{snapshotId}`。租约：每个请求续期，120 秒没有请求或连接断开即释放；最后一个租约释放时删除卷影副本。同一卷同时只有一个卷影副本，2 秒内到达的 `take` 合并到同一个，之后有租约未释放时新的 `take` 为 `unavailable`。卷影副本 ID 在创建前写入 `snapshot-owner.json`，进程启动时删除上次遗留的那一个，从不碰其他卷影副本。
- 错误用统一错误码：VSS 不可用、非 NTFS、卷影存储不足 → `unavailable`，HRESULT 在 `os` 中；路径或请求非法 → `invalid_request`。

**调度**（Endpoint，节点级线程）：每 60 秒检查一次，运行中的 Session 有待提交的变化、且距上一个版本（或打开）≥ 5 分钟即到期；同一节点到期的 Session 共用一次 `take`（路径为各自的 `sessions/<id>`）。每个到期的 Session 在自己的协调执行器里生成版本：

1. 用卷影副本里的元数据代替扫描结果；应用与停止提交相同的排除规则。
2. 不在变更列表里、身份（大小、last write time、文件 ID）与上一份索引一致的文件复用索引里的块；在变更列表里的文件和 `session.db`、`session.db-wal` 一律从卷影副本重新读取，不读活目录。读取、切块、加密与登记沿用提交的流水线，预存的块只在身份与卷影副本一致时复用。
3. 写 manifest，副本记录写 `base` 与 `lastVersion{kind: running}`（`state` 保持 `dirty`），变更列表只删去早于 `takenAt − 2 秒` 的条目（快照之后的写入仍是待提交的更改），在观察状态里报告 `checkpoint{manifestId, objects, buildId, kind: running, takenAt}`。

版本分三段，Session 的协调执行器只在首尾各占一下：A 段在执行器内记下变更列表、上一份索引与 Session 身份（进程身份、placement epoch、运行代次）；B 段在有界的 checkpoint 工作池里读卷影副本、切块、存储与登记对象、生成 manifest，不写索引、副本记录与变更日志；C 段回到执行器，若期间 Session 停止、重启或被重新放置则丢弃结果（对象照常按认领与 GC 处理），否则写索引、副本记录、裁剪变更日志并报告。B 段进行中到来的停止不等版本，直接按自己的提交进行。快照进程不可用时跳过版本：日志每次连续失败只记一条 `snapshot.unavailable`，`node.metrics` 带 `snapshot: unavailable`，管理 App 的节点页显示"快照服务不可用"；Session 照常运行，停止时照常提交。开发构建可以用 `REMOTEKIT_TEST_VERSION_INTERVAL_MS`、`REMOTEKIT_TEST_VERSION_CHECK_MS` 缩短间隔，发布构建没有这两个开关。

### Control 侧

放置是 `run_state × data_state`。停止并提交时先在事务里写 `pending_commit`（epoch 不变），然后发布带这个 requestId 的期望状态；不需要单独的请求、超时或补发——观察状态报告 `committed.requestId` 等于它时，校验对象、登记版本，改为 `stopped/clean`，下一份期望文档清除 `commit`。重连只是重发期望状态。未决提交期间认领受保护，不会被 GC。

**期望状态的发布**：`EndpointGateway` 唯一负责发布。改变期望状态的代码只调用 `invalidate(tenant)`；网关合并同一时刻的多次标记，在该用户所在节点就绪时编译并发送最新一份，节点每次就绪时重发它上面的全部放置。节点离线不是调用方要处理的错误：锁定、解锁等状态写在期望文档里，节点回来时生效。需要效果已经发生的调用方显式等待——`published(tenant)`（当前修订已送达）或按条件等待观察状态，二者都有期限；需要 Browser 的操作先检查浏览器可用性，不可用时以带原因的 `unavailable` 失败。发布失败与恢复只在状态切换时各记一条 warn。

运行中的版本：观察状态里 `checkpoint.kind` 为 `running`、副本 `dirty`、Browser 运行中、且 `lastVersion` 与 checkpoint 一致时，同样校验对象并登记，只推进 `checkpoint_id`，`data_state` 保持 `dirty`。同一 manifest 与 `takenAt` 重复报告是幂等的。每个 Tenant 只保留**当前版本**（两种来源中最新的一个）；只有当前版本还没在 min(2, 已配置未移除节点数) 个节点上都有副本时，另外保留最新一个已有副本的版本作为退路，复制完成即释放。保留规则只在一处定义，提交时和每轮对象维护时都按它裁剪 `checkpoints` 与 `checkpoint_objects`；被裁掉的版本独有的块失去引用，按 GC 规则在 2 小时宽限后删除，从不提交的 Tenant 也由维护轮回收。旧版本没有别的用途：没有历史回滚，损坏时也不回退；增量产生与增量复制靠的是按内容去重，不靠保留旧版本。复制只追保留版本的块（当前版本优先）与非 checkpoint 对象，不复制已被取代的版本独有的块。判断能否打开时（`newestComplete`）只数就绪节点上的副本，判断保留时数所有已配置节点上的副本。

**最新的完整版本**：从新到旧找第一个"manifest 与每个块在至少一个就绪、未移除的节点上有副本"的版本。`clean` 的 Session 打开时恢复的就是它：最新版本缺块（还没复制出去、所在节点离线）时自动退回上一个完整版本；一个完整版本都没有时 `unavailable`，reason `session_data_on_offline_node`。

**放置规则**：`clean` 的 Session 可以放到任何合格节点（恢复最新的完整版本，或沿用同一 manifest 的本地副本）。`dirty` 的 Session 只能在持有它的节点上运行——那个节点上的目录比任何版本都新；节点离线时就等它回来，Session 是 `unavailable`，reason `session_data_on_offline_node`（Viewer："会话数据所在节点离线，恢复后自动继续"）。再平衡只移动 `clean` 的 Session。

**转移**（管理 App → 用户 → 转移，`admin.transfer{username, nodeId?}`）把一个用户的 Session 搬到另一个节点，用户先被强制下线：

- 源节点在线：先在源节点停止并提交（不丢更改），再放到目标节点（epoch 加一）。没有其他在线节点时直接拒绝，不先停止。
- 源节点离线：尽力而为。epoch 加一，以最新的完整版本记为 `stopped/clean`，之后的更改丢失；一个完整版本都没有时从空白浏览器数据开始（按 Control 的有限产品信息重建工作区）。确认框写明恢复哪个时间的版本或将从空白开始。旧副本由 fencing 隔离：源节点回来时期望状态里已没有它。
- 指定目标节点时记下这个选择（`transfer_pending`），下次打开优先放在那里且 epoch 不再加一；不指定时由下次打开按放置规则选择，源节点不在候选里。

转移只针对 Session 数据；文件库对象与放置无关，不需要转移。

### 恢复、停止策略与可搬迁性

**打开（恢复时）**：manifest 的块一次批量 `object.locate`（同时授予读取权），本地已有的块与网络拉取并行解码，缺失的块最多 8 个并发、每个来源最多 4 个传输，按偏移写入，新副本批量登记。取不到则以 `unavailable` 失败、不动目录。Tab 保留产品状态，经现有的导航恢复流程回到原页面。

**阶段计时**：Endpoint 为每次停止/提交与打开写一条结构化日志（阻塞检查、导航导出、Browser 关闭与进程退出、扫描、存储、登记；打开时的方式 reuse/warm/cold/new、manifest、校验、定位、拉取、物化、替换、Browser 启动与就绪）。

**停止策略**（Control 自动决定，没有用户开关；没有处于 applying 的操作、快照报告无阻塞项时才停止，每次停止都请求提交）：

- 空闲：Viewer 离开后，按该用户自己的离开时长分布决定（见[页面生命周期 · 自动回收](page-lifecycle.md#自动回收control)）。
- 缓解：节点持续有压力，或刚有放置以预测 ≥ 0.85 落在它上面时，按 Viewer 离开最久的顺序停止该节点上离开 ≥ 60 秒、且按同一规则可以停止的 Session，每节点同时只有一个在途；每次停止后等一个更新的指标采样再决定下一个，节点已缓解且没有待缓解的放置时停止缓解。缓解进行中该节点不做普通的空闲停止（由缓解按顺序处理）。
- 再平衡（冷迁移）：节点持续有压力、而另一个就绪节点预测 < 0.7 时，同样的规则停止并提交压力节点上的空闲 Session；它们下次打开时按放置规则落到更轻的节点。没有热迁移，有 Viewer 连着的 Session 永远不搬。
- 挂机模式的标签所在的 Session 在 30 分钟资格期内不会被空闲、缓解或再平衡停止；只有节点资源硬耗尽可以越过它。
- 每次自动停止记录一条日志：tenant、节点、原因（idle/relief/rebalance/exhaustion）、压力与预测。

**可搬迁性**（Chromium 157 实测与源码核对）：

- Cookie 用 Control 托管的 Profile 密钥加密（`rk1` 提供者），不再绑定 DPAPI。
- 网络沙箱对 `Network` 目录的 ACL 在每次加载 NetworkContext 时重新授予，`NetworkDataMigrated` 标记只阻止重复迁移；恢复文件时用目标机正常继承的权限，不复制源 ACL。
- 会话 Cookie 跨 Browser 重启保留（persist/restore 打开），否则每次停止都会让依赖会话 Cookie 的网站掉登录。
- sessionStorage 通过持久化的 namespace 跨进程恢复（见[页面生命周期](page-lifecycle.md#导航状态导出与恢复)）。
- DBSC 在 content embedder 中默认关闭（`NetworkContextParams.device_bound_sessions_enabled` 为 false），保持关闭：它的密钥在 TPM 里，无法搬迁。
- 不可搬迁、也不尝试搬迁：页面持有的本机文件引用（File System Access 句柄、下载路径、PageState 中的文件字段）、平台验证器凭据、客户端证书。

## 指标与放置

Endpoint 每 5 秒发 `node.metrics`：系统 CPU 忙碌比例、内存总量/可用、每块 GPU 的 3D 与视频编码引擎利用率（PDH `GPU Engine` 按 LUID 汇总）和专用显存（PDH 用量 + DXGI 总量）、数据卷容量/剩余、打开的 Session 数、对象字节。采样在独立线程，不阻塞管理分发。

- 利用率按资源分别计算：CPU、1 − 可用/总内存、最大 3D 利用率、最大编码利用率、1 − 剩余/磁盘，设置了 `maxSessions` 时再加 Session/maxSessions。压力 = 各项最大值；最近 30 秒持续 ≥ 0.85 视为有压力，最新一个采样 < 0.85 视为已缓解。
- **预测**：每个节点在没有 Session 时按 EWMA（α = 0.2）学习各资源的空闲基线；有 Session 时单个 Session 的成本 = (利用率 − 基线) / Session 数（还没有基线时不减，偏保守）；没有 Session 的节点借用其他节点成本的平均值。预测压力 = 各资源"当前 + 一个 Session 的成本"的最大值。管理 App 显示余量 = 1 − 预测。
- **放置**（新 Tenant 或已停止且 `clean` 的 Session 再次打开；`dirty` 的 Session 不参与，只回到它所在的节点）：候选为就绪、未移除、未在磁盘排空、已有指标、且满足所有**显式设置**的上限（Session 数、`diskReserveBytes`、`sessionMemoryBytes`）的节点。得分 = 预测压力；持有该 Tenant 最新 checkpoint 对应本地副本（7 天内）、且预测 < 0.85 的节点减 0.15；最低者胜，同分按 nodeId。尽力而为：胜者预测 ≥ 0.85 也照样放置，同时请求该节点的回收策略腾出容量；没有候选才返回 `unavailable`。显式上限是硬的，满了不放。
- **磁盘下限**：设置了 `diskReserveBytes` 用它，否则取 max(2 GiB, 卷容量的 5%)。剩余低于下限：停止向该节点放置，删除冷副本，仍不足 2 倍下限时把对象副本迁到别处。

## 管理 App

"管理 App → 节点"为每个节点显示：状态（在线/连接中/离线/已移除）、Control 托管或外部、对外地址、最近一次指标（CPU、内存、每块 GPU 的 3D/视频编码/显存、磁盘）、综合压力、预测余量与是否持续高压、是否在腾磁盘、Session 数（设置了上限时显示 数/上限）与其上的用户、对象副本占用、版本、连接或断开时间。`NodeLink` 记录连接历史：连接与断开时间、最近一次握手拒绝（原因与节点自报的 buildId，例如版本不一致时显示节点版本）、托管进程最近一次退出码（3 需要更新、4 配置变更）；成功连接时清空旧的拒绝与退出记录。

## 节点移除

只能移除未就绪的节点。移除等于对放在该节点上的每个用户执行一次（源节点离线的）[转移](#control-侧)：确认框列出这些用户与各自最新完整版本的时间（没有则注明从空白开始），确认后记录到 `removed_nodes`，这些 Session epoch 加一、以最新的完整版本记为 `stopped/clean`，它的副本从索引移除；被移除的节点握手时得到 `unknown_node`，直到管理员重新加入。`removed_nodes` 由 `NodeAdmin`（`control/server/cluster/node-admin.ts`）独占，它在一个事务里调用 Placement 的 `evacuate` 与对象索引的 `forgetNode`，各自只清理自己的表。节点列表只来自配置文件。节点失联本身不会自动触发重新放置：比最新版本更新的更改只在那台机器上，放弃它们只能由管理员明确决定。
