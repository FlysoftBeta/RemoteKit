# Aura 离屏源端 pacer 的 60/30/20 有界对照

## 结果

降低源渲染提交频率明显改善四租户最终输出。配置20档时，实际源帧率约16FPS，canvas升至15.2–15.9FPS，marker p95降至184–317ms；配置60档只有4.8–6.0FPS、p95为1657–2112ms。20档是本轮最佳候选，仍未达到 >50FPS/<100ms。

本轮同时发现现有 RepeatingTimer 的实际节拍出现约15.6ms量化。配置60/30/20实际只提交约34/22.5/16次每秒，所以下一步先解决 pacer 定时精度，不能把本轮20档解释成已实现准确20FPS。

生产默认仍为0，沿用输出fps；没有推广20档或实现自适应算法。

## 参数与实验边界

`--browser-render-fps=0..60` 由Endpoint传入browser的 `output.configure.render_fps`，只供新 OffscreenHost pacer。prepare参数为 `-BrowserRenderFps`。0沿用现有输出fps；capture/atlas发布上限、QSV名义fps和码率均保持原配置。旧window诊断路径不使用该pacer。

三组为 `develop/tmp/osr-pacer-4x1080-render{60,30,20}`：同新browser/service binary、最终Client bundle，4×1080、snapshot、d1/TU1/VBR、每peer24Mbps/RTT10ms、marker1Hz、5秒暖机+20秒采样。新宿主，host scale/DComp auto，capture cap/gate off，0002/0003/0004与官方/media/server profile关闭。没有并发GPU实验或构建。

本轮代码冻结后入库a1b88cf。Browser SHA256 E2011B48AD16384F7FD45590A511F3AB058A3B859942109DBAAE7A49109ECAFA；Service SHA256 90F6DDB844CA13A440C76995C0EC8BDAEC8165FC0E4A0BFADA93470A4CEEA8E7；Client index-Bsj1jkWQ.js SHA256 682c9bfa08d6c9e208641d83843b2ea5d4df03389aedbde99c40d14ad84c361c。各case还保存完整指纹和实际参数。

## 实际输出

| pacer配置 | source RAF/render FPS | GPU atlas copy FPS | encode FPS | decode FPS | canvas FPS | marker p95 ms | GPU3D均值 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 60 | 32.3–34.9 | 19.7–22.0 | 11.3–12.0 | 10.1–11.2 | 4.85–6.03 | 1657–2112 | 99.76% |
| 30 | 22.4–22.7 | 22.0–22.2 | 14.7–15.3 | 13.2–14.2 | 6.72–8.22 | 875–1014 | 99.71% |
| 20 | 16.0–16.1 | 16.0–16.1 | 16.0–16.1 | 16.0–16.1 | 15.24–15.89 | 184–317 | 93.98% |

范围覆盖四个Tenant，每档一次有界样本。30档仍GPU满载，源端少画的预算让编码增加，但客户端marker读回仍很慢；20档使提交/编码/呈现接近，最终FPS和延迟同时改善。

marker读回p95为60档361–478ms、30档428–554ms、20档45–51ms。它占用同一台机器的共享GPU，属于本次实际测量成本。所有Peer下行relay无丢包，receiver loss增量0；60/30档个别Peer PLI增量1，20档为0。原始视频/metadata/实际canvas分别保留，表中canvas取 `metrics.displayFps`，没有用decode FPS代替。

## Pacer与捕获反馈

snapshot增加 `configuredFps`、`sampleTimeTicksUs`。每host取最后不超过20秒的enabled快照，以TimeTicks做计数差分；每个区间约19.5秒、14个观测点，与客户端稳态窗口允许相差一轮Control轮询。

| 配置 | 实际submitted ticks/s | 实际ACK/s | merged/s | source RAF间隔p50 |
|---|---:|---:|---:|---:|
| 60 | 33.30–34.93 | 33.30–34.88 | 0–2.46 | 30.7ms |
| 30 | 22.39–22.71 | 22.40–22.71 | 0 | 46.2–46.3ms |
| 20 | 15.99–16.09 | 15.99–16.09 | 0 | 62.6ms |

三档没有controller cancellation。30/20档ACK基本跟随提交且没有merged，低于配置的节拍在pacer/源提交前已经出现，不能全归因于GPU ACK背压。`RepeatingTimer::ScheduleNewTask`调用默认延迟任务；每次回调以当前时刻重新排delay，迟到会降低长期频率。官方 `MetronomeTimer` 已使用固定phase和 `kPrecise` 的绝对deadline，交由主Agent决定下一最小机制；本轮没有修改定时器或系统timer。

profile关闭时没有单独capturer callback计数/全帧耗时。客户端每秒最新帧的capture→ready观测p95，60档约99–114ms、30档70–97ms、20档21–27ms。该指标跨capture时间戳到真实共享GPU完成观察，不能称纯copy执行时间，也不是所有请求的耗时分布。QSV所有观测的appliedFps均60。

同Intel物理3D引擎的角色均值如下；其他引擎不相加：

| 角色 | 60档 | 30档 | 20档 |
|---|---:|---:|---:|
| source GPU进程 | 51.7% | 40.8% | 27.7% |
| browser桥 | 14.1% | 15.6% | 9.9% |
| Endpoint | 18.0% | 22.7% | 21.3% |
| receiver GPU进程 | 9.6% | 13.4% | 24.6% |

source GPU进程CPU分别1.33/1.23/0.66核，source renderer分别1.41/1.20/0.50核。20档减少源端负载，同时接收侧获得更多GPU运行时间，与最终canvas增加一致。

详细差分与每Tenant观测在 `develop/tmp/osr-pacer-result/feedback.json`；标准cadence/resource分析及matrix原始字段保留。没有追加重复或扩展矩阵。

## 验证与清理

统一browser/demo/SDK增量编译、Endpoint Release package、SDK导出完成。无Session/GPU的参数smoke：0/30/60进入正常JSONL服务，61/-1/30x/1.5/空串在启动解析阶段被拒绝。

最终Client bundle与新binary另做一次短single720/render20真实输入：Chrome89 H264、hover不变焦、点击marker60001、IME后同RTP视频marker42、RTC close200通过（`osr-pacer-final-input`）。未重跑整套已过架构功能；定时器、静态/恢复/resize代码路径没有改变。

所有三档case与短输入case的自有进程已清理，无GPU/构建运行；源码保持冻结，默认0保持不变。
