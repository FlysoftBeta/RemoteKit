# 诊断与测量

## 日志

所有 RemoteKit 进程的日志是同一种 JSON 行：`{"ts":"<UTC ISO>","lvl":"debug|info|warn|error","ev":"<组件.事件>", ...字段}`。事件名是 `component.what` 的小写下划线形式，变量放在字段里，不拼进事件名或句子；错误放在 `err` 字段（code、reason、英文诊断、`errorId`、OS 错误码 `os:{kind: win32|hresult|sqlite, value}`，Control 还带栈与 `cause` 链）。级别语义固定：`error` 需要人处理，`warn` 是已自动处理的异常，`info` 是生命周期事件，`debug` 默认关闭。每条记录先完整构造再一次写出，多线程不会交错。

| 进程 | 文件 | 写入者 |
|---|---|---|
| Control | `<storage.logs>/control.jsonl`（打包版为根目录 `logs/`），16 MiB 轮转、保留 `.1`–`.4` | Control 自己（`control/server/log.ts`）；启动前和单元测试中写 stderr |
| Control 控制台 | `logs/control.stdout.log` | 管理器转写子进程原始输出，只在 Node 崩溃等日志器之外的情况有内容 |
| 管理器 / 节点监管 | `logs/manager.log`、`<节点根>/logs/supervisor.log` | 同格式 |
| 快照进程 | `<节点根>/logs/snapshot.log` | 监管者转写 `remotekit_snapshot.exe` 的 JSON 行 |
| Endpoint | `<节点根>/logs/endpoint.log`，16 MiB 轮转、保留 `.1`–`.4` | Endpoint 写 stderr，由监管者（或本地节点时由 Control）落盘 |
| Browser | `<节点根>/logs/browser/<sessionId>.log`，启动前超过 16 MiB 改名为 `.log.1` | Chromium 原生日志（非结构化），Endpoint 以 `--log-file` 指定 |
| 崩溃 | `<节点根>/logs/crashes/<sessionId>/`（Crashpad dump 与 `events.jsonl`） | Browser（`--crash-dir`）与 Endpoint |

日志不在 Session 目录里，checkpoint 不需要排除它们；Session 被删除或冷副本被清理时，它在 `logs/browser/`、`logs/crashes/` 下的文件一起删除。

**按错误 ID 查找**：`internal`、`outcome_unknown`、`unavailable` 离开产生它的进程时带一个错误 ID，记录完整诊断的那条日志带同一个 ID（见[架构 · 错误模型](architecture.md#错误模型)）。管理 App → 诊断输入 ID：`c-` 在 Control 的 `control.jsonl` 及轮转文件里找，`e-` 向每个就绪节点发 `node.logs.search`（5 秒期限，查不到的节点单独列出），最多各 50 条。

## 用户侧诊断收集

用户在"设置"里点开始诊断，复现问题，用带红点的悬浮"停止数据收集"按钮结束。停止后服务端把数据打包成 tar.zst 保存在 Control，客户端显示诊断 ID。数据不自动下载到客户端，也不发往第三方；收集复用已有的 peer 和遥测，不增加媒体传输。

**内容**：

- 客户端约每秒提交一次结构化观测（getStats、呈现、输入），同时只有一个请求在途，停止前等待最后一次提交。
- Control 每 2 秒采样一次进程/事件循环/产品投影，以及 Endpoint 快照（`session.snapshot{outputDiagnostics:true}`：本 Tenant 的编码器、Comp、Browser 输出状态，经已有的管理连接）。一个慢的 Endpoint 请求不会堆积更多请求，也不阻塞归档停止（采集期限 1800ms）。
- 每份数据保留自己的时钟域，记录缺测与终止原因。
- 采样数据（JSONL）不包含：凭据、SDP/候选 IP、Profile、用户文件、页面像素、输入文本。投影使用字段白名单和遍历预算。
- **原始日志**（`logs/`）在停止时原样收录，不做脱敏：本 Session 的 Browser 日志（节点 `logs/browser/<sessionId>.log`，Chromium 日志，含页面全部 console 输出与 WebRTC/GPU/解码错误）尾部最多 16 MiB；节点 `logs/endpoint.log` 尾部，不足 8 MiB 时用 `endpoint.log.1` 补足；Control 自己的 `control.jsonl` 与 `.1` 尾部共 4 MiB。都从尾部向前读，因此包含开始诊断之前的历史——"先出问题、再开诊断"也能看到现场。Endpoint 以 `session.logs.read` 每次最多 512 KiB 分段返回，Control 从第一次看到的文件大小向前拼接，并发追加不影响已读部分；整个读取有 15 秒期限（Control 关闭时 3 秒），超时或失败记入 manifest 的 `logs`，归档照常写出。节点日志与 Control 日志是全局的，可能含其他 Tenant 的信息；归档只有管理员能下载。

**Browser 崩溃**：Browser 内嵌 Crashpad，以 Browser 可执行文件自身作为 handler 进程，Browser、renderer、GPU 与 utility 进程崩溃时把 minidump 写到 Endpoint 用 `--crash-dir` 指定的节点 `logs/crashes/<sessionId>/`（不在 Session 目录里，不进 checkpoint；没有该参数时不启用崩溃报告）；不配置上传地址、上传同意恒为否，handler 随 Browser 退出。Browser 非正常退出（CHECK 的 `0x80000003`、访问违例等）时，Endpoint 在 `endpoint.log` 写一条 `browser.crashed` 事件（同时追加到该 Session 崩溃目录的 `events.jsonl`）：退出码、Browser 日志中最后一行 `FATAL`/`Check failed`、最新 dump 路径。诊断归档收录崩溃事件与最新 3 个 dump（每个最多 16 MiB）。

**限制与生命周期**：每次最长 10 分钟，采样数据 32MiB 未压缩（日志另计上述预算），单个请求 128KiB；全局并发 4 个；最近 1024 个状态记录。锁定、授权变化、断线、时长/大小上限、正常关闭都会以对应原因结束；重复 stop/status 幂等。归档是 USTAR + Zstandard（Node 内置），包含 manifest、非空的 client/control/endpoint/events JSONL 成员与 `logs/` 下的原始日志，先写部分文件再发布，路径 `<db目录>/diagnostics/<SHA256(tenant)>/<id>.tar.zst`（附 `.reason`），重启后仍可按 ID 查询。强制终止 Control 会丢失进行中的内存数据；已完成的归档目前没有自动清理。

## 开发侧追踪

| 开关 | 位置 | 内容 |
|---|---|---|
| `REMOTEKIT_MEDIA_TRACE` | Browser | 每代 32768 条 OSR 环形记录，见[渲染](rendering.md#媒体追踪) |
| `REMOTEKIT_SERVER_TRACE` | Endpoint | 65536 条：Fence 观察、AdaptFrame、SDK 提交、编码队列/VPP/硬件完成、SetRates、wire RTP、输入各阶段 |
| `REMOTEKIT_BROWSER_TRACE_DIR` | Endpoint → Browser | Chromium 启动追踪（16 秒，有界缓冲）；只在不带 `NDEBUG` 的开发构建中读取 |

身份关联：Browser PID + generation + slot + value；Endpoint frame cookie（跨代唯一）与源内容身份；发布回调返回的实际 wire RTP；输入用 peer + client sequence + browser sequence。Endpoint 的 QPC、SDK TimeTicks 与 UTC 通过括号式校准关联；客户端↔Endpoint 的时钟估计与客户端↔Control 的时钟估计是两件事（媒体和触控直接对 Endpoint 做 `clock.ping`，Control 的时钟只用于产品新鲜度）。

`tools/measure/` 下是当前的性能测量工具：OSR 视频 profile（隔离的服务 + 固定测试页 + marker + 原生输入）、汇总脚本、服务端 trace 分析、资源采样（按 LUID/物理适配器/引擎分组的 PDH GPU 计数）、ETW 录制、显示状态探测、画质对比（CRC 校验后的 RGB 误差/PSNR）。

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
