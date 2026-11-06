# 会话导入

RemoteKit 部署在内网，用户使用时通常拿不到手机，短信/动态码一类的二次验证没法现场完成。会话导入让用户提前在手机上登录网站，把登录状态（cookies 与 localStorage）加密后经邮件送进 Control，Control 再写入该用户的 Browser Profile。

内网的 Control 外部不可达，也不能常驻在线，所以不建立任何手机→Control 的直连：邮箱充当无服务器的消息队列。手机 App 用内置的公共邮箱发件，Control 定时用 IMAP 拉取。邮箱内容只有密文，邮箱本身不受信任。

```
 Android App                         邮箱（不受信任）              Control                       Endpoint → Browser
 ┌───────────────────────┐  SMTP   ┌──────────────┐  IMAP 拉取  ┌───────────────────────┐ 管理 RPC ┌──────────────────┐
 │ 隔离 WebView Profile  │────────►│ RemoteKit    │◄────────────│ 解密 · 校验凭据 · 去重  │────────►│ storage.import    │
 │ 登录 → 导出 → HPKE 封装 │  .rksi  │ session      │  删除已处理  │ 存储 · 等 Session 活跃  │         │ CookieManager     │
 │ 发送成功 → 销毁本地状态 │         │ import <id>  │             │ 分块写入 · 记录结果     │         │ LocalStorageControl│
 └───────────────────────┘         └──────────────┘             └───────────────────────┘         └──────────────────┘
```

## 配对

配对把三样东西交给 App：Control 的导入公钥、该用户的导入凭据、收件邮箱，以及 RemoteKit Browser 当前的 UA/Client Hints。

- Viewer：更多→设置→会话导入→生成配对码。Control 为该用户生成 32 字节随机导入凭据，只保存 SHA-256；配对码只在生成时显示一次（二维码 + 可复制文本）。重新生成使旧凭据立即失效；"解除配对"删除凭据。每个用户最多一个有效凭据。
- 配对码：`RKP1:` + base64url（无填充）编码的 UTF-8 JSON：

```json
{
  "v": 1,
  "server": "Control 显示名（HTTP Host）",
  "user": "用户名",
  "mailbox": "收件地址",
  "key": { "id": "16 位小写 hex", "x25519": "base64url 32 字节公钥" },
  "token": "base64url 32 字节导入凭据",
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

- `browser` 由 Browser 的 `identity` 控制方法给出（与页面看到的 `ChromeUserAgent()`/`ChromeUserAgentMetadata()` 同源，含 GREASE 品牌），Control 不维护版本字符串。App 用它让登录时的 WebView 对网站表现为与 RemoteKit 相同的桌面 Chrome，避免网站把会话绑定到不同的设备指纹。
- 导入密钥：每个 Control 一对 X25519 密钥，首次使用时生成；私钥用 Control 的 at-rest 密钥加密后存库。`key.id` 是公钥 SHA-256 的前 8 字节，用来在共享邮箱里识别发给本 Control 的信件。

## 信封

二进制文件 `.rksi`：

| 偏移 | 长度 | 内容 |
|---|---|---|
| 0 | 4 | ASCII `RKSI` |
| 4 | 1 | 版本 `0x01` |
| 5 | 8 | key id |
| 13 | 32 | HPKE `enc`（发送方临时 X25519 公钥） |
| 45 | 余下 | HPKE 密文 |

- HPKE（RFC 9180）base 模式，DHKEM(X25519, HKDF-SHA256) `0x0020`、HKDF-SHA256 `0x0001`、AES-256-GCM `0x0002`，单次 seal（序号 0）。`info` 为 UTF-8 `RemoteKit session import v1`，`aad` 为前 13 字节头。发送方不签名：信封只能由持有凭据的人构造，凭据在密文里。
- 明文是 gzip 压缩的 UTF-8 JSON 载荷。信封上限 16 MiB，解压后上限 32 MiB。

载荷：

```json
{
  "v": 1,
  "id": "UUID v4，导入 ID，用于去重",
  "createdAt": 1793900000000,
  "token": "base64url 导入凭据",
  "device": "设备名（≤64 字符）",
  "site": { "name": "站点名（≤128 字符）", "url": "https://登录完成时的页面" },
  "cookies": [
    {
      "name": "SID", "value": "…", "domain": ".example.com", "path": "/",
      "hostOnly": false, "secure": true, "httpOnly": true,
      "sameSite": "unspecified | none | lax | strict",
      "expires": 1825436000000
    }
  ],
  "localStorage": [
    { "origin": "https://www.example.com", "items": [["key", "value"]] }
  ]
}
```

- `expires` 为 Unix 毫秒，`null` 表示会话 cookie。`hostOnly=true` 时 `domain` 是不带前导点的主机名。`site.url`、`origin` 只接受 http/https，`origin` 必须是序列化后的 origin（无路径）。
- 限制：cookies ≤ 4096 条，单条 name+value ≤ 4096 字节；origin ≤ 256 个，每个 origin 的 key+value 合计 ≤ 10 MiB（Chromium localStorage 配额），单个条目按其 JSON 序列化（`["key","value"]` 的 UTF-8 字节数，含转义）≤ 256 KiB，保证分块后每条控制消息仍小于 1 MiB；条目不跨块拆分。
- 载荷只描述登录状态。怎样从网站取得这些状态由 App 里按站点适配的导出器决定，不属于本契约。

## 邮件

- 主题 `RemoteKit session import <id>`，头 `X-RemoteKit-Import: 1`，一段说明性纯文本正文，附件 `<id>.rksi`（`application/octet-stream`，base64）。一封信只有一个信封；批量发送就是多封信。
- App 发件只经 TLS（465 隐式 TLS 或 587 STARTTLS 必须成功），发件账户在构建时内置；收件地址来自配对码。

## Control 接收

配置在 `control.json` 的 `sessionImport`，缺省则功能关闭（Viewer 显示未配置，生成配对码返回 `unavailable`）：

```json
"sessionImport": {
  "mailbox": "rk-import@example.com",
  "imap": { "host": "imap.example.com", "port": 993, "user": "rk-import@example.com", "password": "…" },
  "folder": "INBOX",
  "pollSeconds": 60
}
```

- `ImportMailbox` 每 `pollSeconds` 用 imapflow 隐式 TLS 连接一次（不保持 IDLE）；服务器 CAPABILITY 含 `ID` 时先发 IMAP ID（网易 163 等在没有 ID 时拒绝 SELECT），搜索主题含 `RemoteKit session import` 的信，读 bodyStructure，只下载文件名以 `.rksi` 结尾的附件。
- 处理一封信：头部格式或 key id 不属于本 Control → 不动，本进程内按 UIDVALIDITY+UID 记住跳过（共享邮箱里可能有其他部署的信）。属于本 Control 的信：解密失败、载荷无效、凭据未知 → 只写日志并删除。凭据有效 → 写入导入记录（见下）后删除信件。先提交数据库再删信；两者之间崩溃会在下次以重复 ID 被识别并删除。
- 校验：`createdAt` 早于 30 天或晚于当前 10 分钟 → 记录为 `rejected`（用户可见原因）。导入 ID 已存在 → 删除信件，不改原记录。
- 邮件拉取的失败只影响本轮，下一轮重试；状态（最近一次成功/失败时间与错误）提供给 Viewer 与诊断。

## Control 存储与写入

`session_imports` 表：`id`、`tenant`、`site_name`、`site_url`、`device`、`created_at`、`received_at`、`state`、`payload`（at-rest 加密的载荷 JSON，终态后清空）、`cookies`、`origins`、`rejected_items`、`error`、`finished_at`。`session_import_pairings`（`user_id` 主键、`token_hash` 唯一、`created_at`）与 `session_import_keys`（单行）。

状态：

| state | 含义 |
|---|---|
| `pending` | 已接收，等待该用户 Session 活跃 |
| `applied` | 已写入 Browser；`rejected_items` 记录被 Chromium 拒绝的条目数 |
| `rejected` | 载荷被 Control 拒绝（过期、超限），不会写入 |
| `failed` | Browser 明确拒绝整个导入 |

- `SessionImporter` 只在 Session 放置为 active 时写入，不为导入唤醒休眠的 Session、不新建放置；新记录到达时、以及每 15 秒检查一次。同一 Tenant 的导入串行执行。
- 写入把载荷切成若干块，每块 JSON ≤ 512 KiB；每块调用 Endpoint `session.storage.import` 得到 job，再以 200 ms 间隔调用 `session.storage.importStatus` 直到完成。写入是幂等的（同名 cookie / 同 key 覆盖），所以 `outcome_unknown`、`unavailable`、`busy`、`conflict`（Browser 换代、job 丢失）都保持 `pending`，下次从头重写；`invalid_request`/`rejected` → `failed`。
- 已经打开的页面不会自动刷新；导入记录提供"打开"，在新标签页打开 `site.url`。

## Endpoint 与 Browser

Endpoint 只做转发与 Browser 换代检查：

- `session.storage.import {cookies, localStorage}`：确保 Browser 运行（同 `session.ensure`），转发 `storage.import`，回复 `{accepted:true, job, browserIncarnation}`。
- `session.storage.importStatus {job, browserIncarnation}`：incarnation 不符 → `conflict`；否则转发 `storage.import.status`。
- `session.identity`：确保 Browser 运行，转发 `identity`。

Browser 控制方法：

- `identity` → `{userAgent, metadata:{brands, fullVersionList, platform, platformVersion, architecture, bitness, wow64, model, mobile}}`。
- `storage.import` 校验整块后立即返回 `{job}`，在 UI 线程异步执行：cookie 用 `CanonicalCookie::CreateSanitizedCookie`（来源 URL 由 secure、去掉前导点的 domain 与 path 组成，`hostOnly` 时 domain 传空串）+ 默认 StoragePartition 的 `CookieManager::SetCanonicalCookie`（`CookieOptions::MakeAllInclusive()`）；localStorage 用 `LocalStorageControl::BindStorageArea(StorageKey::CreateFirstParty(origin))` 后逐条 `Put`，key/value 按 Blink 的 localStorage 格式编码（全部字符 ≤ U+00FF 用前缀 `0x01` + Latin-1，否则前缀 `0x00` + UTF-16LE）。全部回调到齐后 `FlushCookieStore` 与 `LocalStorageControl::Flush`，job 完成。
- `storage.import.status {job}` → `{state:"pending"}` 或 `{state:"done", cookies:{applied, rejected}, localStorage:{applied, rejected}}`；完成的 job 被读取一次后丢弃，未知 job → `stale_identity`（Endpoint 报 `conflict`）。最多 16 个 job 同时存在，超出 → `resource_limit`。

## Viewer

更多→设置→会话导入：

- 状态行：邮箱未配置 / 已配置（最近拉取时间、最近错误）；配对：未配对 / 已配对（生成时间）。
- 生成配对码：确认"旧配对码立即失效"后显示二维码与可复制文本，关闭后不可再查看。
- 导入列表：站点名、设备、生成与接收时间、状态与结果数量；`applied` 可"打开"；任意记录可删除（`pending` 的删除即放弃导入）。设置可见时每 5 秒刷新。

WS 方法（产品租约）：`sessionImport.state`、`sessionImport.pair`、`sessionImport.unpair`、`sessionImport.delete {id}`。

## Android App

`android/`：Kotlin、Jetpack Compose（Material 3）、单 Activity。面向学校等场景：在家里或允许使用手机时登录，到了内网直接用 RemoteKit。

- **配对**：CameraX + ZXing 扫描配对码，或粘贴文本。配对信息存 App 私有目录；重新配对替换旧配对。
- **登录**：每个待导入会话一个独立的 WebView Profile（androidx.webkit `ProfileStore`，Profile 名即会话 ID），cookie、localStorage、缓存与其他会话、App 自身互不相通。WebView 的 UA 设为配对里的 `userAgent`，Client Hints 用 `WebSettingsCompat.setUserAgentMetadata` 设为配对里的桌面 Windows 元数据，宽视口加载桌面版页面。设备不支持 `MULTI_PROFILE` 或 `USER_AGENT_METADATA` 时 App 提示更新 Android System WebView，不提供降级。
- **导出**：登录完成后点"完成"，由按站点适配的 `SessionExporter`（经网站自己支持的接口）产出 cookies 与 localStorage；没有适配的站点提示"尚未适配"。导出结果立即用配对公钥封装成信封存盘，本地不留明文载荷。配对变更后旧信封作废，需重新导出。
- **发送**：多选后批量发送，一个 SMTP 连接逐封发出，逐项显示结果。某封发送成功后立即销毁该会话的本地状态：删除信封、清空 Profile 的 cookie 与 Web Storage、删除 Profile；Profile 在本进程已加载而不能删除时记下，下次启动在创建任何 WebView 之前删除。这样同一份登录状态不会同时留在手机和 RemoteKit 两处。

构建：`android/` 是独立 Gradle 工程（wrapper 自带），需要 `JAVA_HOME`（Android Studio 自带 JBR）与 `ANDROID_HOME`；内置发件账户写在不入库的 `android/mailbox.properties`（格式见 `mailbox.properties.example`），缺失时仍可构建但不能发送。

```text
android\gradlew.bat -p android :app:testDebugUnitTest :app:assembleDebug :app:assembleRelease
```

JVM 测试生成 `protocol/session-import/envelope-fixture.json`，Control 的测试用它验证两端 HPKE/信封实现互通；`protocol/session-import/hpke-vector.json` 是 RFC 9180 的已知答案向量。真实栈的 Browser 写入与读回由 `tests/integration/test-session-import.py` 验证。
