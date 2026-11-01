# Capture-to-atlas 源 GPU 重启恢复审计

2026-11-01，只读源码和既有日志；未改源码、构建、启动 GPU 或提交。Endpoint 退休修复已由独立 case 验证，本次不重新审计退休算法。

## 结论

源 GPU 重启已经到达 Endpoint，但被分类为不可恢复的 producer Failed。Endpoint 随后退出 MediaLoop，保留 RTC/DataChannel；Viewer 没收到布局失效，因此旧画面的 ready 一直为 true。Control 仍能访问活着的 Browser，也没有把媒体错误用于恢复决策。这不是 Chromium 没有重新启动 GPU。

最小修复方向是：**只把无显式原因的 Viz 连接丢失转成新资源代重建，复用现有同 RTC `output.close` → `OpenOutput(true)`；显式 GPU 写入/interop 失败继续报错。** 同时在重建开始和 terminal error 时先向 Viewer 发布新 epoch 的空布局，使旧画面和输入立即失效。最终方案由主 Agent 决定。

## 运行证据

- `develop/tmp/capture-to-atlas-retirement-diag/sessions/sessions/2/browser.log:2–4`：22:23:34.043 GPU exit−1，随后重新初始化，报告初始化耗时74ms。22:23:49.971 才配置 generation2，对应15秒后显式重连。
- 同 case `control.err:74`：GPU 故障后 `atlas producer failed status=4`，pool1/gen1/frame1167，producer_exited0、consumer device_reason0，ready_completed1167。故障已从 Browser publication 传至 Endpoint。
- 退休修复后的独立 case `capture-to-atlas-retirement-equal/control.err:70` 仍是相同媒体断点：status4、pool1/gen1/frame1032、producer_exited0、device_reason0、ready_completed1032。修复退休证明没有改变恢复分类。
- 既有15秒观测、相同 connection/RTP/canvas 与旧 ready 的完整记录见 `endpoint-retirement-runtime.md`；显式 RTC 重连可恢复，Browser 主进程退出也会触发恢复。
- 上述 GPU kill 时段的 Browser 日志没有 `RemoteKitCaptureToAtlas result_rejected` 或显式 `invalidated` 行。当前日志没有记录 host 的原始 disconnect reason；“匿名 pipe 断连”由进程故障、日志与以下源码控制流共同定位，建议修复时加入一条 host 分类日志，直接记录原始 reason/description 和新分类。

## 控制流与断链位置

|位置|当前行为|后果|
|---|---|---|
|Mojo `interface_endpoint_client.cc:689–698`|没有显式 disconnect reason 时，with-reason handler 收到 `(0, "")`|GPU/Viz 进程消失不会自动成为应用定义的可重配原因|
|`components/viz/host/client_frame_sink_video_capturer.cc:272–294`|配置过 CaptureToAtlas 后清 started/consumer；invalidated callback 的 bool 为 `reason == 1`，空原因补成 `Viz connection lost`；直接 return|匿名断连被当 fatal，且不会沿普通 capturer 的100ms reconnect 路径重连；不会重放旧 CSI slots，这一点应保留|
|`browser/gpu_atlas.cc:107–110`|CSI pool 已配置时 `OnStopped()` 不设置 restart|这是等待 capturer pipe typed reason 的设计，不能简单在这里盲目重启旧 pool|
|同文件 `ConfigureAtlasPool` 回调约738行|bool true 调 `ReconfigureNeeded`，false 调 `Lost`|匿名连接丢失进入 Lost|
|同文件 `Lost`/`PublishStatus` 约292/310行|停止捕获、保留 lease，发布 DeviceLost 或 Failed|本次 publication 是 Failed4，非 DeviceLost3|
|`endpoint/src/media/atlas_pool.cpp:155–168`|只把 ReconfigureNeeded5 映射 `Result::reconfigure`；Failed4 映射 error|分类传递正确，没有遗失 Browser 状态|
|`endpoint/src/service.cpp:869–905`|reconfigure 有同RTC close/open；error 只 Clear 本地 coordinate_readiness、写 stats.error/日志，再 break|恢复分支完全没有运行；错误分支没有向 Viewer 发失效或关闭 RTC|
|`control/server/control.ts:60–80`|reconcile 查询 Browser/view；observe 不消费 snapshot.stats.error；成功后清 endpointError|活着的 Browser/GPU 子进程故障不触发 Control 恢复|
|`control/client/transport.ts:64,495–522`|displayReady 只比较 frameGate、已显示 RTP/epoch；没有帧年龄超时；普通 error 消息也只更新文字|旧 RTP 和 epoch 没变化便仍 ready；RTC connected 不等于媒体继续生产|

Browser 主进程退出为什么可以恢复：Endpoint `Start()` 发现 `Alive()` false 后走 `Stop()`/`ClosePeer()` 并重启 Browser；peer/DataChannel 关闭让 Viewer 现有 reconnect policy 触发。GPU 子进程退出时 Browser 仍 Alive，故没有走该路径。

## 必须保留的失败边界

目前 Viz service `frame_sink_video_capturer_impl.cc:354–374` 使用 `ResetWithReason(reconfigure ? 1 : 0, reason)`。以下 fatal 原因具有非空字符串：

- context 创建时注册 `GPU context lost`（约333行）；
- `DidCopyFrame` 在非 typed pre-GPU cancellation 的空结果/格式/尺寸错误后报 `external destination copy failed`（约1532行）；
- delivery callback 连接在 Done 前丢失时报 `external destination delivery disconnected before Done`（约1876行）。

这些不能因“GPU之后可能重启”就变成成功，也不能继续使用旧 destination pool。typed `kCancelledBeforeGpu` 仍按现有失败帧重试，不计成功；本次不需要改该机制。无原因 transport loss 表示旧 generation 不再可用，重建新 generation 不会证明旧写入成功；旧 lease/fence 仍依现有真实完成证明退休，未证实完成的资源继续保留。

## 最小可实施方案供决策

### 分类

两个都不需要改 header/mojom/共享内存布局：

1. 最小差异：host 将 `reason == 1 || (reason == 0 && description.empty())` 分类为 reconfigure。现有 service 的显式 fatal 都有非空原因，保持 fatal。仅修改 Chromium host `.cc`。
2. 更明确的协议：service 将显式 fatal 的 reason 从0改为保留值2；host 明确接受0为 transport lost、1为 typed reconfigure，2及未知值为 fatal；保留原始描述并记录分类。修改 host 与 service 两个 `.cc`。该方案避免以后新增空字符串显式 fatal 时与 transport 混淆。

两者均保持 `capture_to_atlas_configured_` 对象一次性失效，不调用 `EstablishConnection` 复用旧 pool，不把旧 slots 宣告 free。新 capturer、新 generation、新资源沿 Browser 原有 output 创建流程产生。

### 状态转换

预期路径：`Running → ReconfigureNeeded(transport_lost) → Viewer旧epoch失效 → output.close → OpenOutput(true) → Starting → 新generation/epoch首帧 → Viewer ready`。

Endpoint 在 `Result::reconfigure` 分支开始、执行可能等待15秒的 `OpenOutput` 前，发布一个递增 epoch 的空布局。可复用 `PublishLayout` 与现有 no-visible-views 空布局格式；原因需要区分 recovering 和真的无可见页面，不能改变订阅/visibility。现有 Viewer layout handler会撤销 frameGate、plane owner、输入和 renderer ready，无需等新视频，也无需用帧超时猜测静态页面是否出错。随后新资源首帧采用另一个有效 epoch；旧编码/队列的 frame metadata 不得重新授权该失效 epoch。

`Result::error` 分支也先发空布局和明确 error，再退出。只发 `type:error` 不够，现有 Viewer只显示错误文字，displayReady仍可能为true。重建失败以及连续重建超过现有3次上限继续走该 terminal error；不要无界重试或静默 fallback。

Control 可以继续只负责 Browser/产品状态；同RTC重建不要求它换 RTC。若要在 Control 面板显示媒体故障，需另外消费 `snapshot.stats.error` 并避免 reconcile结尾立刻清掉它，这是可见性补充，不是恢复主路径的必要条件。

## 文件与构建影响

|文件|用途|构建范围|
|---|---|---|
|Chromium `components/viz/host/client_frame_sink_video_capturer.cc`|区分匿名连接丢失和显式fatal；分类日志|host局部增量及 Browser链接|
|Chromium `components/viz/service/frame_sinks/video_capture/frame_sink_video_capturer_impl.cc`|采用显式fatal reason2时才改|Viz service局部增量/链接|
|`patches/0007-capture-to-atlas.patch`、`patches/manifest.json`|保存Chromium tracked变更及hash|patchset检查；不需要增设header或mojom|
|`endpoint/src/service.cpp`|恢复/失败时先撤销Viewer旧布局；保留已有close/open重建|Endpoint增量|
|`control/test/track-processor.test.ts` / 相关layout测试|确认失效epoch空布局撤销ready/输入且新帧才恢复|CPU测试；产品transport可复用现有逻辑|

无需修改 `shared_atlas.h`、SDK ABI、mojom 或 capturer header，因此不引入公共header大范围重编。具体链接成本由现有out/dev依赖决定，仍需按项目约定单次调度增量构建。

## 有界验证建议

先做CPU级分类验证：无原因断连、typed reconfigure、显式GPU failure、未知reason分别得到预期类别；空布局新epoch立即撤销Viewer ready和输入，旧epoch queued帧不能恢复ready，新代首帧才可恢复。

运行只做一个既有D2条件case：初次CRC → kill该case源GPU → 同RTC自动恢复CRC（记录generation与真实canvas/RTP进展、ready撤销/恢复时刻）→ 导航/尺寸往返一次 → close/退休。不能手动重连帮它通过。保留原尺寸/CRC，不并发构建。显式fatal注入必须仍报错、无新帧成功/旧pool复用；Browser kill可沿现有恢复回归一次。重复故障上限及退休证明不足时应明确失败，不绕过安全门。

尚未实施或运行本方案；它不声称已解决GPU故障恢复。
