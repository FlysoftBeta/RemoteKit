# Pacer绝对相位与精准deadline修复

## 结果

定时精度已修复。轻量single场景中，配置60/30/20的实际提交与ACK分别为59.98/30.02/19.98次每秒，RAF为60.005/30.000/19.994FPS；旧的约15.6ms量化已消失。

随后四租户1080对照确认：准确16FPS优于准确20FPS的最终输出。16档canvas14.44–15.40FPS、marker p95为311–379ms；20档虽然编码增至17.5–18.1FPS，但canvas降至10.30–10.94FPS、p95升到736–800ms，GPU再次接近满载。

默认仍0，未推广16档，未实现自适应策略，也未追加60档重负载对照。低render预算还没有达到 >50FPS/<100ms。

## 实现

只修改 `browser/offscreen_host.{h,cc}`，以官方DeadlineTimer取代RepeatingTimer。启用demand或改变fps时建立新相位；以后按整数interval槽推进绝对deadline，迟到时跳过过期槽，不逐轮追赶。

实际读取官方 `base::kMaxPreciseDelay.Get()`。调度器会把距离大于等于该阈值的kPrecise任务降级，所以较远deadline先用kFlexibleNoSooner安排coarse预唤醒，进入精确窗口后再以kPrecise安排真正deadline。默认阈值36ms时窗口为32ms，保留4ms余量；预唤醒不发BeginFrame。较小阈值也保留至少1us且不超过半个阈值的余量；阈值小于等于1us时使用一个可取消coarse任务，避免预唤醒自旋。

单pending与合并保持：Timer到期生成一个最新tick信用；ACK只尝试消费该信用，不再调用产生新信用的Timer入口。已经排队的ACK唤醒与Timer相遇也不会多制造tick。取消仍按controller代次/sequence校验，GPU恢复不重放多轮旧tick；停止demand和Detach取消当前计时。GPU fence、capture lease、atlas发布与QSV参数未改。

首轮轻量诊断发现 `TimeDelta / TimeDelta` 返回double，会把小数迟到量加回deadline而留下约0.8ms/帧漂移。已改用官方IntDiv返回int64的整槽推进，并重新完成正式节拍验证。delivery已只读复核整数推进、阈值边界、取消及ACK/timer交错。

没有修改全机timer、忙等、Viz或Chromium patch。

## 定时证据

正式case为 `develop/tmp/osr-deadline-phase{60,30,20}`，single640×360，1秒暖机+6秒采样，marker读回关闭，仅验证source节拍。早期 `osr-deadline-cadence*` 为诊断数据，不替代修正后的正式case。

| 配置 | snapshot提交/ACK每秒 | RAF FPS | RAF间隔p50/p95 | coarse预唤醒增量 | phase跳槽增量 |
|---|---:|---:|---:|---:|---:|
| 60 | 59.98/59.98 | 60.005 | 16.7/18.0ms | 0 | 0 |
| 30 | 30.02/30.02 | 30.000 | 33.3/34.5ms | 179 | 0 |
| 20 | 19.98/19.98 | 19.994 | 50.0/51.4ms | 150 | 0 |

snapshot区间约7.5秒，含暖机与采样，RAF列为正式6秒窗口。三档实际阈值均为36000us；30/20档有真实coarse预唤醒，验证了超过阈值的间隔没有直接假标kPrecise。每case保存 `timer-evidence.json`。

## 四租户有界对照

case为 `osr-deadline-4x1080-render16` 与 `osr-deadline-4x1080-render20`。同新binary、最终Client bundle、profile off、marker1Hz、5秒暖机+20秒采样；snapshot、d1/TU1/VBR、每peer24Mbps/RTT10ms、DComp/host scale auto、capture cap/gate off。capture/atlas/QSV名义fps保持60。

| 配置 | source RAF FPS | pacer提交/ACK每秒 | GPU atlas copy FPS | encode FPS | canvas FPS | marker p95 ms | GPU3D均值 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 16 | 16.000 | 15.99–16.04 | 16.0 | 15.9–16.1 | 14.44–15.40 | 311–379 | 96.12% |
| 20 | 20.000 | 20.00–20.05 | 19.9–20.8 | 17.5–18.1 | 10.30–10.94 | 736–800 | 99.60% |

ACK/提交差异最多是快照边界的一帧；统计使用最后约19.5秒enabled快照，与客户端稳态窗口可相差一轮Control轮询。两档merged与controller cancellation差分均0。累计phase跳槽最多分别1/2次，未追发过期槽。

marker读回p95从16档78–102ms变为20档312–364ms，capture→ready的每秒最新帧观测p95从28–44ms变为46–70ms。后者不是所有capture请求的耗时分布，也不能称纯GPU copy。所有QSV appliedFps观测仍为60。两档relay无丢包、receiver PLI/loss增量0。

同Intel物理3D引擎的角色均值：

| 角色 | 16档 | 20档 |
|---|---:|---:|
| source GPU进程 | 28.5% | 35.1% |
| browser桥 | 10.0% | 13.0% |
| Endpoint | 21.6% | 24.2% |
| receiver GPU进程 | 25.0% | 18.6% |

source GPU进程CPU0.69→0.87核，source renderer0.56→0.91核。20档增加源端工作并挤压实际接收呈现；准确16档与此前旧timer20档的实际约16FPS方向一致。本轮每档一次，保留单次结果，不擅自重复或调整默认。

原始metrics、source trace、资源计数与endpoint snapshots完整保留；汇总和精确计数为 `develop/tmp/osr-deadline-result/feedback.json`。表中canvas使用真实 `metrics.displayFps`，不是通用matrix遗漏的paint字段。

## 功能与构建收尾

统一browser/demo/SDK增量构建、SDK导出与diff check完成。当前browser SHA256 45E8ABF8455ABDD3458DBD978225D9650E79A3DFDF4E2CFF1A066C808EE21C40；service仍为90F6DDB844CA13A440C76995C0EC8BDAEC8165FC0E4A0BFADA93470A4CEEA8E7。最终Client为index-Bsj1jkWQ.js，各case保存完整指纹。

额外一个短静态页回归 `osr-deadline-static-input`：Chrome89 H264，hover不变焦，真实点击marker60001、IME后视频marker42；关闭订阅后重新连接，共享输出generation1→2且静态marker42重新到达，验证停用/恢复后不会永久停帧。没有重跑完整功能矩阵。

实验与构建均已结束，自有case进程已清理。源码冻结，未commit/push；后续策略由主Agent决定。
