# CopyOutput 请求级 profile：提交后等待占主导

四租户的主要耗时在 **Skia submitted callback → finished callback**。新启动组 Session 4 的中位数为203.317ms，同一请求对应的 GPU flush 批次 elapsed 中位数为0.813ms。请求从创建到 SendResult 为215.977ms。它证明长时间不是这批命令的约200ms纯执行；这段间隔仍包含 **GPU 队列等待和完成观察滞后**，当前数据不能把二者完全拆开。

另组 ETW 已观测 source GPU 的125–225ms提交等待，见[ETW短诊断](etw-gpuqueue-profile.md)。ETW与本组没有逐请求连接，不能把两组时间相减，也不能把 submitted→finished 的全部余量算作 callback 延迟。

## 恢复与实验范围

重启时间为2026-11-01 10:57:27.5 +08:00，新组保存了 `boot.json`。旧 `copy-profile-1080x4` 已有4条20秒完整 benchmark metrics及4份可解析的官方trace，测量窗口在关机前已完成；末尾部分服务日志被截断，旧组未完成分析/清理。旧证据全部保留，未用旧PID清理进程。新旧boot的TimeTicks/QPC分别分析，未合并时间轴。

本次独立运行 `copy-profile-reboot-1080x4`，再运行同boot的 `copy-profile-reboot-720x1` 作为参照，没有扫参数。配置：canvas动画/DPR1，Chrome89.0.4389.90 headed、默认client flags，snapshot，d1/TU1/VBR，capture cap和ready gate关闭，每peer独立24Mbps下行、双向各5ms基础延迟；marker0，server/browser trace及资源profile开启。所有客户端测量期间为visible。

四租户canvas绘制提交为7.10–8.34fps；marker关闭，因此没有Pixel marker端到端延迟。该结果是加profile后的诊断负载，不作为性能改善或目标达成。

冻结Endpoint SHA256为 `1ff67332346267a3e4dbb1f4ccec0050347cdeaac9945d9a83cb188d4f4202b6`，运行时 `components_viz_service.dll` 为 `b52bd6c7bb689de3910f5514654a8b181a030a838c36dcc0f21084c72235b683`。各组 `fingerprints.json` 保存browser/SDK/工具/fixture与manifest指纹。实验之后清除了补丁中的纯格式改动并重建，未改变probe或运行策略；证据仍对应各组原始指纹。

## 覆盖与裁切

官方startup trace在每个browser启动后记录约16秒。租户依次建立，不能把所有startup请求当成四租户稳态。分析器使用该Session的server `clock_wall`/`clock_sdk`夹测映射正式客户端窗口；只有Created与SendResult都处于该窗口的完整请求计入下表的稳态样本。记录窗口与trace交集不是整段20秒。

| 新boot组 | 全trace完整请求 | 正式窗口与trace交集 | 窗口内完整请求 |
|---|---:|---:|---:|
| 4×1080 Session1 | 367 | 0秒 | 0 |
| 4×1080 Session2 | 344 | 1.091秒 | 15 |
| 4×1080 Session3 | 287 | 4.128秒 | 69 |
| 4×1080 Session4 | 258 | 8.152秒 | 142 |
| 1×720 Session1 | 418 | 7.743秒 | 241 |

旧boot四组完整请求分别382/355/289/274；正式窗口内0/19/80/158。旧S4窗口request p50为206.574ms，batch elapsed p50为0.860ms。它与新组分开保留，不把重启差异当作补丁收益。此前“仅后两Session覆盖”的描述适用于更早official case，本次S2也有约1秒覆盖。

## 同request各阶段

数字为窗口内p50 / p95，单位ms。各阶段分位数不可相加来还原总量。

| 阶段 | 新4×1080 S3（69） | 新4×1080 S4（142） | 同boot 1×720（241） |
|---|---:|---:|---:|
| Created → GPU dispatch | 8.167 / 12.697 | 8.934 / 13.294 | 0.628 / 0.795 |
| GPU dispatch → FlushBegin | 0.795 / 1.417 | 0.674 / 1.553 | 0.203 / 0.337 |
| FlushBegin → FlushReturn（CPU） | 1.069 / 2.149 | 0.819 / 1.743 | 0.191 / 0.322 |
| FlushReturn → Skia Submitted | 1.345 / 3.026 | 1.192 / 2.851 | 0.291 / 0.487 |
| Submitted → Finished | 204.711 / 281.408 | 203.317 / 272.052 | 8.270 / 13.313 |
| Finished → MailboxReady | 0.010 / 0.025 | 0.011 / 0.033 | 0.006 / 0.011 |
| MailboxReady → SendResult | 0.016 / 0.037 | 0.015 / 0.038 | 0.008 / 0.015 |
| Created → SendResult | 216.250 / 289.028 | 215.977 / 283.458 | 9.677 / 14.723 |
| GPU flush-batch elapsed | 0.827 / 0.978 | 0.813 / 1.050 | 0.657 / 0.690 |

全部完整样本均为Ganesh/OpenGL（backend_api=0），elapsed支持且非零，semaphore_count=0；CopyOutput局部显式submit分支均记录Skipped，但之后仍收到成功的Skia submitted callback。没有局部显式submit不等于没有提交，实测flush return→submitted约1ms，不能据此强制添加submit。Skia submitted是提交回调，不是OS队列提交或硬件开始时间。

elapsed是Skia该flush批次的GPU计时，可以包括此前未flush的工作和计时区间内等待，不叫纯CopyOutput时间。它只有持续时间，没有映射到CPU时钟的硬件开始/结束锚，不能从elapsed推定GPU究竟何时完成。

## 可复核慢帧及真正的观察路径

`copy-profile-reboot-1080x4/official-trace/session-4-2478251587.json`，GPU PID2624/TID2816，capture counter229，request指针2210759443168，Created=`263595845us`。相对Created：

| 事件 | 相对ms |
|---|---:|
| GPU dispatch | 8.333 |
| FlushBegin | 8.822 |
| FlushReturn | 9.358 |
| SubmitSkipped | 9.378 |
| Skia Submitted | 10.987 |
| Finished | 339.736 |
| MailboxReady | 339.744 |
| SendResult | 339.759 |

本次batch elapsed=0.838246ms；submitted→finished=328.749ms。Finished确实位于 `CommandBufferStub::PerformWork` 的CPU scope内（263935275–263935646us），外层是 `ScheduleDelayedWork` 的 `PRECISE` RunTask，请求delay1990us。精确toplevel.flow **34677** 从263795815us post到263935269us run，post→run **139.454ms**。这是本次完成观察任务的真实调度延迟；没有GPU-ready时间，不能把139.454ms全部视为本帧本可提前完成的时间。

S3 counter255同样在PerformWork内finished，所处task flow40064的post→run=155.462ms；S2 counter341为89.672ms。原始scope/flow保存为 `finished-enclosing-scopes.json`。

新S3仅1/69、新S4仅1/142、新720仅4/241个Finished落在新增 `SkiaOutputSurfaceImplOnGpu::CheckAsyncWorkCompletion` scope内。其余完成可以由其他活动观察；以上慢帧直接证明PerformWork是其中一条实际路径。源码PerformWork先调用MakeCurrent，但本次没有MakeCurrent内部scope，不能把callback定位到其具体一行。**撤回surface的2ms completion poll是直接优化靶点的假设**，不改它的延时或策略。

最小后续测点应沿这个真实路径：为PerformWork/decoder MakeCurrent/其触发的Skia完成检查分别加begin/end和context身份；保留相同request的Submitted/Finished，并连接准确的post/run flow。若要分离GPU队列与观察，需取得同context/batch的硬件完成或非阻塞fence/query“首次观察ready”边界，记录前一次not-ready与下一次ready，避免CPU轮询本身制造等待。先确认实际检查入口，再选择有界对照；本轮没有继续加补丁或调整参数。

## callback所有权与关闭行为审阅

- Feature默认关闭；关闭时不装callback wrapper、不请求GPU stats、不改submit条件、poll或lease。请求身份getter只读取原request指针。
- Ganesh正常flush在 `GrGpu::executeFlushInfo` 优先消费 `fFinishedWithStatsProc`，失败/abandoned路径在GrDirectContext/GrDrawingManager消费plain `fFinishedProc`。两种入口都交给同一个WithStats实现，以unique_ptr消费finished context一次；不把它们当作会顺序执行的两个回调。
- submitted单独分配context，不依赖finished context。源码失败路径存在finished先、submitted后，也有submitted先、finished后；两者都独立释放并原样转发。
- 在 `AddVulkanCleanupTaskForSkiaFlush` 组合原callback之后再封装，因此转发保留cleanup；转发前清空raw_ptr，避免原callback销毁context后留下悬空成员。
- Graphite保留finished与stats转发；它没有本接口可用的per-recording submitted API，明确记录缺失，不伪造Submitted。本机只运行Ganesh/OpenGL，失败/Vulkan/Graphite分支为源码审阅与统一编译证据。
- 同一PID内以request地址+Created生命周期连接，SendResult终结生命周期；未出现新的capturer Created时，其他CopyOutput producer复用地址的事件不接入旧请求。三个新/旧分析组均未发现单生命周期重复phase。

## 验证与复现

`tools/analyze-copy-output-profile.py --case CASE --output CASE/copy-profile.json` 输出完整请求、每阶段时间、全trace与正式窗口两套分布、实际交集、slowest request和缺测计数。时钟锚在日志开头即可读取，不因末尾关机截断的frame记录而丢弃已完成的窗口；不修补原始日志。

`prepare-streaming-case.ps1 -CopyOutputProfile`要求同时启用OfficialTrace，并把Feature与二进制指纹写入case。运行配置示例：

```powershell
./tools/prepare-streaming-case.ps1 -Name NEW_CASE -Width 1920 -Height 1080 -Tenants 4 -MarkerHz 0 -AsyncDepth 1 -TargetUsage 1 -RateControl vbr -DownlinkMbps 24 -ServerTrace -OfficialTrace -CopyOutputProfile -ResourceProfile -PresentationMode snapshot
```

通过managed Playwright执行case的run.js。新组使用新建目录；bench完成后关闭RTC/browser并通过stop工具清理本次Control/source/resource进程，未控制鼠标键盘。

补丁去除features与copy-results的无关格式改动后，同步实际Chromium源码、manifest SHA256；两项patch正式逆序撤回/顺序重应用通过。统一增量构建browser/browser_demo/SDK通过（11 steps），SDK重新导出成功，4项patchset测试通过，分析器py_compile通过。原始trace、metrics、资源数据及分析结果保存在上述 `develop/tmp` 目录；未打包或提交实验数据。
