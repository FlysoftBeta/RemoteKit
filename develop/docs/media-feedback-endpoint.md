# Endpoint 媒体反馈观测接线

本轮只连接观测，不调整源 pacer、capture fps 或 QSV 名义帧率。

## 接收与身份

`media_feedback.hpp` 存放一个受 mutex 保护的最新有效样本。SDK DataChannel 回调识别 `media.feedback` 后直接交给该槽，不进入通用 events 队列或 input 队列，不增加 `inputRejected`。过量有效消息覆盖旧样本；无效消息只增加独立 `feedbackRejected`，不污染 seq 基线或旧有效值。

`PublishLayout` 绑定当前 peer、layout epoch、output generation 和实际布局 plane ID 集合。断开及输出重建开始时清空样本；只有连接更换重置 seq，layout epoch/output generation 变化保留本连接 seq，拒绝低序号重放。相同身份下再次发布布局不重置年龄或基线。反馈年龄由 Endpoint 收包 QPC 与读 stats 时的本地 QPC 计算，不使用客户端时钟。

校验 version=1、seq 为 1..JS safe integer 上限的递增整数、peer/epoch/generation 匹配、visible 为 boolean。windowMs 为有限 1..600000ms；rafSamples 为整数 0..512；可选 displayHzEstimate 为 10..250Hz 且 visible=true/rafSamples≥20；可选 RTT 为 0..60000ms；窗口 frame/loss/drop 计数为 0..1e9 整数。planes 最多64项，ID 必须属于当前布局且不能重复；可选 frames 使用同样整数边界。消息最多16KiB。未知字段忽略，不将缺失测量填成0。

Stats 给出 `feedbackAccepted/feedbackRejected/feedbackReplaced` 累计计数；最新样本存在时给出 `feedbackAgeMs/feedbackSeq/feedbackVisible/feedbackWindowMs/feedbackRafSamples/feedbackPlanes` 及可选 `feedbackDisplayHzEstimate/feedbackDecodedFrames/feedbackVideoFrames/feedbackPacketsLost/feedbackFramesDropped/feedbackRoundTripTimeMs`。`feedbackLayoutEpoch/feedbackOutputGeneration` 保留身份便于核查。未知字段省略。

## 编码队列统计

`EncoderStats` 使用 atomic 保存常态计数，Snapshot 不读取 worker 的 queue/map。一个 Session 的多个 encoder 共用 Stats，因此 pending/inflight 是所有仍存活 worker 的合计，而不是最后一个 worker 的 map.size()。

- `encodePending`：等待 worker dequeue 的 job 数；不包括正在转换、调用硬件 submit 的 job。
- `encodeInflight`：已获硬件 accepted、尚未由 Complete/关闭清理移除的 job 数。两个瞬时值分别读取，不承诺多字段原子事务快照。
- `pendingReplaced`：Enqueue 替换旧 pending，以及硬件 busy 返回时存在更新 pending 导致旧 job 放弃。属于真正丢弃帧。
- `hardwareBusy`：硬件 Submit 返回 busy 的次数，不是 drop。保留重试时不增加 drop。
- `pausedDrops`：运行正常但码率暂停而拒绝的 Enqueue。failed 状态优先归 error，未配置/停止优先归 inactive，不重复归类。
- `errorDrops`：failed worker 拒绝 Enqueue、转换或硬件提交失败丢弃，以及 failed worker 清理时尚存的 job。SDK encoded 回传错误仍沿用现有 error/completed 语义，不冒充 queue drop。
- `inactiveDrops`：未配置或停止中的 worker 拒绝 Enqueue。
- `cancelledDrops`：正常停止/重配的剩余 queue/inflight 清理。
- `queueWaitUs/queueWaitSamples`：每次 dequeue 的 pending 驻留时间累计与样本数。busy 后重新入 pending 会重新计一段等待；不含 GPU 转换/硬件编码耗时，未 dequeue 就被替换的 job 不产生等待样本。

原 `encodeDropped` 保留总 drop 语义，分项不把 busy 次数混入 drop。新计数累计跨 encoder 重配；pending/inflight 随真实容器增减，正常 Stop/Drain 后归零。

## 验证状态

已写独立 CPU 测试 `endpoint/tests/media_feedback_tests.cpp`，覆盖身份、单调 seq、代次重置、最新值合并、有限值和整数边界、未知字段省略、plane 身份/重复、无效消息不污染基线及本地 QPC 年龄。未修改 CMake。

主实验重新开启干净采样窗口时暂停了所有编译/测试。主 Agent 随后确认采样清理完成并授权 CPU/正式构建窗口，验证结果如下：

- 独立 `media_feedback_tests.cpp` 编译运行通过，输出 `media feedback tests passed`。
- `encoder_stats_tests.cpp` 链接正式 Release `remotekit_media.lib`，调用真实 `EncoderStats::Snapshot()`，零值、非零分项、uint64 最大值和4线程 pending/inflight 原子快照/归零测试通过。没有创建 encoder 或 GPU device；这验证 Snapshot 边界，不覆盖硬件 busy/drop 的实际触发。
- `tools/build-endpoint.cmd`：Debug 默认目标编译链接通过，CTest `endpoint_core` 1/1 通过。
- `tools/build-endpoint.cmd package`：Release `endpoint_service` 编译链接通过。
- `git diff --check` 通过。测试临时产物在 `develop/tmp/media-feedback-cpu`，未修改 CMake。

没有启动 GPU 服务、Chrome、QSV probe 或 Chromium 构建。已向主 Agent 报告 CPU 窗口释放；真实 DataChannel 反馈、代次切换和各类队列计数的运行值由后续服务实验核查。

构建后审阅修正：同 peer 输出 generation 变化保留 seq，仅清样本/年龄，与客户端“本连接单调递增”的契约一致。PauseOutput 保留 peer 绑定但清空 epoch/generation，避免同连接输出 close/reopen 间接重置 seq。QSV probe 硬件窗口释放后，已补跑全部 feedback CPU 用例并通过，Debug 编译链接及 core 1/1、Release package 编译链接均再次通过。

最终 Endpoint service SHA256：

- Debug `build/endpoint/endpoint/endpoint_service.exe`：`f9565a823b6d3df31d0422af669647de55b71cc04d2e66f94d7527ce3361bc83`
- Release `build/endpoint-package/endpoint/endpoint_service.exe`：`87c53396dbb05969cdbf46714e5eedd5a72e0b9fc91a8646495810a7fba170a6`
