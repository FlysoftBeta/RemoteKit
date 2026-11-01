# 持续性能目标

用户最新指令：继续接手五项建议并自行实验改进，直到实际呈现≥50FPS、Pixel marker端到端p95≤100ms，或用户明确放宽/停止。阶段交付不终止工作。此前32a8313包是可复现checkpoint，不是目标完成。

最新用户修正：保留Chrome89支持；重载先验收3租户，若有界实验仍无明显成效则转2租户。优先TU7最快预设与较高码率，比较VDEnc/Hybrid跨Session混跑。首轮采用每peer48Mbps预算、目标36/max44Mbps，保留传输余量与原1080p/marker；单租户与所选重载仍须同组≥50FPS/p95≤100ms。四租户/TU1只保留历史对照。新增路径均默认关闭，不以删旧客户端实现优化。

## 验收与基线

- Headed客户端、H264、UHD630 oneVPL异步编码；1/4租户、RTT10ms、每peer24–48Mbps。用户已允许新版Chromium显式模拟60Hz验收，结果注明客户端与刷新模式；保留Chrome89对照。沿用1080p主要矩阵；不能跨组拼凑FPS/延迟、以静态重复帧计入动态FPS、关闭marker或使用无限帧率替代正常呈现。
- 当前四1080精准render16/RTP0/0：15.95–15.97FPS，marker p95 143/92/136/90ms，GPU3D约78%。render20满载的旧组是播放unset，因此尚不能推定0/0下的高帧率结果。
- 无页面HWND的Aura宿主、高精度绝对deadline已经实现；这些是当前选择。允许进一步重构，保持Session隔离、真实Fence/lease、无稳态browser↔endpoint逐帧IPC。

## 当前分工

| 项目 | 负责人 | 范围与交付 |
|---|---|---|
| 实验与工具 | async_runtime_fresh | QSV功能与1/4租户对照、publication归因完成；harness已接客户端路径/模拟60Hz，待新binary实播 |
| QSV与独立审阅 | qsv_pipeline_fresh | async候选已构建实播并提交；publication独立审阅发现ClearStage重置遗漏，作者已修 |
| 发布节拍 | publication_cadence_fresh | 绝对deadline与dirty精准唤醒已实现；保持Fence/lease，等待正式构建实播 |
| 模拟刷新客户端与构建 | synthetic_vsync_receiver | 旧rel产物fake60预检约57.3FPS；唯一CPU窗口：out/dev服务端修复，再out/rel官方branding增量chrome |
| QSV能力调查 | gpu_copy_fresh | probe三组120帧成功；midstream drain探针尚未构建运行，等待独占窗口 |
| 架构与集成 | root | 决定复制消除和背压接口；更新记录、提交推送，依据实验安排后续工作 |

## 待推进

最新基线：1×1080 render60/0/0，源render55.27、encode/decode42.9、canvas29.92FPS、marker p9586ms，GPU69%。4×1080 render60为5.56–6.00FPS/p951249–1473ms，render30为6.20–6.86FPS/p95703–729ms，GPU均99.8%。不能用单租户延迟与其他组帧率拼接目标。

已提交：7b96d8f单次真实尾IDR；0ce2973默认关闭direct publication及实验；eda49ff异步VPP硬件probe；e9f04d9接收反馈与编码队列观测。direct四1080 render16 off/on为15.65–15.83→15.93–16.00FPS，p95130–197→90–149ms，GPU87.84→79.78%。干净on30仍7.16–7.30FPS/p95679–774ms、GPU99.78%；编译重叠旧组明确弃用，不能拿其丢包归因产品。

未解决问题：

- P1：Chrome89在断开的RDP会话无DXGI output，VSync Sleep17实际31ms，空页面约32Hz。用户已明确无法安装显示器，并允许新版/修改版Chromium模拟刷新验收；优先验证157官方 `--fake-vsync-rate=60`，复用out/rel，禁止全量构建。无需等待用户提供客户端，不切换用户会话。
- 已解决P1：publication额外损失已修复并实播，source/atlas/encode/decode均约55FPS；保持Fence/lease，fixture未变。报告publication-runtime.md。
- P1：精准fake60空页60.003Hz；新fixture源/编码/解码60FPS。同配置单租户两组canvas54.86/p95122与45.25/p9574，仍不稳定；before-work无吞吐收益，默认不变。client_cadence_fresh正在唯一GPU窗口做10秒native trace逐事件归因，不能用播放器presentedFrames替代canvas。
- P1：四compositor30依然3D99.85%，atlas约29→encode约14→canvas7.6–7.9，p95522–605ms；同步marker读回331–408ms与解码92–117ms并存。优先拆测量/接收开销和GPU复制成本，保留CRC，不因关闭marker得到漂亮结果而宣布达标。
- P2：精准fake等待需保留原版成对ActivateHighResolutionTimer请求，避免附带改变同GPU进程其它延迟任务粒度；synthetic_vsync_receiver只改源，等待trace释放后增量构建单变量对照。是否解释延迟尚未证实。
- P2：ApplyView源配置成功后若持久化或输出恢复失败，当前会保留停止状态并报告；Control对账不一定自动修复该状态，后续补恢复机制。
- 已解决P1：双页手动重连复用旧video时解码/时间轴前进但所有rVFC停止；每连接新video修复已通过两次split重连，旧callback/stream/DOM清理。报告receiver-video-lifecycle.md。
- P2：既有右边缘偏绿，direct off/on右16列逐字节相同；probe编码前NV12白边正确、coded padding为黑，但正式H264解码后根因尚未闭合。
- P2：反馈观测接通不等于帧率策略已实现；下一步仍需算法、changed-only限频控制及稳定性实验。

1. GPU吞吐：先确认高帧率0/0基线，再选择可验证的copy/同步消除；固定16FPS只用于诊断，不能当最终解法。
2. 背压与自适应：以真实资源和时序为依据，对源准入和最新帧队列建立有界控制。显示器/网络共同限制目标帧率，不能把超时或ACK当GPU完成，也不能因静态没有capture而死锁。
3. 码率与QSV：确认实际分配/实发码率后试高码率，兼顾文字/动态质量、编码吞吐和拥塞；不照搬未经验证的NVENC设置。
4. 精度与观测：保留已正确的精准pacer；针对实测唤醒/排队问题改进，不重复叠加全局timer设置。
5. 每批有意义变更完成后提交推送并保留证据，立即继续未达目标项。
