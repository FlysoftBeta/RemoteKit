# 会话导入

RemoteKit 部署在内网，用户使用时通常拿不到手机，短信/动态码一类的二次验证没法现场完成。会话导入让用户提前在手机上登录网站，把登录状态（cookies 与 localStorage）经邮件送进 Control，Control 再写入该用户的 Browser Profile。

内网的 Control 外部不可达，也不常驻在线，所以不建立手机与 Control 之间的任何直连：邮件是双向信道。手机 App 与 Control 之间交换的是有序事件流，App 发请求（配对、导入、撤回），Control 回事件（已配对、已收到、已导入、失败……）。邮箱只承载密文，本身不受信任。

```
 Android App（设备密钥）                 邮箱（不受信任）                 Control（导入密钥）
 ┌──────────────────────────┐   SMTP   ┌───────────────┐   IMAP   ┌─────────────────────────────┐   管理 RPC
 │ 配对 · 一次性浏览器 · 请求  │─────────►│ Control 收件箱 │─────────►│ 解密 · 排序 · 配对/信任 · 去重 │──────────► Endpoint → Browser
 │ 发件队列（合并、重传）      │          └───────────────┘          │ 导入记录 · 等 Session 活跃写入 │
 │ timeline · 重试            │   IMAP   ┌───────────────┐   SMTP   │ 事件 · 发件队列（合并、重传）   │
 │ 按 seq 应用回复事件         │◄─────────│ App 收件箱     │◄─────────│ timeline（Viewer）            │
 └──────────────────────────┘          └───────────────┘          └─────────────────────────────┘
```

## 信任模型

- **信任根内置**：每个 Control 有一对 X25519 导入密钥。公钥随部署配置在构建时写进 App，App 只接受由这把密钥发出的事件，也只向它发送请求。
- **设备密钥**：每个 App 安装首次启动时生成自己的 X25519 密钥对，私钥不出设备。设备 ID 即 key id（公钥 SHA-256 的前 8 字节，16 位小写 hex）。
- **双向认证加密**：两个方向都用 HPKE Auth 模式，用发送方静态私钥与接收方公钥封装。接收方解开即证明发送方持有对应私钥，不依赖任何公钥保密。
- **配对**：设备第一次与 Control 建立信任必须同时给出正确的用户名、密码与配对码，而配对码只在用户主动打开配对开关后存在。配对成功后 Control 按公钥信任该设备，此后该设备的请求不再带任何凭据。
- **爆破防护**：App 与 Control 公钥都可以被任何人拿到，所以任何人都能构造配对请求并收到回复。配对码让这条路径默认关闭：开关关闭时任何组合都失败；打开时有 3 天期限、一次成功即关闭、累计 10 次失败即关闭，失败原因统一为一句话，不区分是哪一项错误。密码校验与登录共用按用户的尝试限流。

## 部署配置

App 需要的部署信息在构建时内置，没有运行时的发现步骤。管理员在管理 App →概览→会话导入里下载 `deployment.json`，放到 `android/deployment.json` 后构建 App（不入库）。一个 App 构建对应一个部署；Control 换导入密钥或 Browser 升级后需要重新下载并重新构建。

```json
{
  "v": 1,
  "server": "Control 显示名（HTTP Host）",
  "mailbox": "Control 收件地址",
  "key": { "id": "16 位小写 hex", "x25519": "base64url 32 字节公钥" },
  "browser": {
    "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...",
    "platform": "Windows",
    "platformVersion": "19.0.0",
    "architecture": "x86",
    "bitness": "64",
    "wow64": false,
    "model": "",
    "mobile": false,
    "brands": [{ "brand": "Google Chrome", "version": "157" }],
    "fullVersionList": [{ "brand": "Google Chrome", "version": "157.0.8103.15" }]
  }
}
```

- `browser` 由 Browser 的 `identity` 控制方法给出（与页面看到的 `ChromeUserAgent()`/`ChromeUserAgentMetadata()` 同源，含 GREASE 品牌），Control 不维护版本字符串。App 用它让登录时的 WebView 对网站表现为与 RemoteKit 相同的桌面 Chrome。
- 导入密钥首次使用时生成，私钥用 Control 的 at-rest 密钥加密后存库。
- App 自己的收发邮箱（内置账户）写在不入库的 `android/mailbox.properties`；它的地址必须与 Control 配置里的 `appMailbox` 一致，Control 只往这个地址回信。

## 信封

两个方向使用同一种二进制文件 `.rksi`：

| 偏移 | 长度 | 内容 |
|---|---|---|
| 0 | 4 | ASCII `RKSI` |
| 4 | 1 | 版本 `0x02` |
| 5 | 8 | 接收方 key id |
| 13 | 32 | 发送方静态 X25519 公钥 |
| 45 | 32 | HPKE `enc`（临时公钥） |
| 77 | 余下 | HPKE 密文 |

- HPKE（RFC 9180）Auth 模式 `0x02`，DHKEM(X25519, HKDF-SHA256) `0x0020`、HKDF-SHA256 `0x0001`、AES-256-GCM `0x0002`，单次 seal（序号 0）。`info` 为 UTF-8 `RemoteKit session import v2`，`aad` 为前 45 字节头。
- 明文是 gzip 压缩的 UTF-8 JSON 消息。信封上限 16 MiB，解压后上限 32 MiB。超过上限的一批事件拆成多个信封，每个信封仍是连续的 seq 区间。
- App 只接受发送方公钥等于内置 Control 公钥的信封；Control 用发送方公钥算出设备 key id。

## 消息与事件

消息：

```json
{ "v": 2, "ack": 12, "events": [{ "seq": 13, "at": 1793900000000, "type": "import", "...": "..." }] }
```

- 每个方向、每台设备一条独立的事件流。`seq` 从 1 开始逐一递增；一条消息里的 `events` 是连续升序区间，可以为空（只为传递 `ack`）。
- `ack` 是发送方已按序应用的对方最大连续 seq（没有则为 0）。
- `at` 是事件产生时的 Unix 毫秒。
- 接收方严格按 seq 应用事件：`seq ≤` 已应用值的是重复，忽略；区间起点大于已应用值 + 1 时，整条消息暂不处理，等缺口补上。唯一例外是 Control 发给未配对设备的 `pairRejected`，它不占序号（`seq: 0`），收到即应用。

设备 → Control：

| type | 字段 | 含义 |
|---|---|---|
| `pair` | `username`、`password`、`code`（5 个单词的数组）、`device`（设备名 ≤64 字符） | 配对请求 |
| `import` | `id`（UUID v4）、`sites`、`cookies`、`localStorage` | 导入请求；重试时用同一 `id` 重新发送 |
| `withdraw` | `id` | 撤回尚未写入的导入 |

`import` 的字段与限制：

```json
{
  "seq": 2, "at": 1793900000000, "type": "import",
  "id": "UUID v4",
  "sites": [{ "name": "站点名（≤128 字符）", "url": "https://该站点最后访问的页面" }],
  "cookies": [
    {
      "name": "SID", "value": "…", "domain": ".example.com", "path": "/",
      "hostOnly": false, "secure": true, "httpOnly": true,
      "sameSite": "unspecified | none | lax | strict",
      "expires": 1825436000000
    }
  ],
  "localStorage": [{ "origin": "https://www.example.com", "items": [["key", "value"]] }]
}
```

- `sites` 1–16 项、`url` 互不相同；cookies 与 localStorage 是这些站点导出结果的合集。`expires` 为 Unix 毫秒，`null` 表示会话 cookie；`hostOnly=true` 时 `domain` 是不带前导点的主机名。`url`、`origin` 只接受 http/https，`origin` 是序列化后的 origin（无路径）。
- cookies ≤ 4096 条，单条 name+value ≤ 4096 字节；origin ≤ 256 个，每个 origin 的 key+value 合计 ≤ 10 MiB，单个条目按其 JSON 序列化（`["key","value"]` 的 UTF-8 字节数）≤ 256 KiB；条目不跨块拆分。username 1–64 字符、password 1–256 字符。
- 怎样从网站取得这些状态（见下文 Android App 的"导出"）不属于本契约。

Control → 设备（`ref` 是所回复的设备事件 seq）：

| type | 字段 | 含义 |
|---|---|---|
| `paired` | `ref`、`username` | 配对成功；已配对设备流的第 1 个事件 |
| `pairRejected` | `ref`、`reason` | 配对失败，`seq: 0` |
| `importReceived` | `ref`、`id` | 已收到并保存，等待该用户 Session 活跃 |
| `importApplied` | `ref`、`id`、`cookies:{applied,rejected}`、`localStorage:{applied,rejected}` | 已写入 Browser |
| `importFailed` | `ref`、`id`、`reason`、`retryable` | 未能写入；`retryable` 表示同样的请求重发有意义 |
| `importDiscarded` | `ref`、`id` | 已放弃（设备撤回，或用户在 Viewer 放弃） |
| `revoked` | — | 设备已被移除，之后的请求不会被处理 |

`ref` 让两侧把回复挂在对应请求下面显示。同一导入的后续事件（如 `importReceived` 之后的 `importApplied`）`ref` 指向该导入最近一次 `import` 事件；Viewer 放弃导入产生的 `importDiscarded` 同样指向它。`revoked` 没有 `ref`。

## 合并与重传

- **合并**：同一目标的多条事件合进一封信。App 的发送方式二选一：时间窗口（最后一条事件入队后等待窗口时长再发，默认 60 秒，可选立即/1 分钟/5 分钟）或连续操作（事件留在队列里，用户结束一串操作后点"发送"）。Control 按设备合并回复：最后一条事件产生后等待 `replyWindowSeconds`（默认 30 秒），持续有新事件时最长等 5 分钟。
- **一次往返完成配对与上传**：配对请求和随后的导入请求可以在同一封信里，Control 先处理 `pair`，成功后同一消息中的后续事件按已信任设备处理；失败则后续事件不处理。
- **设备重传**：已发出但未被 `ack` 的事件留在发件队列。发送时若最早的未确认事件已发出满 1 小时，整段未确认区间随新事件一起重发；用户在 timeline 点"同步"时立即重发未确认区间，没有未确认事件则发一条空消息，让 Control 补发 App 缺的事件。
- **Control 重传**：收到已配对设备的消息时，若其 `ack` 小于 Control 已产生的最大 seq，且距上次补发满 15 分钟，就把未确认区间重新排入发件队列。
- 未配对设备的消息里只有 `pair` 会被处理，它之前的事件忽略。配对成功时，该设备的已应用 seq 取这条消息的最后一个 seq。

## 邮件

- 主题 `RemoteKit session import to <接收方 key id>`，头 `X-RemoteKit-Import: 2`，一段说明性纯文本正文，附件 `message.rksi`（`application/octet-stream`，base64）。一封信只有一个信封。
- 设备 → Control：从 App 内置账户发往部署配置的 `mailbox`。Control → 设备：从 `sessionImport.mailbox` 经 `sessionImport.smtp` 发往 `sessionImport.appMailbox`。
- 双方都只经 TLS 发信（465 隐式 TLS 或 587 STARTTLS 必须成功）、只用隐式 TLS 收信（993），收信不用 SUBJECT、HEADER、FROM 搜索（网易 163 等对这些条件一律返回空），而是取信封后在本地按主题精确匹配发给自己 key id 的信。双方各自维护收信游标：同一 UIDVALIDITY 下记 UID 水位，每次只 `UID FETCH 水位+1:*`（服务器在没有更新的信时仍会返回最新一封，按 UID 过滤掉）；首次收信或 UIDVALIDITY 变化时，从游标时间起按日期（SEARCH SINCE，再按 INTERNALDATE 留 10 分钟时钟余量）扫描。游标初始时间是功能启用的时刻：Control 为首次收信时，App 为设备密钥生成时，之前已在邮箱里的信不处理。服务器 CAPABILITY 含 `ID` 时先发 IMAP ID（网易 163 等在没有 ID 时拒绝 SELECT）。
- App 收件箱由所有安装共享：App 只处理发给自己 key id 的信，处理完删除；主题以 `RemoteKit session import to ` 开头且超过 30 天的信，不论发给谁都删除，清理已卸载设备留下的回信。
- 先提交本地状态再删信；两者之间崩溃会在下次以重复 seq 被识别并删除。暂不能处理的信（缺口未补上、被限流）不删，下一轮再试。

## 配对

- Viewer 的会话导入→设备里有"允许配对新设备"开关。打开时 Control 生成配对码：从 BIP39 英文词表（2048 词，`protocol/session-import/wordlist.txt`）用安全随机数均匀选 5 个词（55 bit），在开关下方显示，可复制。配对码用 at-rest 密钥加密存库，以便再次显示。
- 开关在以下情况自动关闭：一次配对成功、打开满 3 天、累计 10 次配对失败、用户手动关闭。关闭原因显示一行；再次打开生成新的配对码。
- Control 处理 `pair`：用户名存在且未停用、该用户配对开关打开、密码正确（与登录同一套 scrypt 校验，在 `'password:' + user.id` 限流下执行）、配对码一致（每个单词去首尾空白、转小写后比较，恒定时间）。全部满足才成功；被限流则信件不动，下一轮再试。任一不满足 → `pairRejected`，`reason` 固定为"配对失败：账户、密码或配对码不正确，或该账户未开启配对"；用户存在时计入本次开关的失败次数。
- 成功：保存设备（公钥、设备名、所属用户、配对时间），关闭开关，发出 `paired`。一个设备公钥只属于一个用户；已配对给其他用户的公钥再配对 → `pairRejected`。已配对给同一用户的设备重复配对 → 再次回复 `paired`。
- 移除设备：用户在 Viewer 移除设备，或管理员彻底删除用户。Control 放弃该设备尚未写入的导入、发出最后一个事件 `revoked`；之后该设备的信直接删除，不回复。

## Control 处理

配置在 `control.json` 的 `sessionImport`，缺省则功能关闭（Viewer 提示未开启，下载部署配置返回 `unavailable`）：

```json
"sessionImport": {
  "mailbox": "rk-import@example.com",
  "imap": { "host": "imap.example.com", "port": 993, "user": "rk-import@example.com", "password": "…" },
  "smtp": { "host": "smtp.example.com", "port": 465, "user": "rk-import@example.com", "password": "…" },
  "appMailbox": "rk-app@example.com",
  "folder": "INBOX",
  "pollSeconds": 60,
  "replyWindowSeconds": 30
}
```

- `ImportMailbox` 每 `pollSeconds` 用 imapflow 连接一次（不保持 IDLE），按收信游标取新信的 envelope、INTERNALDATE 与 bodyStructure，只处理主题等于发给 Control key id 的信，只下载文件名以 `.rksi` 结尾的附件。因缺口留在邮箱里的信（以及附件暂时读不出的信）把水位压在它下面，下一轮仍会取到；游标存在 `session_import_mailbox`。头部不对、解密失败、消息无效 → 写日志并删除。
- 一轮内把所有能解开的消息按设备分组、按区间起点排序后依次处理，能连续应用的应用掉；仍有缺口的信留在邮箱里。
- 已配对设备的 `import`：
  - 字段非法 → `importFailed`（`retryable: false`）；超过限制 → `importFailed`，原因写明哪项超限（`retryable: false`）；`at` 早于 30 天 → `importFailed`（"导入已超过 30 天"，`retryable: false`）。
  - 同 `id` 已存在且属于其他设备 → `importFailed`（"导入 ID 冲突"，`retryable: false`）。属于本设备：`pending` 或 `applied` → 按当前状态重发 `importReceived`/`importApplied`；`failed` 或 `discarded` → 用新载荷重置为 `pending`（即重试）。
  - 新 `id` → 保存为 `pending`，回复 `importReceived`。
- `withdraw`：`pending` → `discarded` 并回复 `importDiscarded`；其他状态按当前状态回复。
- 邮件收取失败只影响本轮；状态（最近一次成功/失败）只显示在管理 App 概览，失败同时列为概览问题。

## Control 存储

| 表 | 内容 |
|---|---|
| `session_import_keys` | 单行：导入公钥、加密私钥、key id |
| `session_import_mailbox` | 单行收信游标：`since`（扫描起点）、`uid_validity`、`uid`（水位） |
| `session_import_pairing` | 每用户一行：`tenant`、加密的配对码（关闭时为空）、`opened_at`、`expires_at`、`failures`、`closed_reason`（`paired`/`expired`/`failures`/`user`） |
| `session_import_devices` | `key_id` 主键、`tenant`、`public_key`、`name`、`paired_at`、`in_seq`（已应用的设备最大连续 seq）、`out_seq`（已产生的最大 Control seq）、`acked_seq`、`resent_at` |
| `session_import_events` | 两个方向的事件：`tenant`、`key_id`、`direction`（`in`/`out`）、`seq`、`at`、`type`、`ref`、`body`（完整事件 JSON；`in` 事件去掉密码、配对码与 cookie/storage 内容，只留数量）、`mailed_at`（`out` 事件交给 SMTP 的时间） |
| `session_imports` | `id` 主键、`tenant`、`key_id`、`sites`、`state`（`pending`/`applied`/`failed`/`discarded`）、`payload`（at-rest 加密的 cookies/localStorage，终态后清空）、`cookies`、`origins`、`rejected_items`、`error`、`received_at`、`finished_at` |

- 未知用户的配对请求只回复，不入库；已知用户的失败配对记为该用户 timeline 上的事件，设备显示为"未配对设备"。
- 移除设备删除其行，事件保留在 timeline；彻底删除用户删除该用户的全部行。事件与终态导入保留 180 天。

## Control 写入

- `SessionImporter` 只在 Session 运行时写入，不为导入启动已停止的 Session、不新建放置；新导入到达时、以及每 15 秒检查一次。同一 Tenant 的导入按接收顺序串行执行。
- 写入把载荷切成若干块，每块 JSON ≤ 512 KiB；每块调用 Endpoint `session.storage.import` 得到 job，再以 200 ms 间隔调用 `session.storage.importStatus` 直到完成。写入按[错误码](architecture.md#错误模型)处理：`busy`、`rate_limited`、`unavailable` 保持 `pending`，按共享策略的等待后重试；每块的身份由 Control 指定（`importId` = 导入记录 ID + 块序号，随记录持久化），Browser 按 `importId` 去重：同一 `importId` 重复提交返回已有作业，载荷不同则 `conflict`，最近 64 个完成结果可重复查询；`outcome_unknown` 用同一 `importId` 查询或重新提交，Browser 换代后查不到则重写这一块（写入本身幂等）；其余错误码 → `failed`，错误码与说明存进记录，发出 `importFailed`——只有 `limit_exceeded`（用户可以腾出空间）的 `retryable` 为 true；完成 → `applied` 并发出 `importApplied`。`importFailed` 对 App 仍是 `{reason, retryable}`：App 只按 `retryable` 决定是否提供重试，`reason` 是显示给用户的说明。
- 已经打开的页面不会自动刷新；导入记录为每个站点提供一个入口，在新标签页打开对应的 `url`。

## Control 发件

- `out` 事件写库与状态变化在同一事务中。发件循环按设备取 `mailed_at` 为空的事件，满足合并条件后封装成一封信（`ack` 取该设备 `in_seq`），经 nodemailer 以 TLS 发出，成功后记 `mailed_at`。
- `pairRejected` 也走同一循环；未知用户的配对失败不入库，只在内存中排队发送，进程退出即丢弃。
- 发送失败按 1 分钟起翻倍、最长 1 小时退避重试；待发数量与最近一次失败显示在管理 App 概览，持续失败列为概览问题。
- 补发：清除未确认区间的 `mailed_at`，由发件循环重新发送。

## Endpoint 与 Browser

Endpoint 只做转发与 Browser 换代检查：

- `session.storage.import {cookies, localStorage}`：要求 Session 正在运行（期望状态 `run:"running"`），转发 `storage.import`，回复 `{accepted:true, job, browserIncarnation}`。
- `session.storage.importStatus {job, browserIncarnation}`：incarnation 不符 → `conflict`；否则转发 `storage.import.status`。
- `session.identity`：确保 Browser 运行，转发 `identity`。

Browser 控制方法：

- `identity` → `{userAgent, metadata:{brands, fullVersionList, platform, platformVersion, architecture, bitness, wow64, model, mobile}}`。
- `storage.import` 校验整块后立即返回 `{job}`，在 UI 线程异步执行：cookie 用 `CanonicalCookie::CreateSanitizedCookie`（来源 URL 由 secure、去掉前导点的 domain 与 path 组成，`hostOnly` 时 domain 传空串）+ 默认 StoragePartition 的 `CookieManager::SetCanonicalCookie`（`CookieOptions::MakeAllInclusive()`）；localStorage 用 `LocalStorageControl::BindStorageArea(StorageKey::CreateFirstParty(origin))` 后逐条 `Put`，key/value 按 Blink 的 localStorage 格式编码（全部字符 ≤ U+00FF 用前缀 `0x01` + Latin-1，否则前缀 `0x00` + UTF-16LE）。全部回调到齐后 `FlushCookieStore` 与 `LocalStorageControl::Flush`，job 完成。
- `storage.import.status {job}` → `{state:"pending"}` 或 `{state:"done", cookies:{applied, rejected}, localStorage:{applied, rejected}}`；完成的 job 被读取一次后丢弃，未知 job → `stale_identity`（Endpoint 报 `conflict`）。最多 16 个 job 同时存在，超出 → `resource_limit`。

## Viewer

更多→设置→会话导入是用户自己的页面，分两部分：

- **设备**：配对开关；打开时显示 5 个单词的配对码（可复制）与剩余有效期，关闭原因显示一行。下面是已配对设备列表（设备名、key id、配对时间、最近一次请求），每台可移除。
- **Timeline**：该用户所有设备的事件，按接收时间倒序；每张卡片是一个设备请求（配对、导入、撤回），Control 的回复按时间顺序挂在卡片下方，回复式显示在同一页面。点开卡片查看详情：设备、seq、各事件时间、站点列表、cookie/storage 数量与写入结果、失败原因。`pending` 导入可放弃（发出 `importDiscarded`），`applied` 导入的每个站点可在新标签页打开。

功能未开启时提示一行，不展示邮箱、密钥等部署细节。对话框可见时每 5 秒刷新。管理 App →概览有"会话导入"面板：收信状态、发件队列状态与"App 部署配置"下载。

WS 方法（均要求产品租约）：`sessionImport.state` → `{receiving, pairing, devices, timeline}`；`sessionImport.pairing {open}`；`sessionImport.removeDevice {keyId}`；`sessionImport.discard {id}`；`admin.sessionImportDeployment` 仅管理员；收信与发件状态随 `admin.overview` 的 `sessionImport` 字段返回。

## Android App

`android/`：Kotlin、Jetpack Compose（Material 3）、单 Activity。

- **设备密钥**：首次启动用 BouncyCastle 生成 X25519 密钥对，私钥用 Android Keystore 中不可导出的 AES-GCM 密钥加密后存 App 私有目录。"解除配对并清除数据"删除全部本地数据并轮换设备密钥，Control 视之为新设备。
- **配对**：未配对时首页是配对表单：服务器名（来自部署配置）、用户名、密码、5 个配对码单词（按词表自动补全，输入时校验）、设备名。提交生成 `pair` 事件入队。密码只存在于这个尚未确认的事件里，收到 `paired` 或 `pairRejected` 后随事件内容一起删除。
- **授权门禁**：任何需要授权的操作（新建登录、重试、撤回）都要求已配对，或存在一个尚未被拒绝的在途 `pair` 事件。配对被拒绝后回到配对表单，原因显示在表单上方；失败的导入保留在 timeline 上，重新配对后可以重试。
- **一次性浏览器**：新建登录打开一个全新的隔离 WebView Profile（androidx.webkit `ProfileStore`），UA/Client Hints 设为部署配置里的桌面 Chrome 元数据；设备不支持 `MULTI_PROFILE`、`USER_AGENT_METADATA` 或 `GET_COOKIE_INFO` 时提示更新 Android System WebView。起始页提供 Bing、百度、Google 入口和地址栏；没有历史记录、书签与会话恢复。点"完成登录"后从这次浏览推断出的站点里勾选、导出，生成 `import` 事件入队。无论导出还是放弃，这个 Profile 都立即销毁（清空 cookie 与 Web Storage 后删除；本进程已加载而不能删除时记下，下次启动在创建任何 WebView 之前删除）；App 被杀时同样在下次启动删除。
- **站点推断**：记录这次浏览的顶层导航（含 SPA 的 history 变化），按近似的可注册域名归并（两字母国家顶级域名前是 `com`/`edu`/`gov`/`ac`/`co` 等时取三段，否则取两段），每个站点保留最后访问的 URL、网页图标与名称。名称依次取页面声明的 `og:site_name`/`application-name`/`apple-mobile-web-app-title`、标题里含域名主标签的最短片段、多段标题的最后一段、较短的完整标题，最后退回域名主标签。搜索引擎排后，当前页所在站点默认勾选。
- **导出**：所有站点走同一套通用导出，不按站点适配。登录浏览器把每个 http(s) 请求（`shouldInterceptRequest`，加上不发请求的 history 变化）按 origin 记下路径，每个 origin 最多 256 条。导出时取 host 归属所选站点的 origin：
  - cookies：在这些 URL 上逐个调用 `CookieManagerCompat.getCookieInfo`，拿到带完整属性的 cookie 行（WebView 用 `CanonicalCookie::BuildCookieAttributesLine` 生成：domain 带前导点即域 cookie，否则 host-only；expires 为 HTTP 日期；secure/httponly/samesite）。按请求 URL 查询，作用于子域或子路径的 cookie 在站点实际用过的地方都能取到。同 (name, domain, path) 去重。无名 cookie 契约无法表达，partitioned cookie 写回时会变成非分区，这两类都跳过。
  - localStorage：用同一 Profile 的隐藏 WebView，对每个 origin 以 `loadDataWithBaseURL` 打开空文档，在该 origin 下枚举 `localStorage`。不发网络请求，也不执行站点脚本；空的 origin 不放进载荷。
  - 结果交给载荷校验，超出契约上限时提示失败，不截断。
- **请求与本地数据**：请求的载荷（cookies、localStorage）用 Keystore 密钥加密存盘，直到收到 `importApplied`/`importDiscarded` 或用户删除该请求，以便失败后重试；站点名、URL 与 64px 图标作为请求元数据保留供 timeline 显示。删除尚未写入的请求同时发出 `withdraw`。
- **timeline**：首页即 timeline，按 seq 倒序列出本设备的请求卡片（配对、导入、撤回），Control 的回复挂在卡片下方。卡片状态：待发送、已发送、已收到·等待写入、已导入、失败、已放弃；点开查看详情（站点、数量、各事件时间、原因）。失败（`importFailed` 且 `retryable`、配对被拒后未处理的导入、发信失败）的卡片有"重试"；顶部有"同步"。发信失败的事件留在队列里，由 WorkManager 按退避自动重发。
- **收信**：App 在前台、timeline 可见且有未完成的请求时每 60 秒用 IMAP 收一次，打开 App 与下拉刷新时立即收；有未完成请求时另有 15 分钟周期的后台任务。收到的事件按 seq 应用；乱序到达的消息解密后加密暂存，等缺口补上再应用，所以处理过的信都直接删除，收信游标只需记最大 UID。超过 30 天的导入信每天最多清理一次。等待回信时界面不显示加载动画：Control 可能长时间不在线，回复可能要一天以上。
- **发件**：发送方式在设置里选择（时间窗口或连续操作，见"合并与重传"）；时间窗口模式用 WorkManager 的唯一任务实现，需要网络时才运行。

构建：`android/` 是独立 Gradle 工程（wrapper 自带），需要 `JAVA_HOME`（Android Studio 自带 JBR）与 `ANDROID_HOME`。内置邮箱账户写在不入库的 `android/mailbox.properties`（SMTP 与 IMAP 各自的主机、端口、用户名和密码，格式见 `mailbox.properties.example`），部署配置为不入库的 `android/deployment.json`（见 `deployment.json.example`）；缺失时仍可构建，但 App 提示未内置相应配置。

```text
android\gradlew.bat -p android :app:testDebugUnitTest :app:assembleDebug :app:assembleRelease
```

## 测试与互通

- `protocol/session-import/hpke-auth-vector.json`：RFC 9180 A.1.3（X25519、HKDF-SHA256、Auth 模式）的 KEM 共享密钥已知答案（该向量的 AEAD 是 AES-128-GCM，AES-256-GCM 路径由下面的互通文件覆盖），两端都验证。
- `protocol/session-import/device-message-fixture.json` 由 Android JVM 测试用固定密钥生成（设备 → Control 的信封与明文），Control 测试解开并比对；`control-message-fixture.json` 由 Control 测试生成（Control → 设备），Android 测试解开并比对。
- 真实栈的 Browser 写入与读回由 `tests/integration/test-session-import.py` 验证。
- 端到端手动验证用 `tests/e2e/session-import/demo-site.mjs`：在 `http://127.0.0.1:8090` 提供测试站，登录后设置 HttpOnly 会话 cookie、脚本可见 cookie 和两项 localStorage（含非 ASCII），页面同时列出服务端与脚本看到的状态。模拟器经 `adb reverse tcp:8090 tcp:8090` 访问同一 origin，导入后在 RemoteKit Browser 打开同一地址核对。
