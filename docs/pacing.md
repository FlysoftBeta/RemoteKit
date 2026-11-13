# 节奏与补帧

Comp 决定何时向 Browser 请求一帧。本文描述节拍来源、背压、静止时的停止与唤醒，以及两类"补帧"：静止后的尾 IDR，和新布局/首次打开的呈现刷新。Begin/Slot/Fence 机制见[渲染](rendering.md)。

## 原则

- **需求驱动，而不是定时器驱动。** 网页有新内容时才渲染和编码；静态页面不消耗持续的渲染、编码和带宽预算。
- **只在提高"实际交付帧"时提高源帧率。** 源帧率本身不是优化目标。历史上 4 租户场景把源从 16FPS 提到 60FPS，客户端反而从约 15FPS 降到约 5FPS、p95 超过 1.6 秒：多余的源帧在共享 GPU 上和下游争资源，最后被丢掉。
- **观察到的输入帧率不能变成永久上限。** WebRTC 通过 `SetRates` 报告的输入 FPS 估计如果被当作源上限，一次临时变慢就会把估计压低，估计又反过来阻止源恢复，形成反馈陷阱。
- **网络和质量适配交给 WebRTC。** Comp 不做自己的延迟阈值、DPR 因子、码率/帧率预设。

## Comp 节拍

`CompCadence` 维护当前节拍（FPS）：

- **上限** = min(客户端能力上限, 官方限制)。客户端能力上限来自 Viewer 显式上报的刷新能力，未知时为 60；官方限制包括 WebRTC 的 `max_fps`、协商的 H.264 level 按当前编码尺寸算出的宏块吞吐上限（见[编码](encoding.md#h264-level)），以及编码器自身上限（服务端 240FPS，外部编码器 CLI 上限 120）。
- **暂停**：`SetRates` 目标码率为 0 或观测输入 FPS 为 0 时，停止发 Begin；恢复时请求关键帧。
- **起始** = min(上限, 观测 FPS)。
- **恢复**：每 250ms，如果有空闲容量，节拍翻倍或加 1，直到上限。观测 FPS 只是恢复时的起点提示。

调度用绝对期限：`CompBeginSchedule` 记录下一次 Begin 的绝对时间，成功发出后 = now + interval。等待使用高精度可等待定时器（`CREATE_WAITABLE_TIMER_HIGH_RESOLUTION`，标志 0x2）加渲染事件，`WaitForMultipleObjects` 超时 2ms，短期限路径每次最多等 1ms。高精度定时器创建失败是启动错误，不悄悄退回粗粒度定时器——那会改变节拍契约。

历史教训：Browser 端 `RepeatingTimer` 配置 60/30/20FPS 实际只跑出约 34/22.5/16FPS（定时器量化）；基于"now − last ≥ interval"的轮询发布在 55FPS 源下只发布了 42FPS。两者的修正都是绝对期限。现在节拍只有 Comp 这一个时钟。

## Slot 深度与背压

`CompPacing` 管理 4 个 Slot 中"允许同时在途"的数量（活动深度）：

- 起始深度 1，最大 4。
- Slot 饱和且编码器没有积压时，深度 +1；编码器有积压时深度减小，最低 1。
- 缩小深度不会抢占或取消已经占用的 Slot。
- Ready/Reject 必须精确匹配 (generation, slot, value)，迟到的旧完成不能改动占用同一 Slot 的新预留。
- force 请求可以绕过 Idle 抑制，但绕不过 Stop 和容量。

Comp 发 Begin 的门禁：RTC 已授权、产品可见、输出存在、WebRTC 码率/FPS 为正、有可用 Slot、不在 Idle（或带 force 或有 Wake）。

经验：生产者的接纳队列几乎为空时（实测 Work 排队 <0.01ms），加深深度只会增加滞留中的工作，解决不了接收端的瓶颈。

## 跨租户 GPU 准入

同一块 GPU 上的所有租户共用一个准入池（`FrameAdmission`，Service 持有，按 adapter LUID 区分），最多 3 帧同时在途。每个租户的 Comp 在发 Begin 前领一张许可：

- 先在本地预留 Slot，再申请许可，最后才发给 SDK。许可按 (incarnation, generation, slot, value) 记账，只归还一次：发送回滚、匹配的 Reject 或观察到的 consumed fence。无法证明 GPU 已完成的工作在拆除时继续占着许可。
- 尾 IDR、呈现刷新、恢复采样、保活这些 force Begin 走同一条路。
- 每个租户最多一个等待中的申请。没拿到许可的 Begin 不轮询，等自己的自动复位事件；这个事件和渲染事件、定时器一起在 Comp 的等待里。不允许发 Begin 时（断线、未授权、暂停、码率为 0）撤回申请。
- 授予顺序分两类：最近 500ms 内收到过用户输入的租户（交互类）先，其余按先来先得。客户端算的惯性滚动在惯性期间持续发送滚动输入，所以惯性也算交互。等待中收到输入会升级为交互类。

为什么需要它：GPU 饱和时（平板 5 租户，2576×1616 atlas，视频引擎约 94%），每个租户各自按节拍发 Begin，驱动按提交顺序排队，滚动帧排在视频帧后面，渲染→VPP→编码的整段延迟拉长。限制在途帧数把排队挪到 Endpoint 自己手里，再让交互租户插队。

效果（UHD630，ExtBRC，单次运行，L99 含许可等待）：平板 5 租户 L99 183→112ms、滚动 FPS 25→34、视频 FPS 41→39；1080p 5 租户 GPU 未饱和，L99 约 50ms，在噪声范围内不变。

## Idle 与 Wake

页面静止时 Rend 回复 `Reject(Idle)`，并记录确立 Idle 的完整身份 (g, s, v)。Comp 停止常规 Begin。

Chromium 之后再产生 BeginFrame 需求（新的 invalidation、rAF 等）时，Rend 发一次 `Wake`，携带最后那次 Idle 的身份：

- Wake 只解除 Idle 抑制，不是成功帧通知，不释放 Slot，也不绕过任何门禁。
- 不相关或过期代次的 Wake 不能唤醒新代资源。
- 后续 Begin 被观察到时，不清除最后一个有效的 Idle 证明——否则生产者就失去了合法报告 Wake 的唯一身份。
- Comp 在下一个 value 处设置 Wake 屏障：在途的旧 Idle 晚于 Wake 到达时，不能把刚恢复的需求重新挂起。
- 仍有 rAF 等后续渲染需求、只是这一帧没有像素更新时，不能误报 Idle。
- Stop 之后不再唤醒。

Wake 事件会中断 Comp 的定时等待，并把下一次期限清零（`wake_pending`），让 Comp 尽快请求新帧。如果此时 Slot 都被占用或 SDK 暂忙，这个优先请求保留到成功发出 Begin，之后再恢复正常间隔。为了不丢事件，事件队列的 Push+SetEvent 与 Drain+ResetEvent 共用一把锁（否则在排空和 ResetEvent 之间到达的事件会丢失）。

## 尾 IDR：每段内容一次

目的：一段运动结束后补一个干净的帧内编码帧，让静态页面不停留在最后一个预测帧的画质；同时不能把静止时间变成周期性 IDR 循环。

**时机**（`IdleIdrPolicy`）：

- 源到达间隔用 EWMA（旧 0.8 + 新 0.2）跟踪；间隔 ≤0 或 >2000ms 视为无效并重置估计。
- 尾延迟 = `ceil(min(1000ms, max(最小值, 3 × 平均间隔)))`，最小值默认 150ms；设为 0 禁用。
- 内容身份 = generation + 采集时间戳（有真实时间戳时），否则 generation + `frame_id`。强制重拷且内容身份不变的帧不会重新启动尾计时。

**执行**（`TailIdrAttempt`）：

- 状态 `source_wait → encoding → succeeded | failed`，原子转换。取消（CAS）只允许在 `source_wait` 阶段。
- 尾帧需要重新取得一个合法 Slot（force Begin），不能永久持有 latest 帧的租约——那会在深度 1 时堵死所有接纳。
- 进入 `encoding` 后没有任何定时器会发起另一次尝试。慢编码器不能导致多个 IDR 重叠。
- 重试间隔 250ms；开始新尝试前先取消过时的 source wait；force 尾 Begin 最多 3 次。独立的呈现刷新优先处理。
- **只有带标记的关键帧真正通过 SDK 发布成功才算完成。** "已请求 IDR"、"已提交纹理"、"编码回调已到达"都更弱；在这些阶段清除尾状态会让静态接收端永久停留在旧画质。

## 静止保活帧

页面静止时，Comp 每 2.5 秒发一次保活 Begin：force、非关键帧、带 keepalive 标记，重拷最新缓存，编出一个几乎为空的 P 帧。条件是 RTC 已连接且已授权、Slot 全空闲，并且没有尾 IDR、呈现刷新或恢复采样正在进行。

原因在接收端。WebRTC 的 `VideoReceiveStream2` 超过 3 秒（`kMaxWaitForFrame`）没有可解码帧，而最近 5 秒内收到过包时，会判定流卡住并请求关键帧。所以每次静止超过 3 秒后，下一段滚动的第一帧都会变成一次 PLI 驱动的 IDR，正好压在交互开始的时刻。实测去掉保活后，51 次滚动起点全部变成 IDR（1080p 5 租户 36 次 PLI），保留时为 0。

保活帧的约束：

- 不是内容帧：不重启尾 IDR 计时，也不进入码控的节奏估计与复杂度模型（码控用"上一个 P 帧 QP + 6"编码它），但它的字节计入码控漏桶。
- 不产生关键帧，也不清除任何刷新或尾 IDR 状态。

## 适配恢复采样

WebRTC 在 BALANCED（质量"自动"）下可以立即降低分辨率（启动时码率不足的初始丢帧、QP 偏高、编码耗时过高），但升回去要靠新样本：QualityScaler 至少 60 个带 QP 的帧，编码耗时估计器也要连续样本。静态页面在尾 IDR 之后就不再出帧，限制会一直保持——实测静止文字在 600×342 停留 200 秒以上，之后间歇浏览也凑不够样本。

`CompRecoverySampling` 是 Comp 的显式状态：`content → sampling → restoring → content`。

- 每个 Begin 期限，Comp 经 `remotekit_rtc_get_source_restrictions` 读 WebRTC sink 当前要求的像素上限与帧率上限（只读，不接纳也不丢帧）。偏好为 BALANCED 且像素上限低于 atlas 原生像素时进入 `sampling`。
- `sampling` 期间 Begin 带 force，绕过 Idle 抑制，按 WebRTC 给的帧率上限与常规节拍出帧；仍受 Stop、Slot 容量、背压与媒体暂停门禁约束。
- 限制解除后进入 `restoring`：再成功提交一帧，让静态接收端拿到原生尺寸的画面，然后回到普通 Idle 与尾 IDR 规则。偏好不是 BALANCED、RTC 未连接或输出暂停时直接回到 `content`。
- 分辨率、码率与阈值仍完全由 WebRTC 决定，Comp 只保证样本存在。实测静止文字 21 秒恢复到原生 1608×920；360kbps 限速下动态内容降到 402×230，解除后 32 秒恢复；恢复后静止期间不再出内容帧（只有保活帧）。
- 统计叠层在编码尺寸旁显示视频平面的物理像素尺寸和 WebRTC 的质量受限原因（编码负载 / 带宽 / 其他），被降档时一眼可见。

## 呈现刷新（首帧与布局补帧）

目的：新打开的 Viewer、解锁后、或布局换代后，客户端还没有拿到与当前布局匹配的帧时，在**原连接上**补出一个可用关键帧，peer、track 和呈现架构都不变。

`PresentationRefresh` 与内容尾 IDR 是两套独立记账：

- **作用域** = peer + 授权代次 + 呈现屏障 Key（barrier, generation, epoch）。作用域变化取消旧作用域中仍在等源的工作。
- 新作用域从 pending 开始。重试和 force 节流 1000ms；单次源等待期限 = max(1000ms, 2 × 源间隔)。
- 一个尝试独占刷新，直到实际发布成功，或者源/丢帧/发送失败。重复请求被吸收；成功后的新请求开启新尝试。
- 进入编码后不会因超时并行发起另一次刷新：源等待可以取消，硬件持有不能。
- 只有带标记的 IDR 通过布局屏障并由 SDK 成功发布，才清除 pending。源帧被丢、编码失败、发送失败都让刷新保持 pending。
- 客户端在"文档前台、当前完整布局屏障已 ACK、平面 current 且非 stale、bounds 为正，但还没有匹配帧"时，限频（每秒最多一次）发送 `media.refresh`，同时保持 video 与输入门禁。

旧实现把"纹理提交成功"当作恢复完成：把呈现 ACK 人为延迟 4.5 秒即可复现——约 5.6 秒时触发了切换到 Canvas 的回退，而此时第一个 RTP 都还没发出。改为以发布成功为完成条件后，ACK→元数据约 41ms、ACK→匹配视频帧约 85ms，peer 保持。同时删除了按超时切换呈现后端的路径：首帧或元数据迟到时，在原连接上补帧并保持门禁，能力或协议失败明确报错。

## 观测 FPS 与编码器

`SetRates` 报告的观测输入 FPS 只用于 Comp 节拍与 NVENC；QSV 时基固定为 60/1，每帧预算由应用侧码控按真实帧间隔决定，见[编码](encoding.md#qsv-应用侧码控extbrc)。

## 代码位置

- 节拍、深度、Begin 调度：`endpoint/src/media/comp_pacing.hpp`
- Slot 状态与 Fence 观察：`endpoint/src/media/render_slots.*`
- 跨租户 GPU 准入：`endpoint/src/media/frame_admission.*`（Service 持有）；输入到达时间由 `rtc/channel.cpp` 经 `MediaPipeline::InputReceived` 交给 `CompEngine::InputReceived`
- 静止保活：`endpoint/src/media/idle_keepalive.hpp`
- 尾 IDR：`endpoint/src/media/idle_idr.hpp`、`tail_refresh.hpp`
- 呈现刷新：`endpoint/src/media/presentation_refresh.hpp`
- Comp 循环：`endpoint/src/media/comp_engine.*`（CompEngine），由 `endpoint/src/session/pipeline.*`（MediaPipeline）驱动；输出生命周期 `session/output.*`
- 多租户调度测量：`tools/measure/schedlab/`，见[诊断与测量](diagnostics.md#调度实验台-schedlab)
