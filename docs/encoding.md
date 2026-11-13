# 编码与 WebRTC 发送

每个 Session 一路 H.264 视频（整张 atlas）加一路 Opus 音频，通过 libwebrtc 直接发给客户端。本文讲编码器的选择与参数、帧的所有权、H.264 level 约束，以及 WebRTC 适配与发送节奏。帧从哪里来见[渲染](rendering.md)，何时请求帧见[节奏与补帧](pacing.md)。

## 职责划分

| 层 | 负责 | 不负责 |
|---|---|---|
| WebRTC（GCC、source adaptation） | 目标码率、缩放/丢帧决策、拥塞控制、发送 pacing | 产品几何、页面 DPR |
| SDK `TextureSource` / `ExternalEncoder` | 把 Endpoint 提交的 D3D 纹理接入 WebRTC；把 WebRTC 的编码请求转发给 Endpoint 硬件编码回调 | 编码实现 |
| Endpoint `EncoderWorker` + QSV/NVENC 后端 | VPP 转换、硬件编码、纹理租约、按 level 约束几何与码率 | 网络决策 |
| Comp | 何时产生源帧 | 码率 |

产品只给 WebRTC 一个"降级偏好"：

| 质量选项 | DegradationPreference |
|---|---|
| 优先高画质 | `MAINTAIN_RESOLUTION` |
| 自动 | `BALANCED` |
| 优先流畅 | `MAINTAIN_FRAMERATE` |

三档不附带不同的 DPR、像素预算、码率或 FPS 预设。历史上曾有一套自制的控制器（延迟超过 300ms 时 DPR ×0.8、按档位固定像素/码率/FPS、源预算控制等），在当时的捕获架构下有效，但在当前路径中已全部删除：它和 WebRTC 自己的适配是两个互相不知道的控制环。

## 适配器与后端选择

1. Endpoint 启动 Browser 之前，按节点配置的 `encoder`（`qsv|nvenc|auto`，默认 auto：先 Intel QSV、再 NVIDIA NVENC）在对应厂商的适配器上实际初始化一次硬件编码器，成功的那块 GPU 的 LUID 被固定下来，并传给 Browser（见[渲染](rendering.md#gpu-适配器)）。
2. auto 模式下允许 QSV→NVENC 回退，但如果显式给了只对 QSV 有意义的设置，回退就是语义错误，直接失败。后端只在这一步选定：`EncoderWorker` 拿到的总是已选定的 `qsv` 或 `nvenc`，自己不做回退。
3. 没有可用硬件编码器时在启动 Browser 之前就报错，不退回软件编码。

## EncoderWorker：帧的所有权

`EncoderWorker` 让 libwebrtc 的回调保持快速返回，同时限制硬件工作量，并保证每个源纹理的租约一直保留到真正的使用者结束。

- 一个可替换的待处理输入 + 后端在途工作（受 async depth 约束，默认 1）。替换待处理输入只丢弃尚未提交的工作，不取消硬件已接受的工作。
- 已接受的帧（排队 + 在途）最多 4 个，每帧同时持有一个 COM 引用和一个独立的 render-slot 租约。只保持 COM 纹理存活并不能阻止生产者覆盖它，所以租约必须单独持有。
- SDK native buffer 的租约和硬件 worker 的租约是两份，各自释放。
- 每个任务的 COM 引用、render-slot 租约和准入额度由任务自己持有，析构是唯一释放点。任务离开在途表之后才调用发布与完成回调，回调抛异常时任务照样释放；编码线程因异常退出时走与正常退出相同的收尾（Drain、清空排队与在途）。
- 硬件 BUSY 时把同一个最早的任务推回队首，并记住它已经转换好的 NV12 输入：重试只重新提交，不重做 VPP、Signal 和 Fence 等待。没有在途工作可 Poll 时先等 5ms 再试。
- 生命周期是一个存储的状态（stopped / running / paused / stopping / failed），不由多个标志推导；重新配置前排队与在途必须为空。
- 速率更新等在途工作排空后再应用。码率为 0（暂停）会取消待应用的速率；恢复时请求 IDR，不重放暂停期间的旧速率。
- 失败是粘滞的：worker 进入清理；无法证明完成的输入转入后端隔离区，而不是释放。
- 计数分开记录：编码器 busy、待处理输入被替换、WebRTC 官方丢帧、硬件失败。只有一个笼统的"丢帧"计数无法定位瓶颈在哪一段。

默认值（服务端）：QSV、目标 36Mbps、最大 48Mbps、60FPS、尾 IDR 最小 150ms、GOP 120、缓冲时长 1000ms、async depth 1。CLI 可调范围：depth 1–8、TU 1–7、GOP 1–65535、缓冲 50–5000ms、目标 100k–50Mbps、最大 ≤60Mbps。

## QSV

### 会话与参数

- oneVPL 2.17 dispatcher，按 adapter LUID 选择硬件 D3D11 实现（实测运行时 API 1.35），拒绝软件实现。`MFXVideoCORE_SetHandle` 安装真实的 D3D11 设备，外部分配器提供真实的纹理 MemId。
- 初始化后用 `GetVideoParam` 回读，除帧率、颜色、LowPower 与 level 外还核对 `Width/Height/CropW/CropH` 等于请求值：VPP 与 NV12 池按请求尺寸创建，驱动若调整了几何，声明、纹理和上报尺寸就不再一致，所以直接配置失败。
- H.264 constrained baseline：`GopRefDist=1`、`NumRefFrame=1`，无 B 帧、无 lookahead。
- 生产默认：`TargetUsage=7`、`LowPower=ON`、VBR（TargetKbps / MaxKbps）。
- VBV = max(目标, 最大码率) × 缓冲时长 / 8，再受 level 的 CPB 上限约束。
- `RepeatPPS=ON`；ExtBRC 开启（见下文），MBBRC 关闭；NAL HRD 一致性和 NAL/VCL VUI HRD 关闭。
- 颜色：RGB→YUV 用 limited-range BT.709；VUI 另外声明 `fullrange=0`、primaries/transfer/matrix=1。转换正确和声明正确是两件事，都需要。

### 转换（VPP）

当前只有"外部 VPP"一条路径：同一设备/context 上用 D3D11 VideoProcessor 把 BGRA atlas 转成 NV12，Signal + Flush，观察 Fence 真正完成后再交给 QSV。"同一个 D3D 设备"不能证明跨组件的执行顺序，所以这个 Fence 等待（上限 5 秒）不能省。VPP 按保持宽高比把整张 atlas 放进偶数取整的输出边界、左上对齐，未覆盖的 NV12 像素填 limited-range 黑（Y=16、U=V=128）。

曾实现过同 session 内异步 BGRA VPP 直接喂编码、中间不 Sync 的方案。单租户几乎没有收益（客户端 29.7→30.4FPS），4 租户反而变差（7.4–8.1→7.2–7.6FPS，p95 上升约 90ms）：编码吞吐提高了约 10%，但工作被挪到了本已饱和的 3D 引擎上（VideoProcessing 引擎占用 9.7%→0，Endpoint 3D 23.5%→28.1%，总 3D 一直在 99.8% 附近）。该方案已删除。

### 读回与码控参数

- 每次 Query/Init/Reset 之前，`ClearFrameBudgetReadback` 把 `MaxFrameSize`、`MaxFrameSizeI/P` 清零，`LowDelayBRC` 置为 UNKNOWN。原因：Query 返回的结构里可能带有驱动自己生成的帧预算，原样复用到下一次速率/时基请求，就把历史读回意外变成了新的应用约束。
- `ReadRateControl` 只记录驱动实际采用的策略，不根据请求值强加新的严格策略。"请求 UNKNOWN"和"读回 OFF"是两个不同的观测。
- Init 和 Reset 之后都校验实际的帧率有理数、几何、颜色、LowPower 和 H.264 level。返回成功不代表参数就是请求的值。
- 码流缓冲按帧面积和实际 VBV 加 65536 字节分配，遇到 `NOT_ENOUGH_BUFFER` 时增长，上限 64MiB。所需输出容量不等于观测到的 AU 大小：一次 8MiB 缓冲在 VBV 约 9.4MB 时失败，而实际 AU 只有 8.6KB。
- Task 与 Packet 分开：输出码流用时间戳 cookie 关联到原始输入，不假设某次 Submit 的输出属于这次 Submit。`MFX_ERR_MORE_DATA` 也可能意味着输入已被接受并保留。Sync 轮询每次 2ms，总上限 5 秒；驱动 Locked 计数归零前不释放输入。

### QSV 应用侧码控（ExtBRC）

QSV 的名义时基固定为 60/1，整个编码器生命周期不变；每帧 QP 由 Endpoint 自己的 `QsvRateController` 通过 `mfxExtBRC` 回调决定。`SetRates` 只更新控制器的速率快照（目标码率、最大码率），从不调用 `MFXVideoENCODE_Reset`；WebRTC 给出的 FPS 对 QSV 不起作用。

为什么这样做：驱动 VBR 按"目标码率 ÷ 名义帧率"分配每帧预算，而改时基必须开新序列（`StartNewSequence=ON`，否则驱动返回 -15），也就是一个 IDR。时基跟随内容节奏，交互开始和结束就会伴随关键帧突发；时基固定，稀疏更新又会饿死（见[调优经验](tuning.md#编码)）。应用侧码控按真实帧间隔给预算，两边的问题都没有了。

**预算**（R = 目标码率，M = 最大码率）：

- 节奏 τ = 最近 3 个真实帧间隔的中位数。静止超过 2.5 秒或重新初始化后，τ 视为未知。
- dt = 距上一个真实帧的采集间隔（Begin 的 QPC），夹在 [1/60, 0.5] 秒；τ 已知时取 min(dt, τ)，未知时取 1/60 秒。每帧名义预算 B = R·dt。用 τ 封顶是关键：静止后的第一帧 dt 可达 0.5 秒，如果按 R·dt 给预算，这一帧要在发送端排队约半秒，后面的帧全被堵住。
- 漏桶：容量 S = R·0.5 秒，按采集时间以 R 排空，按实际编码字节注满，目标水位 S/4。分配目标 T = B × clamp(1 + (S/4 − 水位)/S, 0.5, 1.15)；τ 未知时上限为 1.0。
- 帧上限：P 帧 min(max(2B, R·33ms), M·0.25 秒)。IDR 目标 T_I = min(4·R·max(τ, 1/60), R·60ms)，上限 max(1.25·T_I, 2B)。

**QP 模型**：I、P 分开维护复杂度，bits ≈ C / 2^((QP−4)/6)，QP 取 [10, 51] 内预测不超过目标的最小整数。P 帧每帧最多变 ±4；上一帧预测偏差超过 2 倍时视为场景切换，重置复杂度并放开一帧的限制。首个 IDR 用 QP 26。

**超限**：编码结果超过帧上限且尚未重编时，`Update` 返回 `MFX_BRC_BIG_FRAME`，QP 提高 ceil(6·log2(实际/上限))（至少 +2），重编一次；第二次超限照收。保活帧可以用 `PANIC_BIG_FRAME`。不使用 `PANIC_SMALL_FRAME` 和填充。

**保活帧**（见[节奏 · 静止保活帧](pacing.md#静止保活帧)）：QP = 上一个 P 帧 + 6，不更新模型和节奏，字节计入漏桶。

GOP 仍由驱动管理（`GopPicSize = gop`，`IdrInterval = 0`）。时基固定后，不存在"时基只能在关键帧处改变"的约束，不需要由编码线程自己安排 IDR。60/1 与最大码率共同决定 CPB，Init 后照常校验实际 level。

驱动事实（UHD630，驱动 30.0.100.9805，API 1.35）：

- ExtBRC 在 VDENC 和非 LowPower 下都可用，QP 精确生效，`Update` 报告的帧大小与输出一致，重编和 PANIC 都可用。
- `MaxFrameSize`/`MaxFrameSizeI/P` 在 ExtBRC 下被保留但不起作用，帧上限只能在 `Update` 里执行。
- `MinFrameSize` 按比特解释，与文档的字节不符。不使用填充。
- VDENC 下 Submit→Sync 中位数 ExtBRC 6.7ms、VBR 14.1ms（2576×1616，非等码率对比）。

效果（UHD630，1080p，单次运行；对照为时基跟随内容节奏的最好变体）：5 租户（2 个视频 + 3 个滚动）L99 70→50ms，单租户滚动 192→93ms，视频与滚动 FPS 不变。四类内容按 GCC 目标、内容相位配对比较 QP：2Hz −2.4、15Hz −2.1、滚动 −0.5、视频 +0.04，都在一个 QP 档以内。Chrome 157 和 Chrome 89 都能正常解码，包括重编帧和保活帧。

### 运行期不 Reset

QSV 在编码器生命周期内不调用 `MFXVideoENCODE_Reset`：码率变化只改应用侧码控的快照，时基固定。尺寸或参数变化走完整的重新配置（新的 Configure/Init，校验实际参数并从 IDR 开始）。Init 后的 H.264 level 校验必须保留：驱动可能产生比协商接收 level 更高的实际 level（曾在 Chrome89 上出现实际 5.0、协商 4.2，画面停止）。

## NVENC

- 从 System32 动态加载，使用 D3D11 WDDM async 能力。
- 参数：P1 / ultra-low-latency、baseline / CAVLC、无 B 帧和 lookahead、zero-reorder delay、重复 SPS/PPS、limited-range BT.709；目标用法 4、CBR。
- 物理任务槽 ≥ max(4, async depth)，逻辑在途数仍受 async depth 限制。纹理注册、使用前 map、用后 unmap；事件完成之后才非阻塞读取码流。
- 每个已接受任务和 EOS 有 5 秒完成期限。
- 每个任务槽的完成事件分"已创建"和"已注册"两个阶段记录，清理只注销注册成功的事件，仅创建的只关闭句柄。初始化中途失败的回滚因此不会触发终态隔离，也不会把进程内的 NVENC 标成不可用。
- **终态隔离**：完成状态未知时，把实际 DLL、设备、session、注册、任务、事件和保留的源租约全部隔离到进程结束；进程级最多允许 16 个这样的 session，终态失败后后端不再接受新会话。原因：`DestroyEncoder` 不是可靠的取消原语，对未 flush 的工作可能无界等待；在驱动状态未知时释放源租约会允许生产者覆盖仍在被读的纹理。`CanReleaseInputs` / `HoldInputsUntilProcessExit` 把这种终态所有权告诉 EncoderWorker。

本机没有 NVIDIA 硬件，NVENC 的完成与隔离逻辑由注入式单元测试覆盖。

## H.264 level

level 同时约束单帧大小（MaxFS）和宏块吞吐（MaxMBPS）。一个 level 允许的大帧不一定能跑 60FPS。

- 宏块数 = `ceil(w/16) × ceil(h/16)`，且每个轴的宏块数满足 axis² ≤ 8 × MaxFS。
- FPS 上限 = `floor(MaxMBPS / 宏块数)`。

| level | MaxFS | MaxMBPS | 码率 / CPB |
|---|---|---|---|
| 3.1 | 3,600 | 108,000 | 14M |
| 4.2 | 8,704 | 522,240 | 50Mbps / 62,500kbit |
| 5.0 | 22,080 | 589,824 | |
| 5.1 | 36,864 | 983,040 | 240Mbps 级 |
| 5.2 | 36,864 | 2,073,600 | 240Mbps 级 |

例：3856×2176 = 241×136 = 32,776 宏块，5.1 只允许 29FPS，5.2 允许 63FPS。只看 MaxFS 无法得出"支持 4K60"。

`FitH264Sampling` 保持整张 atlas 的宽高比，偶数尺寸，单轴不超过 4096，取 min(MaxFS, MaxMBPS/FPS)，用有界迭代修正取整。服务端先在 FPS=1 下拟合适配后的几何，再按得到的尺寸给所有降级偏好算出 FPS 上限，Comp 与 EncoderWorker 使用同一个上限；码率与 VBV 也受协商 level 约束。

**接收能力**：画面按设备物理像素串流，所以客户端声明的 level 要覆盖物理屏幕（`screen × devicePixelRatio`，界面缩放不改变它）在 60FPS 下的 MaxFS、单轴与 MaxMBPS。所需 level 取 4.2 / 5.0 / 5.1 / 5.2 中最低的满足者，超出 5.2 时取 5.2（由 `FitH264Sampling` 缩小）；不声明 3.x，因为它同时把码率限制在 14–20Mbps。所需 level 按物理尺寸探测，每个更低的 level 按同宽高比缩到该 level 60FPS 能承载的尺寸探测，全部并行、每项 1500ms 超时，页面内按（codecs、物理尺寸）缓存含进行中的请求。安全上下文用 `VideoDecoder.isConfigSupported`，否则用 MediaCapabilities `type:'webrtc'`。选择顺序：第一个 `supported` 的 level；没有肯定结果时，第一个不是 `rejected` 的 level（`timeout/error/unavailable` 不是能力上限的证据，Chromium 的 WebRTC 接收端也不按 SDP level 选择解码器）；只有全部明确拒绝或没有 constrained-baseline mode1 时才保留浏览器默认 offer（`native`，通常是 `42e01f`，约 720p30）。每档结果、探测来源和所需尺寸进入诊断采样，原因文本直接显示在统计叠层（叠层不接收指针事件，不能依赖悬停提示）。客户端只改写 constrained-baseline、`packetization-mode=1` 的 H.264 视频 payload 的 `profile-level-id`；SDK 声明 `level-asymmetry-allowed=1`、最高 5.2，再应用客户端声明的接收上限。

## WebRTC 适配

- `TextureSource` 是 screencast 源。每次 fresh/force 帧提交前调用原生 `AdaptFrame`，以原始 atlas 尺寸取得丢帧决定、编码尺寸和 `max_fps`，然后建立匹配的布局屏障。GPU 缩放整张 atlas，X/Y 比例分别传播，不裁剪 plane，不改页面 DPR。同一输入在编码提交时不会再被适配一次。
- patch 0014 为 RemoteKit 的 screencast 打开上游的 BALANCED 与质量缩放（上游默认把 screencast 的 BALANCED 映射为保持分辨率并关闭该缩放器）。只改资格，算法与阈值保持上游实现。
- 新的编码尺寸必然建立新的布局屏障，旧的在途结果不能贴上新布局的身份。
- `SetRates` 提供目标码率和观测输入 FPS（在外部接口处取整）。那个 FPS 不是独立的 GCC 帧率目标，也不是无条件的源上限。

### 码控声明

外部编码器的 `EncoderInfo`：native handle 输入、硬件加速、对齐 2、缩放 QP 阈值 24/37、`is_qp_trusted = true`、**`has_trusted_rate_controller = false`**。

**QP 来源**：QualityScaler 只看编码器报告的 QP。QSV 通过 `mfxExtEncodedFrameInfo` 返回整帧平均亮度 QP（初始化时 Query 确认驱动支持，不支持即初始化失败），NVENC 返回帧平均 QP，SDK 原样交给 WebRTC，不再解析码流。曾经 QSV 不报 QP、SDK 用 H.264 解析器取最后一个 slice 头的 QP 代替：slice 头 QP 不含宏块级量化，静态文字上恒为 26，而硬件整帧 QP 是 10–16。26 高于升档阈值 24，即使样本足够，Auto 下被降下来的分辨率也永远不会恢复。

后者很关键。现场诊断发现硬件编码的实际输出超出码率预算，而当时声明了可信码控，WebRTC 的编码前超发丢帧保护因此被关掉了。改为不可信后保护恢复。仅这一项把发送队列均值从 72ms 降到约 69ms、marker p95 从 463ms 降到 425ms，最差窗口反而从 269ms 升到 329ms——声明正确是必要条件，但单独并不够。现在 QSV 由应用侧码控逐帧约束帧大小，这条保护在 ExtBRC 下实测不再触发（媒体优化丢帧为 0），声明仍保持不可信。硬件"速率更新成功"不代表实际输出已经跟上预算，仍需观测编码字节和发送排队。

### 发送节奏

SDK 在没有显式冲突的 field trial 时，设置 `WebRTC-ProbingScreenshareBwe = 1.1,2875,80,40,-60,3`，即原生 screenshare ALR 的 pacing 因子 1.1，保留上游 2875ms 队列参数和 ALR 探测预算。显式 trial 优先。这条路径要求协商了 transport-sequence 扩展且未启用 RFC8888；诊断分别报告 trial 配置和实际是否适用。

- 只调原生发送节奏；GCC 仍决定目标与实际 pacing 速率，没有第二个带宽控制器。
- 2875ms 是排队较长时提高排空速率的参数，不是旧包 TTL，也不是延迟上限。不能从发送字节反推哪个分支生效。
- 1.1 的效果（基线→1.1→回到基线）：首/次运动段发送队列均值 49/21 → 23/12 → 58/21ms，marker p95 299/174 → 171/146 → 359/180ms，提交约 46–47FPS 不变，低 FPS 停稳画质不变。这是队列和延迟的改善，不是帧率提升；代价是接收端末包→提交 p95 从约 38ms 升到约 51ms。
- 1.5 被否决：首段丢包 490、NACK 144、RTX 2282（对照 49），RTT 20→91ms，尽管 marker p95 也降了。

接收端的 playout 设置见[客户端呈现](presentation.md#接收端缓冲)。

## 代码位置

- `endpoint/src/media/encoder_worker.*`、`qsv_encoder.*`、`qsv_rate_controller.*`、`nvenc_encoder.*`、`gpu_device.*`
- `endpoint/src/media/sampling.hpp`（level 表与采样拟合）、`encoders.*`（SDK 编码回调与编码器注册）、`adapter.*`（适配器选择）
- `browser/sdk/rtc_video_source.cc`（TextureSource 与 AdaptFrame）、`rtc_encoder.cc`（ExternalEncoder 与 EncoderInfo）、`rtc_peer.cc`（peer、field trial、playout delay）
- `control/client/media/receive-profile.ts`（接收能力探测）
- `patches/0014-webrtc-screenshare-adaptation.patch`
