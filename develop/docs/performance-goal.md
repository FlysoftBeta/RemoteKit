# 持续性能目标

持续实现和实验，直到每个租户同组实际canvas呈现≥50FPS、Pixel marker端到端p95≤100ms，或用户明确放宽/停止；阶段包和阶段报告不终止工作。

## 当前验收

保留Chrome89支持。用户允许新版/修改版Chromium在无显示器服务器上模拟刷新验收，结果注明版本与刷新模式。单租户及重载都要验收；重载先3租户，若有界优化仍无明显成效可转2租户。原4租户结果保留为历史证据。

UHD630、oneVPL异步H264、RTT10ms、每peer下行24–48Mbps，沿用1080p/DPR1和CRC。不能跨组拼凑FPS/延迟、把静态重复帧计为动态帧，或关闭marker后宣称达标。当前marker终点是canvas提交，读回完成单独记录；后续补GPU/读回完成端点。

## 当前决策与任务

用户要求优先最快预设与高码率、VDEnc/Hybrid混跑。采用TU7/VBR/depth1，每peer48Mbps预算下目标36/max44Mbps，留传输余量。先比较全OFF、全ON、on/on/off、on/off/off，使用相同接收端、fixture、分辨率与marker。按实际GetVideoParam、各引擎占用和整链路结果判断，而不凭模式名称推断资源独立。具体边界与停止条件见[三租户矩阵](three-tenant-fast-mixed-plan.md)。

当前分工：root负责架构、取舍、文档和commit/push；adaptive_budget_impl完成源码和统一构建；three_tenant_runtime已完成四组模式，source_budget_runtime独占GPU验证源准入并按授权转2租户。无CPU构建与计时GPU实验重叠。

已实现、构建与CPU测试通过，待实际GPU验证：

- 每Session独立QSV LowPower选择，持久化数字Session id决定pattern位置；实际TU/LowPower可观测，高码率参数贯通harness。
- 默认关闭的自适应源帧率策略，独立低频worker，不依赖status轮询；保留Fence/lease和无稳态browser↔endpoint逐帧IPC。详见[策略](adaptive-frame-budget.md)。
- 默认关闭的TrackProcessor接收路径，原Chrome89/video路径保留；最多一个待呈现VideoFrame，每RAF最多准入一次。Control 60项测试、类型检查和生产构建/smoke通过；还需真实功能、CRC、生命周期与性能验证。

## 已有证据

三租户新矩阵完成：TU7实际生效，全ON最佳12.46–12.68FPS/p95 852–921ms，两个混跑没有额外收益。所有组3D约99.8%，source GPU约60%，源JS57–59但actual atlas17–20FPS。完整对照见[混跑报告](three-tenant-fast-mixed-runtime.md)。下一组只启用adaptive-fps，观察源负载/积压；仍远离目标则转2租户全ON基线，不再扩三租户编码预设矩阵。

绝对publication节拍修复了源55→发布42FPS损失；修正fixture自身漂移后，单租户源、发布、编码、解码约60FPS。精准模拟60Hz并保留进程高精度请求后的同配置两次为51.53FPS/p95 123ms与50.77FPS/p95 76ms，尚未稳定同时达标。

接收trace显示600个新video frame只触发约450次rVFC，后续canvas没有再丢帧。默认关闭的连续rVFC候选已验证静止/恢复/重连，正式on组51.17FPS/p95 104ms，没有稳定收益。0005精准刷新和0006回调候选均已记录patch/hash并增量构建；不继续无界修改回调启发式。

历史四1080 compositor/render30：atlas约29→encode约14→canvas7.6–7.9FPS，p95 522–605ms，3D99.85%。marker同步读回p95 331–408ms，解码92–117ms，服务端也有排队；不能将全部瓶颈归于测量。TU1下异步VPP和LowPower ON未提升最终呈现，保持外部转换加oneVPL异步编码默认；TU7/三租户需新对照。

已完成单次真实尾IDR、默认关闭source direct、每连接新video重连修复、反馈与编码队列统计、完整metrics分块上传与hash重组。当前提交c6bfc16包含receiver补丁、诊断工具及新目标；后续源码由root另行审阅提交。

## 后续问题

1. 先完成新混跑矩阵，再根据同组瓶颈选择下一项改进；仍无明显成效时转2租户。
2. 自适应策略需要独立off/on运行验证，不把降低源帧率本身当作达到50FPS。
3. TrackProcessor需要真实输入/几何/重连/静止/资源释放和性能验证；Canvas绘制可能仍有GPU复制。
4. Endpoint私有BGRA复制可考虑消除，但共享槽必须按已退休连续前缀释放，所有读者结束前不得signal consumed；还需设计latest帧与尾IDR所有权。
5. 测量记录canvas提交与GPU/读回完成两端点，保持CRC并量化干扰；有资源时再优化读回。
6. ApplyView源配置成功后持久化或恢复失败可能保持停止，Control对账未必修复；需要后续恢复机制。
7. 默认alignment1右边缘偏绿根因未闭合；alignment16候选白边实播正常，不能说旧问题完全解决。
8. 多Profile、真实NVENC硬件及原功能缺口继续保留，不因性能任务取消。
9. 通用matrix工具对新Client的paint版本输出paintFps=null；完整displayFps数据存在，混跑报告已直接读取真实计数。后续工具修复需同时支持旧v2与新v3，未知版本仍显式拒绝，不能用decode或metadata计数冒充paint。

每批有意义的改动验证后commit/push，继续未达目标项。
