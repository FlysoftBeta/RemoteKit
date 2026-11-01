# 持续性能目标

持续实现和实验，直到每个租户同组实际canvas呈现≥50FPS、Pixel marker端到端p95≤100ms，或用户明确放宽/停止；阶段包和报告不终止工作。

## 当前验收与边界

保留Chrome89支持。用户允许修改版Chromium在无显示器服务器上模拟刷新验收，报告注明版本与刷新模式。单租户和重载都要验收；三租户有界实验无突破后，已按授权转为两租户。原四租户结果保留为历史证据。

UHD630、oneVPL异步H264、RTT10ms、每peer下行24–48Mbps、1080p/DPR1和CRC不变。同组报告真实成功canvas paint与marker，不能拼接结果、计入静态重复帧或关闭marker宣称达标。marker终点目前是canvas提交，读回耗时另报；后续补完成端点。

当前选定TU7、LowPower ON、VBR、depth1、外部颜色转换，目标36/max44Mbps；原编码preset与混跑矩阵已经完成，不继续扩展。用户最新产品化要求记录于[后续任务](productization-next.md)，按用户安排在本轮性能优化之后执行，包括统一封存无效实验开关。

## 当前实施

root负责架构、取舍、接口、审阅与commit/push；pre-GPU取消修复D2已编译并通过10项CPU检查；capture_to_atlas_runtime独占GPU继续20轮导航及剩余功能门，尚未开始正式A/B。CPU构建不得与计时GPU组重叠。

已完成：源准入、细粒度GPU profiling、root捕获合并pass、client直接video对照、TrackProcessor输入准入修正、不可变VideoFrame直接绘制多plane。Chrome89/video默认保留。

已实现：Endpoint直接租用共享BGRA槽，省shared→private复制。默认copy不变，shared为实验配置，先限制QSV/external/depth1。最后一个真实读者释放后，由AtlasPool既有owner按观察序列的安全前缀在同GPU context排consumed signal，禁止乱序释放或CPU伪造完成；旧generation沿用真实GPU完成和资源退役机制。功能/生命周期/CRC及两租户adaptive、固定52、固定56对照已完成。方案依据见[共享槽调查](endpoint-direct-lease-next.md)，实现、6项测试和真实生命周期验证已通过。同源52两租户46.86/48.26FPS、p95 83/94ms，GPU84.92%；固定56回退，停止提高源预算。详见[实跑](shared-atlas-input.md)。视频plane改opaque已验证，没有性能收益；Chrome89 shared输入/重连与65项Control检查通过。源码审计确认BlitRequest支持外部目的纹理。已选Viz owning CSI固定三槽池、GPU成功完成后ready、consumed完成后归还lease；不同pool代次使用新资源，保留可见像素/guardband与旧路径。见[实施决策](capture-to-atlas-plan.md)，源码、增量编译、pool与请求分类10/Endpoint7/patch工具9项CPU检查与七补丁重放/撤回通过；首轮硬件直写/CRC与零源端copy已确认，但导航压力确认未进入GPU的请求取消被当作整条输出故障，typed取消D2已完成，正在硬件复测；功能门未通过前不跑正式A/B。见[capture直写实跑](capture-to-atlas-runtime.md)。

## 已有关键证据

- 三租户最快预设全ON最佳12.46–12.68FPS、p95 852–921ms，混跑无额外收益，GPU约99.8%；源GPU进程占用不能全部算网页绘制。[报告](three-tenant-fast-mixed-runtime.md)
- 自适应源准入：三租户21.17–23.74FPS/p95 152–156ms；两租户35.11/31.33FPS、p95 91/99ms。[报告](source-budget-runtime.md)
- 精细GPU profile确认每帧child与root各一pass，没有额外高频绘制、DPI膨胀或MSAA。root捕获将两pass合并；两租户37.50/34.89FPS、p95 104/108ms。[GPU计时](viz-gpu-timing.md)、[root捕获](root-capture-runtime.md)
- client single-plane-direct确实跳过snapshot，但37.16/33.85FPS、p95 116/132ms，无提升；Chrome89首帧、输入、重连通过。[报告](client-direct-runtime.md)
- TrackProcessor加Canvas snapshot：39.07/41.47FPS、p95 103/107ms；真实输入、静止、重连、释放通过。[报告](processor-runtime.md)
- 不可变VideoFrame直接绘制：39.24/42.68FPS、p95 108/105ms，GPU均值81.62%，65项测试及真实双plane/DPR缩放/静态重挂载/Chrome89回归通过。固定源52后实际source52、encode约42.5、canvas40.20/40.51、p95 128/126ms，GPU97.78%，编码替换丢帧显著增加；继续放宽自适应阈值不能替代降低GPU成本。[报告](immutable-frame-runtime.md)

单租户精准fake60曾有51.53FPS/p95 123ms与50.77FPS/p95 76ms，尚未稳定同时达标。连续rVFC候选没有稳定收益，保持关闭。完整历史见正式串流实验文档及各组报告。

## 后续问题

1. 共享槽已验证latest、尾IDR、SDK所有权、三槽回转、generation切换、关闭和真实VPP input；破坏性GPU故障及Signal失败注入尚未覆盖。
2. 增加canvas提交和GPU/读回完成两端点；保留CRC并量化测量干扰。
3. ApplyView配置成功后持久化/恢复失败可能保持停止，需恢复机制。
4. alignment1右边缘偏绿根因未闭合；alignment16候选正常。
5. 多Profile、真实NVENC硬件及其他功能缺口继续保留。

新旧v2/v3 paint版本的正式分析工具已修正；未知版本仍明确拒绝，不用decode计数冒充paint。每批有意义的改动验证后由root提交推送，继续未达目标项。
