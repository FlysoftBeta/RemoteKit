# Streaming 节拍实测

当前只做同机源节拍诊断，尚未把结果当作10ms RTT/24–48Mbps目标验收。所有对照组不重叠使用GPU，真实Chrome89客户端，可见状态/flags及raw数据均保留。

## 原始 fixture，720 viewport，单租户

路径：`develop/tmp/source-cadence-720`。Release endpoint、QSV AsyncDepth1/TU4/CBR/VBV1000ms，CLI startup18Mbps、max40Mbps；实际控制器目标另由stats记录。viewport1280×720/DPR1、编码atlas1288×728，5s暖机、20s有效样本，网络未整形。fixture仍每帧resize画布，后续优化对照必须注明。

| 环节 | 频率 | interval p50 / p95 / p99 |
|---|---:|---|
| 源renderer RAF（精确对齐client20s窗口） | 53.06 | 19.0 / 19.1 / 19.4ms |
| 源fixture render | 53.11 | 19.0 / 19.1 / 19.4ms |
| GPU capture callback（trace中间20s） | 53.06 | 18.79 / 22.28 / 23.67ms |
| browser atlas publish | 52.76 | 18.77 / 21.66 / 24.24ms |
| endpoint copy / encode完成（client窗口counter差值） | 52.76 / 52.76 | 下一组补逐帧分布 |
| Chrome89 video decoded | 52.51 | getStats counter差值 |
| 授权画布呈现后识别到的唯一marker | **31.72** | 每秒31–33帧 |

635个有效marker，CRC无效0；render-to-observed p50/p95/p99 = 95/112/117ms。这个结果没有达到目标口径；也不能把decoded52.51称为display52.51。需用client RAF/raw rVFC/presentedFrames/gate/画布readback计时区分接收端节拍。

browser声明2ms的poll实际p50/p95/p99=5.43/15.66/17.16ms。trace启动/停止时高分辨率timer flag均false，**这不代表全程未启用**；ContentMain本来就创建HighResolutionTimerManager，SequenceManager按每次精确唤醒需求临时启用。没有证据据此直接引入external BeginFrame。

raw source renderer RAF/render在`source-trace`，capture/publish/poll/source-read-done在`browser-trace`，完整marker/RTC/endpoint counters在`metrics/client-metrics.jsonl`；摘要为`summary.json`。可选`REMOTEKIT_MEDIA_TRACE=<目录>`只在内存保存有界raw序列，output.close后异步落文件，不添加逐帧browser↔endpoint IPC或逐帧文件写。

正式工具：`tools/streaming-source-probe.mjs`提供带nonce的loopback诊断fixture；`tools/streaming-benchmark.js`通过host Playwright使用已验证Chrome89，记录5s+20s、flags、visibility、marker与分层stats。尚未在这份结果中做参数优劣或多租户能力结论。

## 接收端32Hz归因

同一Release服务复制件、原fixture、720p/单租户、各5s暖机+20s，客户端始终visible，网络仍未整形：

| 对照 | 实际唯一marker或授权RTP fps | 源RAF / decoded fps | 主要结论 |
|---|---:|---:|---|
| after-work注册rVFC、全量marker | 31.63（marker） | 53.08 / 52.38 | 633/633 epoch匹配，无pending/missed |
| before-work注册rVFC、全量marker | 31.73（marker） | 52.95 / 52.48 | 636/636匹配，注册时机没有改善频率 |
| marker完全关闭 | 31.74（授权RTP） | 53.11 / 52.84 | callback p50/p95降至0.43/0.90ms，显示节拍仍32Hz |
| marker上限5Hz | 31.69（授权RTP） | 53.00 / 52.44 | 实际marker采样4.55Hz，显示计数另行全量记录 |

四组client RAF及raw rVFC均约31.4–31.7ms。DC frame metadata通常比视频早约20–38ms，授权匹配p95不足0.85ms；现有证据排除了epoch gate等待作为32Hz主因，保留现架构。全量marker同步getImageData p50/p95为8.79/14.87ms，CRC约0.015ms，但关闭读回并未提高显示频率。

低频marker组有91个CRC有效样本，render-to-observed p50/p95/p99为90/102/108ms。这里在displayFrame可用、开始marker读取前记录观测时间；旧全量组在读回与CRC后记录，不能把两者延迟差直接归因于参数收益。低频输入到观测也包含等待下一次marker采样的时间，尚不用于输入延迟达标结论。授权RTP计数与raw rVFC保留了完整显示节拍，4.55Hz不是显示FPS。

当前工具进程位于Windows会话2。WTS报告Disconnected，SM_REMOTESESSION=1；DWM查询成功，声明刷新/合成约60Hz、周期16.6666ms，但刷新/呈现计数停留在很小数值。这是已断开的远程会话中的headed测试，尚非物理本地显示验收。只读工具为`tools/probe-windows-display.ps1`，原始结果在`develop/tmp/windows-display-probe.json`。SM_REMOTESESSION含义见[Windows官方文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getsystemmetrics)。

四组raw在`develop/tmp/source-cadence-720-{client,before,marker-off,marker-5hz}`。`tools/analyze-streaming-cadence.py`将metrics中的分块presentation raw还原为独立JSON并生成summary；`tools/prepare-streaming-case.ps1`使用全新目录、独立数据、hidden Node服务和既有Chrome89 host driver准备每组，保留二进制/fixture哈希。后续组同时保存每秒系统CPU及诊断服务自身CPU开销。

## 下一步

1. 官方Chrome89默认与`--disable-gpu-vsync`各20s受控对照，不加disable-frame-rate-limit，比较RAF/rVFC/decoded、CPU及DWM信息；不会改变系统/RDP设置。即便改善，也标明虚拟/远程会话对照。
2. 普通poll与官方DeadlineTimer+kPrecise可选模式各20s有界A/B，比较poll/capture/FPS/p95和CPU；保持静态damage驱动，根据收益决定默认值。
3. 源与client节拍足够后才做网络整形和编码参数矩阵，记录每客户端预算与共享总预算差别。
