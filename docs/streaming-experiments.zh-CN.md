# 串流实验与测量设施

## 已完成的目标组

本节数据属于重构前capture路径，不代表Comp/Rend OSR路径的性能。本次新增路径只执行必要功能验收；结果见[当前状态](current-state.zh-CN.md)。

2026-11-01，UHD630双租户同组45秒：真实canvas **51.6926/51.7349FPS**，Pixel marker p95 **76/79ms**。成功paint2327/2329，每路45个有效CRC，无RTP+epoch重复或缺失paint快照。

条件：源1920×1080/DPR1，atlas/编码1936×1088，固定源52、产品/源自适应关闭；QSV TU7、LPON、VBR、depth1、external VPP/alignment16、36/max44Mbps；每peer48Mbps/RTT10ms。Source采用直写共享目标，Endpoint shared；接收Chromium157.0.8103.15 headless、Intel硬件H264/GPU canvas、fake60、MSTP immutable/fifo2，Worker CRC 1Hz，intrusive profile关闭。完整组件hash和原始产物见[组报告](../develop/docs/headless-receiver-runtime.md)。

同binary headed配对为48.9560/37.3554FPS、p95 90/108ms，Intel3D 93.55%→64.33%；RDP显示链解释了额外开销。用户随后取消120秒稳定组和单租户重复组；取消组无最终报告，不能列为通过。

## 指标定义

- 分别记录源render、capture/delivery、encode、decode、独立RTP的实际canvas paint；同帧重绘和静态重复不能充当动态FPS。
- Pixel marker来自实际接收像素，包含帧号、时间、输入刺激和CRC。当前终点是canvas drawImage提交，不是物理屏幕点亮；GPU/CRC读回完成与成本另记。
- Worker方式先从真实已绘制canvas取得不可变bitmap，绑定原paint RTP/epoch/时刻，再异步读CRC；任务有界、超时可见、关闭前drain。不得把worker完成时间倒填为paint时间。
- 历史capture_time是Chromium capture end；capture begin→end含等待、GPU与完成观察，capture-end→ready不含前段。新OSR路径未取得可靠完成时刻时保留0并省略相应延迟样本；提交时间不能冒充完成时间。阶段p95不能直接相加。
- 跨机器时钟必须校准并报告不确定度。生产估算与Pixel marker实验分开，见[媒体反馈](media-feedback.md)。

## 可复用工具

| 工具 | 用途 |
|---|---|
| prepare-streaming-case.ps1 | 隔离目录、固定配置、指纹、专用diagnostics实例与启动参数 |
| streaming-benchmark.js | /automation配置下放、实际paint/marker采集、完整或分块metrics |
| streaming_metrics.py / summarize-streaming-matrix.py | 校验、重组、分组汇总，拒绝未知paint版本 |
| watch-streaming-resources.ps1 / windows-gpu-counters.cs | 进程与GPU引擎占用，区分3D/Video等 |
| streaming-etw.ps1 | GPU队列、调度、提交及等待的ETW记录 |
| analyze-viz-gpu-profile.py | 历史capture路径的GPU pass/flush执行分量；旧插桩已退出生产路径 |
| analyze-copy-output-profile.py / analyze-official-capture-trace.py | 读取历史capture/CopyOutput证据，不代表新OSR路径具备这些事件 |
| analyze-streaming-server-trace.py / analyze-streaming-cadence.py | generation/frame/lease、编码与wire RTP、队列与呈现节拍 |
| compare-streaming-quality.ps1 | 同帧静态画质比较 |
| stop-streaming-case.ps1 | 清理指定case自己创建的进程 |

工具位于tools，不依赖develop中的代码。case的config.json/fingerprints.json、metrics和原始trace放develop/tmp。必须使用独立browser context与诊断用户；正常产品入口不承载实验面板。显式关闭的Source feature通过disable透传，不能仅省略enable就当作关闭。

## 实验约束

固定条件页用于独立测量，产品网络策略已统一交给WebRTC。QSV/TU、协商码率上限、DPR/几何、接收路径/FIFO和仍有效的profile可显式配置；删除的capture及自制适配旋钮不得继续注入。参数定义以工具为准，不把工具默认当产品默认。软件渲染、特殊浏览器flags、关闭marker或额外Profile负载都要记入条件。

计时GPU组独占资源、不同时CPU构建；只比较可追溯的同条件配对。占用率是引擎工作量，不等于编码耗时；必须结合实际GPU执行/队列和进程归因。资源监控与侵入式trace也分开标记。

历史无收益选项和旧矩阵集中到[归档](experiments-archive.zh-CN.md)，不继续作为产品建议。新的功能检查不冒充性能复验，已被用户取消的重复组不再执行。
