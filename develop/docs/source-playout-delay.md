# 精准render16下的RTP播放延迟0/0请求

## 结果

该候选有明确且重复的收益。完成0/0→未设置→0/0交替复核：最后两组四租户canvas从15.07–15.64提升到15.95–15.97FPS，marker p95从169–233ms降到90–143ms。source仍限制16FPS，且最后一组两个Peer高于100ms，整体目标尚未达到。

交替复核中native receiveTime→presentationTime的p95从97–114ms降到2.69–3.79ms，与前一分段诊断指出的主段相符。loss/PLI/NACK增量均0。GPU3D本轮79.28%→78.23%；先导对照96.12%→78.20%的大幅GPU下降未重复，不将其作为稳定收益。

已按主Agent指定完成有界交替复核，未改默认或推广，未追加其他参数组。

## 单变量与请求启用证据

基线为profile-off `osr-deadline-4x1080-render16`，候选为 `osr-deadline-4x1080-render16-playout0`。唯一变化是现有Endpoint `--rtc-playout-max-ms=0`，请求RTP播放延迟min/max=0/0。不是Client playoutDelayHint，也没有关闭marker或加入特殊Client浏览器flag。

其余相同：精准render16、四1080、snapshot、最终Client bundle、5秒暖机+20秒采样、1Hz marker、每peer24Mbps/RTT10ms、d1/TU1/VBR、capture/atlas/QSV名义fps60、DComp/host scale auto、capture cap/gate off、全部profile关闭。

两组fingerprints所有键完全相同，包括browser/service/DLL、fixture、正式工具和全部Client assets。

四个Peer的effective offer与answer均协商同一个扩展：

`a=extmap:5 http://www.webrtc.org/experiments/rtp-hdrext/playout-delay`

候选的Endpoint `rtcPlayoutDelayRequested` 与SDK sender `requestedPlayoutDelay` 在全部观测中均为minMs0/maxMs0；基线为-1/-1。确认请求已开启，不将0/0解释为消除全部网络jitter、解码或GPU等待。

## 同版本profile-off对照

| Peer | 基线canvas FPS | 0/0 canvas FPS | 基线marker p95 | 0/0 marker p50/p95 |
|---|---:|---:|---:|---:|
| 0 | 14.44 | 15.99 | 311ms | 73/89ms |
| 1 | 14.69 | 16.04 | 379ms | 113/139ms |
| 2 | 15.40 | 15.94 | 370ms | 62/88ms |
| 3 | 15.04 | 15.94 | 311ms | 76/82ms |

两组source RAF/render均为准确16FPS。候选decode15.99–16.05FPS，所有Peer保持正常H264、snapshot及实际canvas呈现。

native receive→presentation统计取正式20秒窗口的全部rVFC metadata，按每个字段自身时钟求差，不依赖JS像素marker映射：

| Peer | 基线p50/p95 | 0/0 p50/p95 | 0/0样本 |
|---|---:|---:|---:|
| 0 | 110.23/159.27ms | 1.71/3.39ms | 320 |
| 1 | 118.78/206.36ms | 1.65/2.75ms | 321 |
| 2 | 142.95/243.59ms | 1.31/4.76ms | 319 |
| 3 | 104.59/154.06ms | 1.11/2.68ms | 319 |

receiveTime为该帧最后网络包到达，presentationTime为video交给浏览器合成。它不表示所有jitter都为0，而是本次该native播放/视频呈现段确实显著缩短。

candidate marker读回p95为33.09–36.21ms，基线为77.71–102.03ms。读回仍为同机共享GPU成本，未从测量中移除。

| 同一物理3D引擎 | 基线 | 0/0 |
|---|---:|---:|
| 总busy均值 | 96.12% | 78.20% |
| source GPU进程 | 28.48% | 24.97% |
| browser桥 | 10.04% | 9.35% |
| Endpoint | 21.60% | 20.04% |
| receiver GPU进程 | 25.02% | 23.82% |

候选receiver loss/PLI/NACK增量及relay丢包均0。资源结果是本次有界观测，不额外推断GPU降低的内部机制。

## 交替复核：0/0→未设置→0/0

首个0/0沿用上述20秒组。随后 `osr-render16-playout-unset-reverse40` 和 `osr-render16-playout0-reverse40` 各暖机5秒、有效采样40秒，实际每Peer elapsed为40008–40016ms。三组使用相同browser/service/Client及fixture；两次40秒组fingerprints所有键相同，profile全部关闭。正式工具未为延长采样重构，只修改该case生成的config/run.js sampleMs。

| Peer | 首次0/0 FPS / p95 | 未设置 FPS / p95 | 再次0/0 FPS / p95 |
|---|---:|---:|---:|
| 0 | 15.99 / 89ms | 15.27 / 169ms | 15.95 / 143ms |
| 1 | 16.04 / 139ms | 15.07 / 233ms | 15.97 / 92ms |
| 2 | 15.94 / 88ms | 15.64 / 180ms | 15.95 / 136ms |
| 3 | 15.94 / 82ms | 15.17 / 172ms | 15.97 / 90ms |

两次40秒source RAF均16.000±0.001FPS；decode分别16.02–16.05和16.00–16.02FPS。未设置组实际canvas略低于解码速率，0/0组canvas接近source16。每Peer loss/PLI/NACK增量均0。

| Peer | 未设置native receive→presentation p50/p95 | 再次0/0 p50/p95 | 样本（未设置/0） |
|---|---:|---:|---:|
| 0 | 72.94/99.99ms | 0.83/3.79ms | 611/638 |
| 1 | 73.82/106.56ms | 1.17/3.38ms | 603/639 |
| 2 | 74.05/113.86ms | 1.17/2.69ms | 626/638 |
| 3 | 64.40/96.68ms | 0.69/2.88ms | 607/639 |

四Peer两轮offer/answer仍协商同一playout-delay扩展。未设置组全部Endpoint/SDK观测为-1/-1，再次0/0组全部为0/0。变化的确落在请求控制的native播放/视频呈现段；未声称0/0消除全部jitter。

| 同一物理3D引擎均值 | 首次0/0 | 未设置40秒 | 再次0/0 40秒 |
|---|---:|---:|---:|
| 总busy | 78.20% | 79.28% | 78.23% |
| source GPU进程 | 24.97% | 25.28% | 25.64% |
| browser桥 | 9.35% | 9.76% | 9.29% |
| Endpoint | 20.04% | 21.01% | 20.06% |
| receiver GPU进程 | 23.82% | 23.23% | 23.24% |

marker读回p95：未设置27.70–33.37ms，再次0/0为29.12–35.92ms。读回负载没有被移除；本轮GPU总量和receiver GPU基本相当，延迟收益仍出现。首个旧基线资源更忙，因此先导对照较大的GPU差异不能单独归因于播放请求。

## 40秒日志恢复

40秒报告单Peer为639–655KiB。Control并发appendFile把四份JSONL报告按512KiB块交错，造成原文件不能按行解析；实验和metrics上传本身成功。原文件完整保留，没有覆盖。

离线恢复仅重排原始完整字节块：识别四个512KiB前缀和四个换行结尾尾块，枚举24种归属。每case只有一个排列同时满足完整JSON、每Peer RTP连续、native now/presentedFrames单调；8份报告各保留Tenant/Session/SSRC、首尾RTP、块偏移与SHA256。没有补字段或插值，恢复文件与原文件总字节数相同。

证据在每case的 `metrics/client-metrics.recovered.jsonl` 与 `metrics/recovery-manifest.json`；原文件仍为 `metrics/client-metrics.jsonl`。`develop/tmp/osr-playout-reverse-result/run-recovered-analysis.py`只为本次分析将读取切到独立恢复文件，正式分析器未修改。触发、非GPU复现和修复建议见 `develop/docs/metrics-jsonl-interleaving.md`。

## 产物与清理

原始数据：`develop/tmp/osr-deadline-4x1080-render16-playout0`。SDP、Endpoint/SDK启用记录、每Peernative分布和资源角色汇总：`develop/tmp/osr-playout-result/feedback.json`；标准cadence/resource/matrix分析完整保留。

此前profile诊断报告为 `develop/docs/osr-render16-segment-profile.md`，其147–245ms marker结果没有作为本对基线。

反向复核完整native/启用/资源汇总为 `develop/tmp/osr-playout-reverse-result/feedback.json`，标准summary/resource-summary及原始日志分别留在两case。

所有本轮case已清理，无GPU实验或构建运行；未改生产源码、默认或调度策略。新增的CPU复现工具不参与产品运行。
