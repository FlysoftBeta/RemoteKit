# 诊断与测量

## 日志

### 记录格式

所有 RemoteKit 进程（Control、管理器、节点监管、Endpoint、快照进程、Browser 及其子进程）只写一种格式：JSON 行，每行一条记录。

```
{"ts":"<UTC ISO，毫秒>","lvl":"debug|info|warn|error","ev":"<组件.事件>","proc":"<进程类别>","pid":<PID>, ...字段}
```

- 事件名是 `component.what` 的小写下划线形式，变量放在字段里，不拼进事件名或句子；错误放在 `err` 字段（code、reason、英文诊断、`errorId`、OS 错误码 `os:{kind: win32|hresult|sqlite, value}`，Control 还带栈与 `cause` 链）。
- 级别语义固定：`error` 需要人处理，`warn` 是已自动处理的异常，`info` 是生命周期事件，`debug` 默认关闭。
- `proc` 取 `control`、`manager`、`node`（节点监管/updater）、`endpoint`、`snapshot`、`browser`；Browser 及其子进程另带 `sessionId` 与 `process`（`browser`、`renderer`、`gpu`、`utility`…）。
- 每条记录先完整构造再一次追加写出，多线程、多进程不会交错。没有 printf 式的自由文本行：第三方库与 Chromium 的 `LOG` 也转成记录（见下）。

### 每个进程自己写文件

每个进程直接追加写自己的文件，不经过 stdout/stderr 管道转写。父进程卡住不会让子进程的日志写入阻塞，子进程崩溃也不会丢掉父进程的日志。

- **Chromium `LOG`**：Browser 在每个进程里用 `logging::SetLogMessageHandler` 接管，转成 `ev:"chromium.log"`，字段 `severity`、`file`、`line`、`message`；页面 console 是 `ev:"page.console"`，字段 `level`、`source`、`line`、`message`。
- **SDK**：`remotekit_sdk.dll` 里的 libwebrtc/Chromium `LOG` 与 SDK 自己的诊断经 C ABI 日志回调交给宿主（`sdk/include/remotekit_sdk.h` 的 `remotekit_sdk_set_log_sink`），由 Endpoint 写成 `sdk.*` 事件；SDK 不写 stderr。高频诊断（如编码器 SetRates）是带限频的结构化事件，同一编码器每秒最多一条。
- **兜底**：父进程仍接住子进程的 stdout/stderr（本地 Endpoint 的 stdout 是集群通道，只接 stderr），任何到达的字节都是日志器之外的输出（Node 致命错误、CRT abort、第三方直接写的文本），按行包装成 `process.output{child, childPid, stream, text}` 写进**父进程自己**的文件。一个文件只有一个写入者（崩溃记录除外，见下）。

### 布局与保留

```
<日志根>/<YYYY-MM-DD>/<proc>.jsonl            Control、manager、node、endpoint、snapshot
<日志根>/<YYYY-MM-DD>/browser-<sessionId>.jsonl
<日志根>/<YYYY-MM-DD>/<name>.<n>.jsonl        同一天内的续写分片，n 从 1 起
<日志根>/crashes/<sessionId>/                 Browser 的 Crashpad 数据库与 events.jsonl
<日志根>/crashes/<proc>/                      其他进程的 dump
```

- 日志根：Control 主机是 `<storage.logs>`（打包版为根目录 `logs/`，Control 与管理器共用），节点是 `<节点根>/logs`。本地节点有自己的节点根，与 Control 主机的日志根分开。
- **日期是写入那一刻所在主机的本地日期**；`ts` 仍是 UTC。写入者每次追加前比较日期，跨日即在新目录开新文件。单个文件超过 64 MiB 时续写下一个分片。
- **Browser 子进程不切换文件**：renderer、GPU 等子进程写 Browser 进程启动时传给它的文件句柄，可能在跨日后仍写入前一天的文件。打包某一天时，除了当天目录，还收录较早目录中最后修改时间落在这一天的文件，所以不会漏掉。
- **预算**：每个进程每天最多 1 GiB；用尽时写一条 `log.budget_exhausted`，当天其余记录丢弃。
- **保留天数**：管理 App → 诊断设置，默认 30 天（1–365），存在 Control。Control 清理自己主机的日志根；节点由 Endpoint 清理整个节点日志根，Control 在节点就绪时与设置变化时推送 `node.settings{logRetentionDays}`。清理在启动时、设置变化时与每次跨日时进行，删除日期早于"今天 − 保留天数"的日期目录，以及 `crashes/` 下最后修改时间早于同一界限的文件。正在运行的 Browser 的 Crashpad 数据库只删其中过期的 dump。
- Session 被删除或冷副本被清理时，它在 `crashes/<sessionId>/` 下的文件一起删除；日期目录里的日志按保留天数过期，不随 Session 删除。

### 崩溃

进程记录不了自己的崩溃，所以由崩溃之外的一方记录，结果统一是一条 `process.crashed`：

```
{"ev":"process.crashed","lvl":"error","proc":"<崩溃的进程类别>","pid":<崩溃的 PID>,
 "code":<异常码或退出码>,"codeName":"<如 EXCEPTION_ACCESS_VIOLATION>","address":"<模块+偏移>",
 "stack":["<模块>!<函数>+<偏移> 或 <模块>+<偏移>", ...],"dump":"<相对日志根的路径>","threadId":<线程>}
```

- **Endpoint、快照进程、节点监管、管理器**（同一个静态库 `remotekit_crash`）：进程启动时先拉起自己的崩溃处理子进程（同一个可执行文件，`--crash-handler=<共享内存名>`），传过去事件与共享内存。崩溃时未处理异常过滤器只把异常指针、线程 ID 写进共享内存、置事件并等待；处理子进程用 `MiniDumpWriteDump`（`MiniDumpNormal | MiniDumpWithIndirectlyReferencedMemory | MiniDumpWithThreadInfo`，客户端指针）把 dump 写到 `crashes/<proc>/<proc>-<pid>-<时间>.dmp`，用 DbgHelp 在挂起的进程上走栈并符号化（同目录有 PDB 时带函数名，否则模块+偏移），把 `process.crashed` 追加到**崩溃进程当天的日志文件**（它已被挂起，不会交错），然后结束它。崩溃处理子进程随宿主退出而退出；它自己起不来时宿主照常运行，记一条 `crash.handler_unavailable`。
- **Browser 进程**：Crashpad 照常写 dump；Endpoint 观察到非正常退出时记 `process.crashed{proc:"browser", sessionId, code, dump, lastFatal}`（`lastFatal` 是 Browser 日志中最后一条 `FATAL` 级 `chromium.log` 的 `message`），并照旧追加到该 Session 的 `crashes/<sessionId>/events.jsonl`。
- **Browser 子进程**（renderer、GPU、utility）：Browser 进程经 `RenderProcessHostObserver` 与 `BrowserChildProcessObserver` 记 `process.crashed{proc:"browser", process:"renderer|gpu|utility", sessionId, code, reason, dump}`，`reason` 取 Chromium 的终止状态（`crashed`、`oom`、`launch_failed`…），正常退出与被要求结束不记。
- **Control**（Node）：管理器记 `process.crashed{proc:"control", code}`，Node 的致命错误输出按"兜底"规则进管理器的文件；Control 以 `--report-on-fatalerror --report-directory=<日志根>/crashes/control` 启动，Node 的诊断报告是该次崩溃的 dump。
- 任何子进程的非零退出（非崩溃）由父进程记 `process.exited{child, childPid, code}`。父进程有意终止子进程（如停止快照进程）记 info 级 `process.terminated{child, childPid}`；请求优雅停止后超时被强杀记 `process.stop_timed_out{child, childPid}`。

### 按错误 ID 查找

`internal`、`outcome_unknown`、`unavailable` 离开产生它的进程时带一个错误 ID，记录完整诊断的那条日志带同一个 ID（见[错误模型](errors.md)）。管理 App → 诊断输入 ID：`c-` 在 Control 主机日志根里从新到旧找，`e-` 向每个就绪节点发 `node.logs.search`（5 秒期限，查不到的节点单独列出），最多各 50 条；都只搜保留期内的日期目录。

### 节点日志接口

Control 读取节点日志只用三个节点级方法（不属于任何 Session），返回的路径都相对节点日志根：

- `node.logs.days` → `{days:["YYYY-MM-DD", ...]}`：存在的日期目录，新到旧。
- `node.logs.list{date}` → `{files:[{path, size, mtime}]}`：该日期目录下的文件，加上较早日期目录与 `crashes/` 下最后修改时间落在这一天的文件。`size` 与 `mtime` 从文件句柄读取：目录枚举里的值对仍在追加的文件是旧的。文件时间按 FILETIME（1601 年起的 100ns）直接换算成 `system_clock`（`FileTimeToLogClock`），不用 `std::chrono::clock_cast`：MSVC 经 `utc_clock` 查闰秒时会加载 ICU 的时区库，没有 ICU 的 Windows 版本上抛异常，整个列表请求变成 `outcome_unknown`（"RPC execution did not return a result"），该节点的日志从包里缺失。路径名按 UTF-8 输出。
- 节点 RPC 失败时 Control 收到的是线上错误对象，打包、检索与采集都用 `endpointError` 转换，保留节点给出的 code、消息与错误 ID；用 `toRemoteKitError` 会把它变成 `internal` 与 `[object Object]`。
- `node.logs.read{path, offset, length ≤ 512 KiB}` → 二进制帧 `{path, offset, size}` + 字节：`path` 必须是 `<date>/<文件>` 或 `crashes/<目录>/<文件>` 形式，不接受 `..`、绝对路径与日志根之下任何一级的 reparse point（日志根本身是配置值，可以位于联接之后）；`size` 是读取时的文件大小，调用者据此从尾部或头部分段读取，并发追加不影响已读部分。

## 诊断包

诊断数据有两种来源，结果都是一个 tar.zst **诊断包**，由管理员保存到自己的"我的文件"里；保存后它就是普通文件，不受日志保留天数影响，由用户自己管理。"我的文件"里它们的来源是**诊断信息**（`source:{app:"diagnostics", channel:"logs"|"collection"}`）。"我的文件"里的每个文件都有"下载到本地"按钮（和预览一样经 WebRTC 文件通道读出，由浏览器保存）。

管理 App → 诊断标签页：

- **日志**：保留天数设置；所有主机（Control 主机与每个节点）合并后的日期列表，每天一个"打包到我的文件"。打包是后台任务：Control 读自己主机该日期的文件，并对每个就绪节点 `node.logs.list` + 分段 `node.logs.read`，按 `<主机>/<相对路径>` 写入包，附 `manifest.json{schemaVersion, kind:"logs", date, hosts:[{host, files, failed?}]}`；离线或读取失败的节点记进 manifest，包照常生成。任务列表显示进行中、完成（文件名）或失败（错误 ID）。文件名 `RemoteKit 日志 <date>.tar.zst`。
- **诊断采集**：用户侧诊断收集产生的包列表（用户、开始时间、原因、大小），每项"保存到我的文件"与删除；它们留在 Control 上，按日志保留天数过期。文件名 `RemoteKit 诊断 <诊断 ID>.tar.zst`。
- **错误 ID 查找**（见上）。

包计入保存者的"我的文件"配额与单文件上限；超出时以 `limit_exceeded` 失败，不截断。节点日志与 Control 日志是全局的，可能含其他 Tenant 的信息，所以只有管理员能打包、保存；非管理员发起的诊断采集也只出现在管理 App 里。

## 用户侧诊断收集

用户在"设置"里点开始诊断，复现问题，用带红点的悬浮"停止数据收集"按钮结束。停止后服务端把数据打包成诊断包保存在 Control，客户端显示诊断 ID；管理员在管理 App 里把它保存到"我的文件"。数据不发往第三方；收集复用已有的 peer 和遥测，不增加媒体传输。

**内容**：

- 客户端约每秒提交一次结构化观测（getStats、呈现、输入），同时只有一个请求在途，停止前等待最后一次提交。
- Control 每 2 秒采样一次进程/事件循环/产品投影，以及 Endpoint 快照（`session.snapshot{outputDiagnostics:true}`：本 Tenant 的编码器、Comp、Browser 输出状态，经已有的管理连接）。一个慢的 Endpoint 请求不会堆积更多请求，也不阻塞归档停止（采集期限 1800ms）。
- 每份数据保留自己的时钟域，记录缺测与终止原因。
- 采样数据（JSONL）不包含：凭据、SDP/候选 IP、Profile、用户文件、页面像素、输入文本。投影使用字段白名单和遍历预算。
- **原始日志**在停止时原样收录，不做脱敏，都从尾部向前读，因此包含开始诊断之前的历史——"先出问题、再开诊断"也能看到现场：本 Session 的 Browser 日志（最新的 `browser-<sessionId>` 文件，不足时向前一个文件补足）共 16 MiB；节点的 `endpoint` 日志同样共 8 MiB；Control 的 `control` 日志共 4 MiB；该 Session 的 `process.crashed` 记录与最新 3 个 dump（每个最多 16 MiB）。节点文件经 `node.logs.list`/`node.logs.read` 读取；整个读取有 15 秒期限（Control 关闭时 3 秒），超时或失败记入 manifest 的 `logs`，包照常写出。

**限制与生命周期**：每次最长 10 分钟，采样数据 32MiB 未压缩（日志另计上述预算），单个请求 128KiB；全局并发 4 个；最近 1024 个状态记录。锁定、授权变化、断线、时长/大小上限、正常关闭都会以对应原因结束；重复 stop/status 幂等。包是 USTAR + Zstandard（Node 内置），包含 manifest、非空的 client/control/endpoint/events JSONL 成员与 `logs/` 下的原始日志，先写部分文件再发布，路径 `<db目录>/diagnostics/<SHA256(tenant)>/<id>.tar.zst`，旁边的 `.reason` 是 `{version, reason}`；manifest 带 `schemaVersion`，两者的格式定义在 `control/server/diagnostics/formats.ts`，重启后仍可按 ID 查询。强制终止 Control 会丢失进行中的内存数据。

## 开发侧追踪

| 开关 | 位置 | 内容 |
|---|---|---|
| `REMOTEKIT_MEDIA_TRACE` | Browser | 每代 32768 条 OSR 环形记录，见[渲染](rendering.md#媒体追踪) |
| `REMOTEKIT_SERVER_TRACE` | Endpoint | 65536 条：Fence 观察、AdaptFrame、SDK 提交、编码队列/VPP/硬件完成、SetRates、wire RTP、输入各阶段 |
| `REMOTEKIT_BROWSER_TRACE_DIR` | Endpoint → Browser | Chromium 启动追踪（16 秒，有界缓冲）；只在不带 `NDEBUG` 的开发构建中读取 |

身份关联：Browser PID + generation + slot + value；Endpoint frame cookie（跨代唯一）与源内容身份；发布回调返回的实际 wire RTP；输入用 peer + client sequence + browser sequence。Endpoint 的 QPC、SDK TimeTicks 与 UTC 通过括号式校准关联；客户端↔Endpoint 的时钟估计与客户端↔Control 的时钟估计是两件事（媒体和触控直接对 Endpoint 做 `clock.ping`，Control 的时钟只用于产品新鲜度）。

`tools/measure/` 下是当前的性能测量工具：多租户调度实验台 schedlab（见下文）、OSR 视频 profile（隔离的服务 + 固定测试页 + marker + 原生输入）、汇总脚本、服务端 trace 分析、资源采样（按 LUID/物理适配器/引擎分组的 PDH GPU 计数；按 PID + 创建时间识别进程，退出的进程连同计数基线移除；采集脚本从 `service.json` 读 `controlPid`/`supervisorPid`）、ETW 录制（辅助清单只记录 PID、父 PID、可执行文件名与创建时间，不记录命令行）、显示状态探测、画质对比（CRC 校验后的 RGB 误差/PSNR）。

## 测量方法

这些规则来自反复出现的误判，每一条都至少导致过一次错误结论。

**终点要说清楚**
- 合成提交（`presentedFrames`）不是物理屏幕点亮；rVFC 是主线程回调，多次提交可合并为一次；应用绘制、合成提交、预计显示分别是不同的终点。
- 解码 FPS、元素收帧/丢帧、合成提交、rVFC 回调、marker 可见帧是五个不同的计数，要在同一个窗口里分别统计。
- "编码完成"计数如果在发布调用之后无条件递增（即使调用返回 INVALID_STATE），它就是硬件完成计数，不是网络交付计数。
- 当前 OSR 路径没有 GPU 完成时间戳。请求时间、Signal/Flush 时间、CPU 观察到 Fence 的时间都不能替代；缺失时省略样本，不补造。

**统计**
- 各阶段的 p95 不能相加得到总 p95，它们通常来自不同的帧群体。要用同一帧的端到端样本。
- 快照式 lastValue 样本描述的是随时间的状态，不是逐帧分布；区分按时间加权和按帧加权。
- 18 个样本的最近秩 p95 就是最大值，要如实说明，而不是暗示尾部估计可靠。
- 采样比例要写明：每 4 次回调取一次的 marker 不是解码帧的完整普查。
- 重传占比 = Δ重传包 / Δ收包（分母含重传）；NACK 是反馈计数，不是重传包数；RTX 可能包含探测/填充，不等于丢包。RTP 丢包累计值可能因迟到包下修，差分要带符号。`totalPacketSendDelay` 只是发送前的累计等待，不能单独证明网络单向时延或纯 pacer 时延。
- `jitterBufferDelay` 除以 emitted 样本数；解码时间除以 decoded 帧数；`totalAssemblyTime` 只覆盖多包帧的首末包间隔；`totalProcessingDelay` 包含解码前等待，不是纯解码时间。

**实验条件**
- 同等工作负载、viewport/DPR、源节奏、接收端呈现路径、网络整形、音频状态、测量区间和 marker 采样比例。修正了测试页就等于换了实验。
- 记录实际加载的运行时 DLL，而不只是可执行文件身份：新启动器配旧媒体 DLL 不是想测的那个版本。
- 本机静音不等于"没有音频"。要隔离 A/V 同步影响，需要让音频路径 inactive 并确认没有音频 RTP。
- 低 RTT 不能排除帧到达抖动、重传或组帧等待；带宽估计不能代替连续的实际包时序。
- 不明来源的 GPU 负载不一定是外部噪声：RDP 重连时 DWM 约 10.8%、WUDF 约 2.7%。驱动的 VideoDecode 计数可能包含编码；3D 总和略超 100% 可能是采样口径问题。CPU 用"核等价"和"整机百分比"分别表达（16 逻辑核时 1 核 = 6.25%）。
- 并发的大 JSONL append 会交错字节（单条超过约 700KB 时曾经毁掉四组实验输出）。写入要串行化；不要跳过中途的解析错误，那会悄悄抹掉证据。
- ETW 中只选"在短窗口内既提交又完成"的包会偏向短等待；保留未完成的区间并说明选择窗口。GPU context 的归属要通过设备的 hProcess 关联，而不是事件头的 PID；时间上接近不等于精确关联到某一帧。
- 诊断开着跑出来的数字不能替代正式基线（一次 profile 开启时 marker p95 147–245ms，关闭时 311–379ms——两者都不能单独说明优化效果）。

**保留一个改动的标准**：预期收益在同帧阶段分解、实际交付的有用帧率、稀疏/静态画质、以及相关的资源与传输代价上都站得住。只改善一个局部指标（发送队列、接收等待、源 FPS、单阶段耗时）不够。

## Pixel marker

为了观察"远端页面实际改变的那个像素"何时到达客户端，而不是从输入 ACK、编码回调或 rVFC 到达去推断：测试页在固定区域绘制带 CRC 的 marker，客户端在精确的呈现身份（RTP、layout epoch、绘制时间）上读取该 ROI 并解码。采样和后续处理不能悄悄换成更新的帧。读回前先清空离屏画布：透明像素会保留旧 marker，产生错误的帧身份。把 CRC 计算移到 Worker 后主线程开销约 1ms p95，Worker 内核仍约 25–29ms——这是转移了工作，不是让它免费。marker 读回只在显式测量时启用，正常 video 呈现不做逐帧拷贝。

## 调度实验台 schedlab

`tools/measure/schedlab/` 在一台机器上用真实的媒体核心跑 N 个租户，测多租户下的帧调度、准入与码控，不经过 Control、Viewer 或 Endpoint 的 Session 层。

**结构**：原生的 `schedlab.exe`（随 Endpoint 构建，不进发布包）只链接 `endpoint_media`。每个租户由它直接经 SDK 启动 Browser、建 view 与单视图 atlas 输出、建 RTC peer，再用产品同一份 `CompEngine`、`EncoderSet`、`RenderSlots` 驱动；所有租户共享一个按适配器的 `FrameAdmission`。实验台自己的 `CompHost` 只做最少的事：atlas 元数据变化时递增 layout epoch，刷新作用域取 peer，失效只记录。因此要比较的方案就是工作树里的代码改动，实验台本身没有实验开关；`run.json` 记录 commit、dirty 状态、二进制与实际加载的 DLL 的 hash，用来确认比较的是哪两个版本。

**负载**：夹具页按统一的 t0 开始，每个租户一种：`S<周期秒>` 平滑滚动、`U<次/秒>` 内容更新、`V` 播放视频、`static`。滚动开始时运行器向实验台发 `activity`，走 `CompEngine::InputReceived`，所以准入的交互优先级与产品同一路径，只是没有真实输入链路。视频由 `schedlab.exe make-video` 用 Windows Media Foundation 的系统 H264 编码器按帧号确定性生成（1920×1080、60fps、60 秒、约 20Mbps、High、GOP 2 秒；画面是平移的纹理地形、运动物体、细节滚动带与帧号），缺失时自动生成到 `develop/tmp/schedlab/assets/video.mp4`，不入库。夹具的图片解码或视频播放失败经 `fixtureError` 使运行失败，`fixtureReady` 只在初始化成功后发出。

**接收端**：同机的一个无头 Edge（或 Chrome 89），每租户一页，经 `kit/browser.mjs` 启动，关闭硬件视频解码，避免与被测的编码争用视频引擎。Worker 里的 encoded transform（Chrome 89 用 encoded insertable streams）记录每个编码帧的到达时间与 RTP。

**指标**（`summarize.mjs`）：
- 延迟 = 接收端编码帧到达 − Comp Begin，按 wire RTP 关联同一帧；同机同一时钟，不含解码与显示。分全部、滚动、视频、更新给 L50/95/99/max。
- 滚动起点：每次滚动开始后第一个 Begin 的帧的延迟；滚动期间的运动 FPS；视频 FPS；更新内容延迟。
- 卡顿：到达间隔超过当时帧间隔 1.5 倍的次数、延迟相对 1 秒滚动中位数突增的次数，均为每分钟。
- 编码字节与 QP、GPU 各引擎占用（PDH，按所选适配器 LUID）、准入按类别的授予/拒绝与等待 p50/p95、发送端 RTC 统计与接收端抖动/解码。

**运行**：

```
node tools/measure/schedlab/run.mjs --geometry F --mix S4,V,V,U10,static --duration 60
node tools/measure/schedlab/matrix.mjs --geometries F,T --tenants 1,5
node tools/measure/schedlab/compare.mjs <run 或 matrix 目录> <run 或 matrix 目录>
```

`--geometry` 取 `F`（1920×1080@1）、`T`（1280×800@2）或 `<宽>x<高>@<DPR>`；`--tenants N` 用默认组合；默认预热 10 秒。开始前等所选适配器空闲（3D < 0.5%、视频解码/处理 < 0.1%，连续 3 个 1 秒样本；计数缺失不算空闲），所以一次运行的总时长是空闲门禁、启动、预热、测量、收尾与汇总之和，明显长于 `--duration`。输出在 `develop/tmp/schedlab/<UTC 时间>-<标签>/`（`run.json`、`summary.json`、`summary.md`）；结束时无论成败都关闭自己启动的进程、删除接收端 Profile 与各 Browser 数据目录，运行与汇总都成功后才删除原始 trace（`--keep-traces` 保留），失败的运行保留全部原始记录。`compare.mjs` 只比较工况键（geometry、租户数、workload mix）一致的记录，找不到匹配的基线即报错。浏览器会自我重启（启动的 msedge.exe 拉起真正的浏览器后退出），所以清理按本次运行自己的 Profile 目录在命令行里找进程树并结束，不只按启动时的 PID；整个运行另有一个按预热与测量时长加 15 分钟算出的看门狗，超时即结束自己拥有的进程并以非零退出，结束后进程显式退出，不会因为子进程遗留的句柄一直挂着。计时测量独占 GPU，不与构建或其他实验并行。

**局限**：没有 Viewer 解码与呈现、没有网络整形、接收端与被测服务同机；跨机器的结论仍要用真实栈确认。
