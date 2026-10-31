# RTP playout-delay有限接入与对照

新增C ABI与CLI已完成，**默认保持unset**。max0与10ms确实缩短接收后的等待，但720单租户绘制提交FPS降到45–46，未同时满足>50FPS与p95<100ms；不据此改默认。只做主Agent批准的两组max0及唯一720×1 max10补充，没有扫描其他数值。

## 接口和验证

`remotekit_rtc_set_playout_delay(peer,int32_t min_ms,int32_t max_ms)`：不改已有struct或ABI2。有效范围0<=min<=max<=40950，均为10ms整数倍；默认未设置。`-1,-1`仅在从未显式设置时是成功no-op；显式设置后取消返回INVALID_STATE并保留原request，回默认需重建peer，仍可更新成另一有效pair。原因是官方sender/receiver会保留此前已收到的RTP界限，后续不带header不等于撤销。

Peer API同一锁串行setter和取消检查；一个atomic packed pair让异步encoded completion读到一致min/max。共享状态跨encoder重建保持，关闭沿既有屏障。EncodedImage使用官方VideoPlayoutDelay；默认不设置。SDK sender stats的`requestedPlayoutDelay`及endpoint `rtcPlayoutDelayRequested`均标请求，不是接收端实测保证。

Endpoint `--rtc-playout-max-ms=N`默认-1不调用，显式值min0/maxN在peer创建后、SDP与frame前设置，失败清理peer并传播。更新后的loader要求新符号。服务SHA256 `876fc2094c5c3fb5d90322315f5c7c6738013d47c0dd5c5dc4d6f5d4eaa5d595`。

统一browser/demo/SDK增量36.30s及SDK语义收口12.24s通过；独立SDK4/4 RTC检查1.95s通过，含范围/10ms边界、跨线程、默认noop、显式后取消失败且stats仍保留0/0、有效更新、关闭后拒绝。Endpoint CMake/CTest1/1通过。Control先完成hover/modifiers、click/IME与mixed DPR真实短回归，随后才跑本节性能组。

## 条件

每组5s暖机、20s有效；真实UHD630/QSV d1/TU1/VBR、名义60fps、每peer24Mbps双UDP relay/每向5ms；Chrome89.0.4389.90，DPR1，实际backing已修正。marker1Hz，receiver playoutDelayHint实际0；不启动无意义client RAF探针。720只有明确的客户端`--disable-frame-rate-limit`特殊profile，四1080保持默认client flags。不同配置无GPU并发。

终点是Viewport drawImage返回后记录的JS绘制提交，不是GPU完成或物理present。marker额外同步读回/CRC成本单列。unset基线来自同backing修复、同网络与marker设置的已有case；新binary另包含不参与这些无输入性能组的hover修复，未重跑基线。

## 720单租户，特殊客户端flag

| RTP请求 | 绘制提交FPS | source / decode FPS | render→提交p50/p95/p99 ms | 同RTP接收→提交均值/p95 ms | marker额外成本均值/p95 ms |
|---|---:|---:|---|---|---|
| unset基线 | 53.03 | 53.1 / 53.1 | 99 / 103 / 104 | 37.85 / 41.75 | 6.46 / 9.83 |
| 0/0ms | 46.13 | 52.9 / 52.9 | 74 / 82 / 95 | 9.74 / 16.80 | 7.43 / 9.43 |
| 0/10ms | 45.43 | 52.9 / 52.9 | 77 / 92 / 99 | 11.33 / 19.23 | 7.60 / 11.07 |

每组20个CRC有效marker。render→最后视频包接收均值分别61.60/62.56/63.22ms，基本不变；收益明确在接收→绘制提交段。所有组RTP loss和receiver framesDropped增量0，decode约53fps。

FPS损失不来自大量epoch gate拒绝：0/0组923次rVFC全部matched、missed0；0/10组同样没有大量gate miss。video presentedFrames计数仍约53/s，而JS rVFC/绘制提交约46/45，损失在视频合成到JS/canvas消费环节。这个计数也不等于物理屏刷新。仅凭现有记录不能把损失精确归到callback注册、ASAP渲染或合成调度，不扩大前端实现改动。

## 四1080，默认客户端

| RTP请求 | 绘制提交FPS/租户 | source / decode FPS | render→提交p95 ms/租户 | 同RTP接收→提交均值范围 | marker额外成本均值范围 |
|---|---:|---|---:|---:|---:|
| unset基线 | 8.54–8.69 | 20.2–20.5 / 12.2–12.5 | 1004–1096 | 235.4–321.0ms | 160.9–174.2ms |
| 0/0ms | 7.24–7.52 | 约19.5 / 约11 | 869–1027 | 57.0–87.1ms | 191.0–209.4ms |

每租户19个有效marker，RTP loss/receiver framesDropped/relay drop增量均0，encoder错误均null。source→接收均值仍约668–700ms，max0未解决服务器前段老化；GPU/读回观测负担仍明显。四租户总共仅1次gate missed，不能解释主要FPS损失。这里不因延迟减少就宣称整体吞吐改善。

## 证据与结论

- 基线：`backing-fixed-unlimited-720-t1-marker1`、`backing-fixed-1080-t4-marker1`。
- 新组：`playout-max0-unlimited-720-t1-marker1`、`playout-max0-default-1080-t4-marker1`、`playout-max10-unlimited-720-t1-marker1`。
- 各组保存config/fingerprints、原始metrics、presentation-raw、resource摘要；实际SDP协商playout-delay extension，双方stats请求值与CLI一致。
- 同RTP比较逐样本与分布：`develop/tmp/playout-delay-comparison.json`；原先只读分段依据：`develop/tmp/latency-audit/`。

接收等待降低是实测；0/10ms没有恢复>50FPS，正数最小粒度也未消除权衡。按主Agent选择，默认保持未设置，保留显式选项。所有测试进程已退出；不追加性能组。RTP界限是best effort，CLI值不表示端到端延迟或接收缓冲被硬性限制在该毫秒数内。
