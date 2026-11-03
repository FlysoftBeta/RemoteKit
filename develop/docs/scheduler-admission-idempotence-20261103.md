# Scheduler BeginFrame 接纳幂等性（2026-11-03）

## 范围与源码结论

本批按 root 确认的契约修补 `DisplayScheduler::OnBeginFrameContinuation`：同一个当前有效 BeginFrameId、相同不可变 `frame_time` 最多接纳一个 deadline interval。检查位于排空上个 deadline 之前；已完成 interval 的当前身份仍保留，因此随后相同交付也不重新开启 interval。

源码核对：`ExternalBeginFrameSource::GetMissedBeginFrameArgs` 复制当前 args，仅将 `type` 改为 MISSED；`StartObservingBeginFrames` 可同步接纳该 MISSED，普通 observer fanout 之后还有 scheduler-client 交付。Scheduler 保存 args 后会扣减 `deadline`，所以不能用整个 args、type 或 deadline 判断身份。未发现要求相同有效 ID/time 开启第二个 interval 的正常契约。

新增有序补丁 `0012-scheduler-begin-frame-admission.patch`，manifest 保存实际 SHA256。仅在当前 args 与传入 args 均有效、sequence 有效、完整 ID 和 frame_time 相同的情况下返回；不同 ID/time 及无效输入沿原路径处理。没有修改 Mojo completion、未知/重复完成检查、retired ID、late-frame 绘制、GPU Fence 或跨进程协议。

## 正向检查与边界

`browser/begin_frame_probe.cc` 新增 `--scheduler-admission` 正向 CPU 单元检查，直接调用真实 Scheduler continuation：MISSED/NORMAL 相同身份合并；deadline 完成后相同当前身份不再启动 interval；连续新 ID 正常接纳，并在必要时排空上一 interval；每个新身份按序恰好一次完成。用 deadline schedule 计数验证重复接纳没有调度副作用。

本批不构造崩溃复现、不执行旧负向开关、不启动 GPU、不构建。源码与补丁状态检查通过不等于编译或运行通过；待 root 审阅后，由独占 builder 在既有 out/dev 增量构建并运行上述正向模式。

项目源码只通过 `tools/chromium.py stage` 同步到 Chromium overlay。`tools/patchset.py status` 在隔离快照中撤回已应用补丁并按序重放，用于验证补丁可逆与重放，不改变保留的其他项目文件。
