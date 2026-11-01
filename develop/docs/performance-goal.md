# 持续性能目标

持续实现和实验，直到每个租户同组实际canvas呈现≥50FPS、Pixel marker端到端p95≤100ms，或用户明确放宽/停止；阶段包和报告不终止工作。

## 当前验收与边界

保留Chrome89支持。用户允许修改版Chromium在无显示器服务器上模拟刷新验收，报告注明版本与刷新模式。单租户和重载都要验收；三租户有界实验无突破后，已按授权转为两租户。原四租户结果保留为历史证据。

UHD630、oneVPL异步H264、RTT10ms、每peer下行24–48Mbps、1080p/DPR1和CRC不变。同组报告真实成功canvas paint与marker，不能拼接结果、计入静态重复帧或关闭marker宣称达标。marker终点目前是canvas提交，读回耗时另报；后续补完成端点。

当前选定TU7、LowPower ON、VBR、depth1、外部颜色转换，目标36/max44Mbps；原编码preset与混跑矩阵已经完成，不继续扩展。用户最新产品化要求记录于[后续任务](productization-next.md)，按用户安排在本轮性能优化之后执行，包括统一封存无效实验开关。

## 当前实施

root负责架构、取舍、接口、审阅与commit/push；shared_atlas_input负责下一有界实现与实验。CPU构建不得与计时GPU组重叠。

已完成：源准入、细粒度GPU profiling、root捕获合并pass、client直接video对照、TrackProcessor输入准入修正、不可变VideoFrame直接绘制多plane。Chrome89/video默认保留。

下一候选：Endpoint直接租用共享BGRA槽，省shared→private复制。默认copy不变，shared为实验配置，先限制QSV/external/depth1。最后一个真实读者释放后，由AtlasPool既有owner按观察序列的安全前缀在同GPU context排consumed signal，禁止乱序释放或CPU伪造完成；旧generation沿用真实GPU完成和资源退役机制。先功能/生命周期/CRC，再同条件两租户adaptive对照；有明确收益才增加固定52组。方案依据见[共享槽调查](endpoint-direct-lease-next.md)，实现与实跑尚未完成。

## 已有关键证据

- 三租户最快预设全ON最佳12.46–12.68FPS、p95 852–921ms，混跑无额外收益，GPU约99.8%；源GPU进程占用不能全部算网页绘制。[报告](three-tenant-fast-mixed-runtime.md)
- 自适应源准入：三租户21.17–23.74FPS/p95 152–156ms；两租户35.11/31.33FPS、p95 91/99ms。[报告](source-budget-runtime.md)
- 精细GPU profile确认每帧child与root各一pass，没有额外高频绘制、DPI膨胀或MSAA。root捕获将两pass合并；两租户37.50/34.89FPS、p95 104/108ms。[GPU计时](viz-gpu-timing.md)、[root捕获](root-capture-runtime.md)
- client single-plane-direct确实跳过snapshot，但37.16/33.85FPS、p95 116/132ms，无提升；Chrome89首帧、输入、重连通过。[报告](client-direct-runtime.md)
- TrackProcessor加Canvas snapshot：39.07/41.47FPS、p95 103/107ms；真实输入、静止、重连、释放通过。[报告](processor-runtime.md)
- 不可变VideoFrame直接绘制：39.24/42.68FPS、p95 108/105ms，GPU均值81.62%，65项测试及真实双plane/DPR缩放/静态重挂载/Chrome89回归通过。固定源52后实际source52、encode约42.5、canvas40.20/40.51、p95 128/126ms，GPU97.78%，编码替换丢帧显著增加；继续放宽自适应阈值不能替代降低GPU成本。[报告](immutable-frame-runtime.md)

单租户精准fake60曾有51.53FPS/p95 123ms与50.77FPS/p95 76ms，尚未稳定同时达标。连续rVFC候选没有稳定收益，保持关闭。完整历史见正式串流实验文档及各组报告。

## 后续问题

1. 下一共享槽候选必须保留latest、尾IDR和SDK所有权，验证三槽回转、generation隔离、延迟release、关闭屏障及真实VPP input兼容。
2. 增加canvas提交和GPU/读回完成两端点；保留CRC并量化测量干扰。
3. ApplyView配置成功后持久化/恢复失败可能保持停止，需恢复机制。
4. alignment1右边缘偏绿根因未闭合；alignment16候选正常。
5. 多Profile、真实NVENC硬件及其他功能缺口继续保留。

新旧v2/v3 paint版本的正式分析工具已修正；未知版本仍明确拒绝，不用decode计数冒充paint。每批有意义的改动验证后由root提交推送，继续未达目标项。
