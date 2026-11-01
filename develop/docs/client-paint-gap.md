# MSTP read → pending → canvas 的约 47FPS 缺口

2026-11-01。只读源码和既有 D2 正式数据，离线分析；没有修改产品源码、构建、启动浏览器/GPU或采样。结论是：**应用仍把 MSTP 帧合并到一次 rAF 准入；已读帧到成功 draw 的主要损失就是单 pending 被替换。after-work 开关对 MSTP 无效。现有日志没有 read/排 RAF/RAF 入口时刻，尚不能唯一分辨媒体投递 burst、错过刷新相位、迟 metadata 和主线程等待各占多少。**

后续FIFO2正式结果及CRC时序补充见 [FIFO2同步测量重叠](client-fifo2-crc-overlap.md)：FIFO2全部>40ms paint gap中，两路CRC实际工作加后一帧相关窗只覆盖20%；剩余overflow没有逐事件记录，不能按每秒一次CRC直接归因。

## 实际算法与计数含义

以下路径相对仓库根目录，行号对应本次调查时源码。

|位置|实际行为|
|---|---|
|`control/client/track-processor.ts:12`|构造 MSTP，native buffer 上限 1；它不等于应用 pending owner，也不等于解码背压。|
|`control/client/transport.ts:305–331`|持续 `await reader.read()`，读到帧后检查 source/尺寸/RTP；关闭旧 pending，`replaced++`，clone 当前帧为唯一 pending，尝试排 rAF，然后 finally close read 原帧。循环没有 timer，也没有等待 paint 完成才读下一帧。|
|`transport.ts:242–271`|有当前 source、pending、layout、匹配 RTP→epoch 和尺寸，且没有已排 rAF，才 `requestAnimationFrame`。同一时刻最多一个 rAF。执行时重新取**当时最新的 pending**并再次验证；有效就移为 latest、授权、同步绘制所有 plane，最后 close 旧 latest。|
|`transport.ts:245,256`|metadata 尚未到达时不排 RAF；已经排出的 RAF 若当时最新 pending 尚未匹配，也会空返。之后 read 或 metadata 消息再次尝试排队。|
|`transport.ts:474`|DataChannel frame metadata 记录实际 wire RTP→epoch，随后 `authorizeFrame()`。|
|`transport.ts:379–380`|MSTP 的 authorizeFrame 只是再次调用 scheduleProcessorPresentation，不直接画。|
|`transport.ts:342–377`|`frameCallbackRegistration` 的 before/after-work 判断只属于旧 video/rVFC pump；MSTP 不调用该 pump、不读取此选项。|
|`transport.ts:425–443`|真实 plane canvas 上 `drawImage(VideoFrame, crop…)` 成功返回后才记录 paintedAt、reportPresented；draw 抛错记 draw-failed，不计成功。|
|`transport.ts:123–130`|按 view 的 RTP+epoch 判新帧，成功新帧才增 canvas 并向 presented listener 通知；同帧重画不冒充新帧。|
|`transport.ts:396–399`、`tools/streaming-benchmark.js:109–145`|先完成各 plane draw，再同步调用 listener；正式工具先记录 paintedFrames，约每秒同步读同 RTP plane 的 CRC。CRC cost 阻塞当前 JS 调用栈，但 marker 的呈现时刻取 draw 后的 paintedAt，CRC 完成另报。|

所以当前“真实 canvas paint”确实是合格 plane 的成功绘制提交次数，既不是 decode，也不是 RAF/metadata 累计数。draw 返回仍不是 GPU 完成或物理扫描输出，沿用项目已有验收口径。

pending 替换发生的精确条件只有一个：**新的有效 read 到来时，之前 pending 尚未被 RAF 取走**。它没有区分之前是在等 metadata、等下一刷新、还是已排的 RAF 被主线程延后。因此 replaced 本身不是 metadata 错误计数，也不是 GPU draw 失败计数。

`control/test/track-processor.test.ts:131` 的既有测试明确覆盖“两次 read、一次 RAF，只画最后 owner”；`:156` 覆盖迟 metadata 后仍要再等一次 RAF。未运行测试，以上为源码审阅。

## D2 原始数据对账

数据：`develop/tmp/capture-to-atlas-d2-B-fixed52-t2`、`capture-to-atlas-d2-B-fixed56-t2` 中的 `metrics/client-metrics.jsonl`（通过现有 streaming_metrics loader 重组）、`presentation-raw-{0,1}.json`。没有改写 case 文件。

|组/peer|read|replaced|期末 pending|authorized / RAF admitted|成功 canvas 诊断|正式窗口 paint|
|---|---:|---:|---:|---:|---:|---:|
|B52/0|2330|218|0|2112|2112|2112|
|B52/1|2335|218|1|2116|2116|2115|
|B56/0|2185|231|0|1954|1954|1953|
|B56/1|2480|330|0|2150|2150|2149|

每路满足 read = replaced + authorized + 期末 pending。diagnostic reset 在正式 startedAt 之前，故个别路成功 canvas 比正式 paintedFrames 多 1，不是 draw 丢失。B52 RAF callbacks=admitted；B56 peer0 callbacks1955、admitted1954，仅一次空返；B56 peer1均2150。四路 invalid/stale=0、skippedRenderer为空，RTP+epoch 重复和 missingPaintSnapshot=0。**应用读出到授权的差额已经被 pending 替换完整解释，授权后没有持续 paint 损失。**

MSTP 内建 total/discarded 从 processor 创建累计，应用 read/replaced 从暖机后 reset；不能用它们直接相减求本正式窗口的 native 丢帧数。

## 刷新节拍与间隔

benchmark 的 clientRaf 独立链会持续登记 rAF（`tools/streaming-benchmark.js:91–92`），记录参数 `now`，即 rAF timestamp；不是回调入口 `performance.now()`。

|组/peer|RAF timestamp 计数 / Hz|RAF 间隔 p50/p95 ms|>24ms RAF 间隔数|paint 间隔 p50/p95 ms|paint 间隔 ≥24ms 数|
|---|---|---|---:|---|---:|
|B52/0|2698 / 59.94|16.6 / 17.1|2|16.8 / 34.4|544|
|B52/1|2697 / 59.92|16.6 / 17.1|3|16.9 / 34.3|538|
|B56/0|2699 / 59.94|16.6 / 17.1|1|17.0 / 37.6|637|
|B56/1|2699 / 59.94|16.6 / 17.1|1|16.9 / 34.2|505|

各路 visibility 记录始终 visible。实际刷新 timestamp 没有被节流到约47Hz；paint 间隔大量落在约一次/两次刷新范围，符合“收到的帧合并到下次 RAF”的行为。**timestamp 60Hz 不证明回调准时执行**，也不证明 read 在当轮 rendering steps 前到达；当前没有实际 RAF entry time，不能据此排除主线程调度等待。

B52 的同 RTP metadata→成功 paint：peer0 p50 10.8/p95 17.9ms，peer1 10.9/18.1ms；全部 metadata 早于对应 paint。该间隔包含 metadata 与 read 的相对时机、RAF 等待、draw，**不能命名成 read→paint 等待**。现有 authorizeWaitMs 等字段依赖旧 video() 观察，MSTP 没调用它，samples=0；不能读成等待为0。

辅助离线模型：把 B52 metadata 按“下一次 clientRaf timestamp”分桶，每桶取最新 RTP，得到2173/2162个非空桶（48.27/48.03FPS），165/175个同桶多余 metadata；正式 paint2112/2115。它说明到达节拍并非均匀52Hz，在60Hz合并器前有足够的相位碰撞，但 metadata 不是 read、timestamp 不是入口，不能把模型的165/175当真实218替换的逐帧归因。B56 peer1 raw metadata 达2400条上限并截掉前段，不应以其完整45秒做此模型。

## CRC 是否造成这个平台

B52 45次 CRC同步工作总耗时（markerCompletedAt−paintedAt）为448.9/501.6ms；B56为556.9/552.1ms。成本有真实尾部：B52 readback p95 24/26.7ms。它在 dispatchPaint 的同步 listener 内，确实会拖延 read/rAF/main task。

但大量长 paint 间隔不紧邻 CRC：把“间隔起点位于本次 CRC paintedAt−1ms 到 completedAt+1ms，或间隔跨过 CRC起点”记为邻近，B52 ≥24ms gap中仅14/18个邻近，530/520个在其外；B56为24/20邻近，613/485个在外。这个局部判定不排除 CRC 对后续队列的间接作用，但不支持把整个47FPS平台归给每秒一次CRC。CRC应保留在所有正式比较中。

## 已确定与待测假设

确定：没有 timer 限制这条 read→paint路径；有明确一次 rAF准入等待；after-work/before-work对MSTP是无操作；应用丢帧主要是单pending最新帧替换；成功授权基本全部成功draw；页面刷新timestamp仍约60Hz。

未确定：读出的帧是否被native媒体task成批投递；request RAF是否刚好错过当轮；metadata迟于read的占比；callback实际入口是否晚于timestamp；CRC/其他任务/GPU同步对这些等待的贡献。当前没有证据说明 Chromium 或 GPU 存在硬性47FPS上限，也没有证据支持再提高源FPS。

本地 Chromium 的 MSTP native queue 本身没有 RAF门：`third_party/blink/renderer/modules/breakout_box/frame_queue_underlying_source.cc:257–350` 到帧后按pending pull投递；`:427–468` 又显式另post一个 EnqueueBlinkFrame task，注释解释用于避免JS read循环饿死其他task。因此媒体task排队是可检验假设，不能直接从read总数归为已证明原因。

## 最小必要 profile 与有界对照

建议先只给 MSTP 增加一个关闭默认的、固定容量记录，保留同一时钟，字段足够回答当前问题即可：

- read resolve：RTP、entryNow、已有metadata的到达时刻/epoch、原pending RTP与创建时刻、是否已有 RAF、替换原因（waiting-metadata / RAF-pending）；尺寸/epoch不变时不重复记录。
- RAF request：requestNow、candidate RTP、request id；RAF callback：timestamp、entryNow、实际candidate RTP、准入或具体拒绝原因；draw结束继续复用现有paint记录。
- 替换时记 oldRtp/newRtp、oldReadAt、metadataReadyAt、RAF requestAt；允许直接算“等metadata/等RAF/入口晚到”三段，无需每帧console或扩展native trace。

在B52同配置两租户、CRC1Hz、原尺寸、相同fake60下，只做一个10秒诊断窗口。成功标准是所有replaced能按事件归类，read→RAF request→entry→paint时间分布完整；此组只定位，不冒充无profile验收。若不能解释至少95%的替换，保留未知量并检查记录容量/重置窗口，而不是扩矩阵。

调查最初提出可比较立即draw与RAF合并；**主Agent已选定更小的实验：保留RAF，每个刷新最多准入一帧，将单pending改为可选FIFO2候选**，避免只抬高同一刷新内的draw次数。默认latest1保持；FIFO2满时关闭最旧pending、保留最新两帧，仍验证准确RTP/epoch/尺寸。实现、74项测试和最终bundle指纹见 [FIFO2实施报告](client-fifo2-implementation.md)。唯一正式对照沿用两租户B52，latest1→fifo2，不提高source、不改变marker或分辨率；实际结果交runtime采样，本文没有预判收益。
