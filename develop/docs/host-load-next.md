# Host CPU计量与环境归因

2026-11-01。现有全机CPU公式和单位正确。continuous-rVFC off/on的大部分CPU差异发生在已记录owned角色之外，但旧数据没有保存这些进程的CPU，无法事后确定是谁，也不能据此猜测杀毒软件或断言全是环境问题。当前空闲短窗没有复现该负载。

## 计量核查

来源为`tools/streaming-source-probe.mjs`的`totals()`与每秒loadTimer：对16个逻辑CPU累计时间求和，全机忙碌比例为`100 × (1 - Δidle/Δtotal)`，范围是全机0–100%，不是单核百分比。`probeCpuCores`使用探针自身user+system CPU微秒除以墙钟微秒，单位为CPU核数；两列不能直接相加。

`tools/analyze-streaming-cadence.py`按样本区间中点`wallTimeMs - intervalMs/2`落在客户端正式测量窗口内来筛选host-load，不把暖机和上传阶段拼入正式30秒。off/on分别29/30个CPU样本，实际间隔约997–1024ms；不是把超时的长窗口当1秒。p50/p95为样本分布，非总CPU时间比例的置信区间。

当前另取3个2秒Node同算法短窗，`ΔtotalCPU毫秒/Δ墙钟毫秒`为16.061/15.900/16.111，与16逻辑CPU吻合；忙碌比例1.655/0.931/1.404%，对应0.266/0.148/0.226核。独立Windows GetSystemTimes差分也测得低负载，未发现漏除16、错误乘100或单位混淆。

## 历史off/on能说明什么

| 同窗指标 | off | on |
|---|---:|---:|
| host CPU p50/p95 % |46.05/76.40|22.60/36.45|
| 加权host CPU均值 % |47.48|23.78|
| host平均CPU核数 |7.60|3.80|
| 已记录owned角色平均核数合计 |3.49|2.49|
| 差额估计核数 |4.11|1.31|
| 物理3D总占用 % |85.60|71.39|
| 未归类3D占用 % |15.26|7.56|

owned合计来自`resource-summary.json`的角色均值，host按CPU样本区间加权，采样相位与角色样本数略有差别，差额是归因量级估计，不是逐微秒守恒账。总CPU下降约3.8核，其中约2.8核、即约四分之三不在已记录角色中。产品自身已记录CPU也下降约1核，所以不能只选环境或产品其中一个解释。

旧资源采集器只记录source/Endpoint/receiver/Control/探针等已知PID；对其他PID没有保存CPU。全机GPU计数有物理总量，但逐PID也仅保存owned。因此历史4.11核/15.26%3D具体是谁无法从已有日志恢复。未归类可能包括其他应用、系统工作，以及现有角色发现未涵盖的进程；当前数据不把它自动归为产品外部。没有停止任何用户程序或修改系统策略。

## 当前空闲3个短窗

新增独立正式工具`tools/probe-ambient-load.ps1`，默认CPU差分；显式`-IncludeGpu`才加载GPU PDH采样。只记录进程名/PID/CPU核数，以及系统总量和可选GPU引擎占用，不读取命令行或环境变量。未接入正式benchmark默认路径。

运行：`powershell -NoProfile -ExecutionPolicy Bypass -File tools/probe-ambient-load.ps1 -Windows 3 -IntervalMs 2000 -Top 10 -IncludeGpu -Output develop/tmp/ambient-load-current.json`。

| 2秒短窗 | 全机CPU % | 全机CPU核数 | 可读进程CPU合计核数 | CPU最多的可读进程 |
|---|---:|---:|---:|---|
|0|3.218|0.510|0.093|Taskmgr PID15960，0.039核|
|1|0.934|0.148|0.101|Taskmgr PID15960，0.039核|
|2|1.623|0.257|0.093|Taskmgr PID15960，0.023核|

其他可读进程均很低，主要是ChatGPT、Codex及本采样器，没有出现数核的大头。可读进程CPU与系统总量之间仍有0.047–0.417核差额：受限进程、内核/中断工作与读取边界误差都未单独细分，不能把差额塞给某个已知应用。

三窗中可见GPU最多的是ChatGPT PID14356，3D约0.46–0.48%；dwm PID8756、csrss PID8584、WUDFHost PID23096均约0.1%或更低。初版输出因这些进程CPU时间不可读而GPU名称记为unavailable，已通过只读进程名核对并修复名称映射。独立1秒验证`develop/tmp/ambient-load-validation.json`确认映射正确，ChatGPT0.416%、csrss0.122%、dwm0.059%、WUDFHost0.032%，没有GPU大头。

CPU差分使用GetProcessTimes，系统CPU使用GetSystemTimes；GPU复用正式PDH实现。3窗采集本身每窗约101/22/26ms，采样器CPU约0.015/低于计时粒度/0.008核。C#冷启动编译发生在采样窗口之前，开销仍存在，未来应在暖机前启动，不能将启动开销当零。进程退出/CPU时间权限不足时不会伪造其CPU值，系统残差保留。

## 后续可复用记录与判定建议

先在每对实验前后各保留3个2秒ambient短窗，记录墙钟时间、全机CPU、top进程和可选GPU角色；与实验case一起归档。若空闲前后正常、正式窗口内又出现未归类CPU/GPU的大幅变化，再显式并行运行低频2秒归因工具覆盖暖机与正式窗口，保留所有窗口的top PID和采样器自身占用。只看空闲前后不足以排除正式运行期间的干扰。

配对结果先检查源/编码供给、owned CPU与GPU，以及未归类负载是否可比；若负载背景明显不同，保留结果但不作单变量因果结论，在可比窗口复测。阈值应根据同机空闲基线波动与采样成本选定，作为实验判定策略，不写成用户要求，也不把某个任意低CPU百分比当验收条件。不自动杀程序、关闭防护或修改系统电源策略。

本轮没有重跑GPU性能矩阵、没有开启产品或构建、没有采集命令行/环境；仅新增独立工具与本报告。历史均值推导脚本位于`develop/tmp/host-load-audit.py`，原始历史host-load/resource文件保持不变。
