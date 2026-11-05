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

1. Endpoint 启动 Browser 之前，按 `--encoder=qsv|nvenc|auto`（默认 qsv）在对应厂商的适配器上实际初始化一次硬件编码器，成功的那块 GPU 的 LUID 被固定下来，并传给 Browser（见[渲染](rendering.md#gpu-适配器)）。
2. auto 模式下允许 QSV→NVENC 回退，但如果显式给了只对 QSV 有意义的设置，回退就是语义错误，直接失败。
3. 没有可用硬件编码器时在启动 Browser 之前就报错，不退回软件编码。

## EncoderWorker：帧的所有权

`EncoderWorker` 让 libwebrtc 的回调保持快速返回，同时限制硬件工作量，并保证每个源纹理的租约一直保留到真正的使用者结束。

- 一个可替换的待处理输入 + 后端在途工作（受 async depth 约束，默认 1）。替换待处理输入只丢弃尚未提交的工作，不取消硬件已接受的工作。
- 已接受的帧（排队 + 在途）最多 4 个，每帧同时持有一个 COM 引用和一个独立的 render-slot 租约。只保持 COM 纹理存活并不能阻止生产者覆盖它，所以租约必须单独持有。
- SDK native buffer 的租约和硬件 worker 的租约是两份，各自释放。
- 硬件 BUSY 时把同一个最早的任务推回队首。
- 速率更新等在途工作排空后再应用。码率为 0（暂停）会取消待应用的速率；恢复时请求 IDR，不重放暂停期间的旧速率。
- 失败是粘滞的：worker 进入清理；无法证明完成的输入转入后端隔离区，而不是释放。
- 计数分开记录：编码器 busy、待处理输入被替换、WebRTC 官方丢帧、硬件失败。只有一个笼统的"丢帧"计数无法定位瓶颈在哪一段。

默认值（服务端）：QSV、目标 36Mbps、最大 48Mbps、60FPS、尾 IDR 最小 150ms、GOP 120、缓冲时长 1000ms、async depth 1。CLI 可调范围：depth 1–8、TU 1–7、GOP 1–65535、缓冲 50–5000ms、目标 100k–50Mbps、最大 ≤60Mbps。

## QSV

### 会话与参数

- oneVPL 2.17 dispatcher，按 adapter LUID 选择硬件 D3D11 实现（实测运行时 API 1.35），拒绝软件实现。`MFXVideoCORE_SetHandle` 安装真实的 D3D11 设备，外部分配器提供真实的纹理 MemId。
- H.264 constrained baseline：`GopRefDist=1`、`NumRefFrame=1`，无 B 帧、无 lookahead。
- 生产默认：`TargetUsage=7`、`LowPower=ON`、VBR（TargetKbps / MaxKbps）。
- VBV = max(目标, 最大码率) × 缓冲时长 / 8，再受 level 的 CPB 上限约束。
- `RepeatPPS=ON`；ExtBRC、MBBRC 关闭；NAL HRD 一致性和 NAL/VCL VUI HRD 关闭。
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

### QSV 时基去抖

WebRTC 通过 `SetRates` 报告观测输入 FPS。QSV 的码控按名义帧率分配每帧预算，所以名义时基需要跟随实际内容节奏；但每次 60→59→58 的波动都重配时基会产生新序列和 IDR 突发。

`QsvCadencePolicy`：

- 观测值持续 1 秒严格低于当前时基的 80%，才降低时基，取该窗口内的最大观测值。
- 观测值严格高于当前时基的 125% 时，一次性恢复到 Configure 确定的合法上限。
- 边界值保持不变。暂停取消待处理的窗口。
- 后端报告低帧率窗口的到期时间，EncoderWorker 在在途编码排空后重放最后一次有效速率，不需要 WebRTC 再次发送相同参数，也不额外开定时线程。
- 时基有下限：QSV 至少在 CPB 里预留两帧，名义帧率越低每帧预算越大。时基不低于 `ceil(2 × 最大码率 / level CPB)`，否则驱动会把实际 level 抬到协商值之上（曾在 1FPS、高 VBR 上限时初始化为 level 5.0 而协商的是 4.2，编码停止）。
- 只改码率的 Reset 设置 `StartNewSequence=OFF`，保持序列；真正的时基变化设置 ON 并强制 IDR。
- 单层 `maxFps` 上调不保证触发 WebRTC 的 Configure，名义上限以最近一次真正的 Configure 为准。

效果（同输入串行对照）：首段运动发送队列均值 72→39ms、窗口峰值 270→167ms，稀疏页面 marker 到 video 提交 p95 463→282ms；新序列次数 17→4。与之配套的是恢复 WebRTC 的超发保护（见下文"码控声明"）。

被否决的替代方案及原因见[调优经验](tuning.md#编码)：固定 60FPS 时基、仅 BRC 提示、LowDelayBRC、动态 I/P 帧预算。

### Reset 与重新初始化

- 只有 `MFX_ERR_INCOMPATIBLE_VIDEO_PARAM`（-14）走"排空后同 session 重建"：关闭编码组件，在同一 session/设备上重新 Query/Init，校验实际参数，请求 IDR。不退出编码线程，不重建 RTC，不切换呈现后端。
- 触发示例：1168×752@60 初始 VBV 6000KB，随后请求 1FPS/38.2Mbps 返回 -14，重建后 VBV 约 9543KB。
- 其他 Reset 错误是明确的 worker 失败，-14 恢复不是掩盖编码语义变化的通用重试。
- 重建可能产生比协商接收 level 更高的实际 level（曾在 Chrome89 静态页 1FPS 重建后出现 level 5.0，而协商的是 4.2，导致画面停止），所以 Init 后的 level 校验必须保留。

## NVENC

- 从 System32 动态加载，使用 D3D11 WDDM async 能力。
- 参数：P1 / ultra-low-latency、baseline / CAVLC、无 B 帧和 lookahead、zero-reorder delay、重复 SPS/PPS、limited-range BT.709；目标用法 4、CBR。
- 物理任务槽 ≥ max(4, async depth)，逻辑在途数仍受 async depth 限制。纹理注册、使用前 map、用后 unmap；事件完成之后才非阻塞读取码流。
- 每个已接受任务和 EOS 有 5 秒完成期限。
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

**接收能力**：客户端并行探测 5.2（`avc1.42e034`，3856×2176@60）、5.1（`avc1.42e033`，同尺寸 @29）、4.2（`avc1.42e02a`，1936×1088@60），每项 1500ms 超时，页面内 8 项缓存（含进行中的请求）。网络失败不会被缓存成永久的编解码降级；只有编解码协商失败才逐级降档。SDK 声明 constrained baseline、`packetization-mode=1`、`level-asymmetry-allowed=1`，最高 5.2，再应用选定的接收上限。Chrome89 桌面版固定走 4.2：它的 SDP factory 默认（640×480@30）不是物理解码上限，实测能接受 1288×728 和 level 4.2 的 SPS；但它的 MediaCapabilities 对 `type:'webrtc'` 抛 TypeError，而文件解码能力不能代表 WebRTC 接收能力。

## WebRTC 适配

- `TextureSource` 是 screencast 源。每次 fresh/force 帧提交前调用原生 `AdaptFrame`，以原始 atlas 尺寸取得丢帧决定、编码尺寸和 `max_fps`，然后建立匹配的布局屏障。GPU 缩放整张 atlas，X/Y 比例分别传播，不裁剪 plane，不改页面 DPR。同一输入在编码提交时不会再被适配一次。
- patch 0014 为 RemoteKit 的 screencast 打开上游的 BALANCED 与质量缩放（上游默认把 screencast 的 BALANCED 映射为保持分辨率并关闭该缩放器）。只改资格，算法与阈值保持上游实现。
- 新的编码尺寸必然建立新的布局屏障，旧的在途结果不能贴上新布局的身份。
- `SetRates` 提供目标码率和观测输入 FPS（在外部接口处取整）。那个 FPS 不是独立的 GCC 帧率目标，也不是无条件的源上限。

### 码控声明

外部编码器的 `EncoderInfo`：native handle 输入、硬件加速、对齐 2、缩放 QP 阈值 24/37、`is_qp_trusted = true`（硬件返回 qp=-1 时用官方 H.264 解析器补 QP）、**`has_trusted_rate_controller = false`**。

后者很关键。现场诊断发现硬件编码的实际输出超出码率预算，而当时声明了可信码控，WebRTC 的编码前超发丢帧保护因此被关掉了。改为不可信后保护恢复。仅这一项把发送队列均值从 72ms 降到约 69ms、marker p95 从 463ms 降到 425ms，最差窗口反而从 269ms 升到 329ms——声明正确是必要条件，但单独并不够，配合时基去抖才得到上面的结果。硬件"速率更新成功"不代表实际输出已经跟上预算，仍需观测编码字节和发送排队。

### 发送节奏

SDK 在没有显式冲突的 field trial 时，设置 `WebRTC-ProbingScreenshareBwe = 1.1,2875,80,40,-60,3`，即原生 screenshare ALR 的 pacing 因子 1.1，保留上游 2875ms 队列参数和 ALR 探测预算。显式 trial 优先。这条路径要求协商了 transport-sequence 扩展且未启用 RFC8888；诊断分别报告 trial 配置和实际是否适用。

- 只调原生发送节奏；GCC 仍决定目标与实际 pacing 速率，没有第二个带宽控制器。
- 2875ms 是排队较长时提高排空速率的参数，不是旧包 TTL，也不是延迟上限。不能从发送字节反推哪个分支生效。
- 1.1 的效果（基线→1.1→回到基线）：首/次运动段发送队列均值 49/21 → 23/12 → 58/21ms，marker p95 299/174 → 171/146 → 359/180ms，提交约 46–47FPS 不变，低 FPS 停稳画质不变。这是队列和延迟的改善，不是帧率提升；代价是接收端末包→提交 p95 从约 38ms 升到约 51ms。
- 1.5 被否决：首段丢包 490、NACK 144、RTX 2282（对照 49），RTT 20→91ms，尽管 marker p95 也降了。

接收端的 playout 设置见[客户端呈现](presentation.md#接收端缓冲)。

## 代码位置

- `endpoint/src/media/encoder_worker.*`、`qsv_encoder.*`、`qsv_cadence_policy.hpp`、`nvenc_encoder.*`、`gpu_device.*`
- `endpoint/src/media/sampling.hpp`（level 表与采样拟合）、`encoders.*`（SDK 编码回调与编码器注册）、`adapter.*`（适配器选择）
- `browser/sdk/rtc_video_source.cc`（TextureSource 与 AdaptFrame）、`rtc_encoder.cc`（ExternalEncoder 与 EncoderInfo）、`rtc_peer.cc`（peer、field trial、playout delay）
- `control/client/media/receive-profile.ts`（接收能力探测）
- `patches/0014-webrtc-screenshare-adaptation.patch`
