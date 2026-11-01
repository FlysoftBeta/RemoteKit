# Offscreen root 实验：去掉原生Present仍会退化

默认关闭的 `RemoteKitOffscreenRoot` 已实现并通过真实GPU串流，但四租户首对明显退化，保留原窗口root默认。

## 改动与验证范围

`0003-offscreen-root.patch`在 `content/browser/compositor/viz_process_transport_factory.cc` 创建root参数时，把发给Viz的widget改为正确类型的 `gpu::kNullSurfaceHandle`。浏览器侧Compositor继续持有真实HWND、保持visible与原尺寸/生命周期；不隐藏Compositor、不ReleaseAcceleratedWidget、不缩小viewport。官方SkiaOutputDeviceOffscreen路径保留纹理绘制、swap ACK和BeginFrame。

Feature默认关闭；prepare的 `-OffscreenRoot`仅给source Session browser组合enable-features。native demo和接收端Chrome89保持原配置。没有改变CopyOutput、source lease、GPU完成或ready/consumed Fence语义。统一browser/browser_demo/SDK增量构建2steps通过，SDK导出成功。

## 真实profile

`offscreen-profile1080x4`使用DComp auto、host scale auto，四1920×1080/DPR1、d1/TU1/VBR、snapshot、cap/gate off、每peer24Mbps/双向5ms，marker0，官方trace与CopyOutput profile开启。四组持续收到Ganesh/OpenGL capture、QSV编码的1928×1088 H264，动态canvas更新；没有软件截图fallback。

四份官方trace中的DXGISwapChainImageBacking::Present和NativeViewGLSurfaceEGL:PostSubBuffer均为0，原生Present确实消失。root仍按原宿主DPI产生额外像素，本轮不混入scale修正。

S4与正式采样窗口交集内有162个完整request：

| 阶段 | p50 / p95 ms |
|---|---:|
| Created→GPU dispatch | 42.880 / 66.655 |
| dispatch→FlushBegin | 0.803 / 1.368 |
| Flush CPU | 1.001 / 56.464 |
| FlushReturn→Skia submitted | 1.061 / 46.998 |
| Submitted→Finished | 310.292 / 364.306 |
| Created→SendResult | 360.465 / 425.643 |
| GPU flush-batch elapsed | 0.906 / 1.135 |

S4最慢counter281总455.750ms，其中dispatch前75.946ms、submitted→finished377.060ms、batch0.995ms。Finished位于PerformWork任务内，其精确post→run59.862ms；另一个S3最慢counter280的Finished位于347.363ms的GpuChannel::ExecuteDeferredRequest scope（线程CPU3.030ms）末尾。本轮没有内部细分该decoder调用，不能把它误称纯GPU执行或断言某个GL调用阻塞。

GPU batch计时仍没有CPU时钟上的硬件开始/完成锚，submitted→finished包括GPU排队与观察，不能把全部余量当callback延迟。scope证据在case的 `finished-enclosing-scopes.json`。

## 同binary的profile关闭首对

`offscreen-baseline1080x4-a` → `offscreen1080x4-a`：5秒暖机+20秒采样，marker1Hz，其他条件完全相同，DComp auto/host auto。以下为四租户范围。

| 阶段 | 窗口baseline | offscreen |
|---|---:|---:|
| Source renderer render/s | 19.5–19.8 | 40.0–42.2 |
| Browser capture callbacks/s | 19.4–21.4 | 9.9–10.8 |
| Atlas copies/s | 19.5–19.7 | 9.9–10.4 |
| Encode/s | 11.2–12.3 | 8.7–9.1 |
| Decode/s | 11.3–12.3 | 8.7–9.2 |
| 实际canvas绘制提交/s | 7.64–8.50 | 6.30–6.70 |
| 同RTP marker p95 ms | 1085–1195 | 1633–1952 |
| 整机CPU p50 / p95 | 64.2% / 91.4% | 45.4% / 56.1% |
| 物理3D engine busy mean | 99.22% | 99.79% |
| source renderer CPU核数 mean | 1.275 | 1.710 |

去掉窗口呈现节流后，源绘制提交翻倍，捕获/编码/最终呈现却下降，GPU仍满负载。这支持“源继续增加GPU工作，使其他工作竞争/排队加重”的解释；本组没有ETW硬件队列逐帧测量，因此不声称已直接测出队列深度。CPU变低不能当作端到端改善。

依据首对退化停止条件，未跑剩余反序/单720性能组，不设置生产默认。后续将独立测试source host scale=1以减少root多画的像素，禁止与offscreen组合后归因。

## 功能与证据

`offscreen-static-input`：真实mouse click收到activation marker60001，两个IME commit对应81/82，静态最后frame5/stimulus82可见；RTC关闭200、peer=false。原始截图 `visual.png` 与metrics保留。该检查覆盖静态输入后最终变化，不覆盖GPU故障/资源重建；本轮未额外做reload专项。

全量原始证据保存在上述case的develop/tmp目录，性能分析为summary/resource-summary/server-trace-analysis JSON。client原始p95与server分析器分位取整方式不同，本文marker采用client值。日志末尾截断只在派生分析时显式跳过不完整末行，原文件未改，记录为 `offscreen-analysis-discarded-tails.json`。
