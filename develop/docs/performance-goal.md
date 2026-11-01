# 持续性能目标

用户最新指令：继续接手五项建议并自行实验改进，直到实际呈现≥50FPS、Pixel marker端到端p95≤100ms，或用户明确放宽/停止。阶段交付不终止工作。此前32a8313包是可复现checkpoint，不是目标完成。

## 验收与基线

- Chrome89 headed、H264、UHD630 oneVPL异步编码；1/4租户、RTT10ms、每peer24–48Mbps。沿用1080p主要矩阵，保持画质和分辨率记录；不能跨组拼凑FPS/延迟、以静态重复帧计入动态FPS、关闭marker或特殊flag冒充默认达标。
- 当前四1080精准render16/RTP0/0：15.95–15.97FPS，marker p95 143/92/136/90ms，GPU3D约78%。render20满载的旧组是播放unset，因此尚不能推定0/0下的高帧率结果。
- 无页面HWND的Aura宿主、高精度绝对deadline已经实现；这些是当前选择。允许进一步重构，保持Session隔离、真实Fence/lease、无稳态browser↔endpoint逐帧IPC。

## 当前分工

| 项目 | 负责人 | 范围与交付 |
|---|---|---|
| 实验与独立审阅 | throughput_fresh | direct A/B、观测接线实播完成；发现Chrome89重连旧video解码但rVFC停止，交客户端修复 |
| QSV异步管线 | qsv_pipeline_fresh | 新上下文；按qsv-async-integration.md实现同session VPP→Encode候选，固定surface地址和真实lease；仅编辑待统一构建 |
| 对齐与配置 | tail_idr_fresh | 物理atlas allocation_alignment16、CLI及正式CPU测试接线；不改变网页viewport/DPR；仅编辑 |
| 客户端 | client_cadence_fresh | 反馈及每连接新video修复完成；43测试、正式build和两次split重连实播通过；资源已释放 |
| QSV能力调查 | gpu_copy_fresh | probe noscale/full/scale各120帧成功，颜色误差≤1、cookie/Locked正确；资源已释放 |
| 架构与集成 | root | 决定复制消除和背压接口；更新记录、提交推送，依据实验安排后续工作 |

## 待推进

最新基线：1×1080 render60/0/0，源render55.27、encode/decode42.9、canvas29.92FPS、marker p9586ms，GPU69%。4×1080 render60为5.56–6.00FPS/p951249–1473ms，render30为6.20–6.86FPS/p95703–729ms，GPU均99.8%。不能用单租户延迟与其他组帧率拼接目标。

已提交：7b96d8f单次真实尾IDR；0ce2973默认关闭direct publication及实验；eda49ff异步VPP硬件probe；e9f04d9接收反馈与编码队列观测。direct四1080 render16 off/on为15.65–15.83→15.93–16.00FPS，p95130–197→90–149ms，GPU87.84→79.78%。干净on30仍7.16–7.30FPS/p95679–774ms、GPU99.78%；编译重叠旧组明确弃用，不能拿其丢包归因产品。

未解决问题：

- P1：Chrome89在断开的RDP会话无DXGI output，VSync Sleep17实际31ms，空页面约32Hz；默认客户端最终50FPS验收需正常显示输出环境。已询问用户现成可用客户端，不因此停止服务端优化，也不自行切用户会话。
- 已解决P1：双页手动重连复用旧video时解码/时间轴前进但所有rVFC停止；每连接新video修复已通过两次split重连，旧callback/stream/DOM清理。报告receiver-video-lifecycle.md。
- P2：既有右边缘偏绿，direct off/on右16列逐字节相同；probe编码前NV12白边正确、coded padding为黑，但正式H264解码后根因尚未闭合。
- P2：反馈观测接通不等于帧率策略已实现；下一步仍需算法、changed-only限频控制及稳定性实验。

1. GPU吞吐：先确认高帧率0/0基线，再选择可验证的copy/同步消除；固定16FPS只用于诊断，不能当最终解法。
2. 背压与自适应：以真实资源和时序为依据，对源准入和最新帧队列建立有界控制。显示器/网络共同限制目标帧率，不能把超时或ACK当GPU完成，也不能因静态没有capture而死锁。
3. 码率与QSV：确认实际分配/实发码率后试高码率，兼顾文字/动态质量、编码吞吐和拥塞；不照搬未经验证的NVENC设置。
4. 精度与观测：保留已正确的精准pacer；针对实测唤醒/排队问题改进，不重复叠加全局timer设置。
5. 每批有意义变更完成后提交推送并保留证据，立即继续未达目标项。
