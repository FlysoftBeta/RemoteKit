# QSV 有界参数实验结果

本轮完成参数筛选、16 组 1/4 租户网络矩阵、质量、输入与分层对照。**没有配置达到实际显示平均 FPS >50 且 render→paint p95 <100ms。建议开发默认 d1 / TU1 / VBR / VBV1000ms，保留 WebRTC 拥塞控制。** d4/TU7 在四租户 720p 的编码吞吐略高，未解决源和呈现瓶颈，不另设吞吐默认。

测量阶段 UTC 2026-10-31 20:08–21:05，单参数组独占 GPU；四租户组内部有四个同时工作的 Session 和接收页面。每组至少 5s 暖机、20s 有效段。CPU/GPU/测试浏览器已全部释放。

## 条件和口径

- Intel UHD630，驱动 30.0.100.9805；真实 oneVPL/QSV 硬件编码，Release service SHA256 `cb3ba5487db9a88f7f8d6f8c8864893dbcfd66b6fdd7d56f32f86c16686a293f`。NVENC 编译成功，本机无 NVIDIA，未做运行性能比较。
- 客户端为指定 Google Chrome **89.0.4389.90**，headed；H264 constrained-baseline 接收档 4.2，实际编码 level42、BT709 limited VUI。每租户一个可见页面、一个可见 WebView、DPR1。桌面 viewport 与实际带 padding 的视频尺寸见表，没有通过降采样获得 FPS。
- 所有接收页面在独立 contexts/windows，visibilityState 全为 visible。flags 包含 disable-background-timer-throttling、disable-renderer-backgrounding、disable-backgrounding-occluded-windows 和禁用 NativeWinOcclusion；完整 argv 存各 case metrics。Windows 会话为 Disconnected/RDP，DWM 报 60Hz但实际客户端 RAF/rVFC约32Hz；不能作为物理屏幕结果。
- 真正 UDP 双 socket relay，每向 5ms 基础延迟、下行每 peer 独立 24/48Mbps，四租户总预算分别96/192Mbps；不是共享总24/48。排队/进程调度会增加实际 RTT，不能把配置10ms称为每个包实测恒定10ms。SDK实验环境官方 opt-in 真实127 host candidate，双方 selected pair 和 relay字节可核对，无直连绕过。
- FPS 使用选中平面 canvas 实际 paint 的独立 wire RTP；每秒 FPS 保存完整20个计数。marker 5Hz，同RTP快照、CRC通过，延迟时间戳取 paint 时刻，读回/CRC处理成本另记。同机 Date.now 用于 render→paint；输入用客户端 monotonic 发起→匹配刺激像素的 paint。
- Chrome89 `playoutDelayHint` 实际支持，所有矩阵明确设0/readback0；四项 jitterBuffer delay/count/target/min stats均缺失，未填0。sender BWE/实际 video bytes 来自 SDK发送方向，不使用客户端上传 BWE。

## 16组矩阵

Q=d1/TU1/VBR，T=d4/TU7/VBR，均 VBV1000ms、硬件名义60fps、请求初始18M/上限40M。四租户数值范围覆盖各租户；每秒分布合并租户秒样本，不是置信区间。

| 档 | viewport / atlas px | 租户 | 每租户Mbps | paint FPS | 每秒FPS p05–p95 | render→paint p50 / p95 / p99 ms | video实发Mbps |
|---|---|---:|---:|---:|---:|---|---:|
| Q:d1/TU1 | 1280×720 / 1288×728 | 1 | 24 | 31.5 | 30–32 | 102 / 110 / 117 | 3.22 |
| T:d4/TU7 | 1280×720 / 1288×728 | 1 | 24 | 31.7 | 31–32 | 100 / 111 / 112 | 3.79 |
| Q:d1/TU1 | 1280×720 / 1288×728 | 1 | 48 | 30.7 | 22–32 | 119 / 130 / 137 | 3.99 |
| T:d4/TU7 | 1280×720 / 1288×728 | 1 | 48 | 31.3 | 29–33 | 106 / 115 / 124 | 3.65 |
| Q:d1/TU1 | 1280×720 / 1288×728 | 4 | 24 | 5.9–6.7 | 4–8 | 576–745 / 663–836 / 692–890 | 1.12–1.25 |
| T:d4/TU7 | 1280×720 / 1288×728 | 4 | 24 | 6.4–7.5 | 5–9 | 449–556 / 632–732 / 659–769 | 1.18–1.55 |
| Q:d1/TU1 | 1280×720 / 1288×728 | 4 | 48 | 6.5–6.8 | 5–9 | 531–686 / 648–763 / 655–807 | 1.06–1.23 |
| T:d4/TU7 | 1280×720 / 1288×728 | 4 | 48 | 6.3–7.9 | 5–10 | 470–532 / 601–715 / 637–751 | 1.14–1.27 |
| Q:d1/TU1 | 1920×1080 / 1928×1088 | 1 | 24 | 25.3 | 21–29 | 193 / 206 / 210 | 2.62 |
| T:d4/TU7 | 1920×1080 / 1928×1088 | 1 | 24 | 23.8 | 21–29 | 188 / 214 / 217 | 3.01 |
| Q:d1/TU1 | 1920×1080 / 1928×1088 | 1 | 48 | 23.1 | 19–27 | 187 / 213 / 217 | 3.89 |
| T:d4/TU7 | 1920×1080 / 1928×1088 | 1 | 48 | 24.7 | 20–29 | 187 / 203 / 207 | 4.09 |
| Q:d1/TU1 | 1920×1080 / 1928×1088 | 4 | 24 | 3.7–3.9 | 3–5 | 852–915 / 1098–1205 / 1146–1266 | 3.04–3.30 |
| T:d4/TU7 | 1920×1080 / 1928×1088 | 4 | 24 | 3.5–4.0 | 2–5 | 842–907 / 1033–1171 / 1130–1262 | 3.25–4.18 |
| Q:d1/TU1 | 1920×1080 / 1928×1088 | 4 | 48 | 3.7–4.3 | 2–5 | 862–1019 / 1138–1267 / 1173–1342 | 3.81–4.19 |
| T:d4/TU7 | 1920×1080 / 1928×1088 | 4 | 48 | 3.6–4.3 | 3–5 | 796–910 / 972–1165 / 1023–1284 | 3.95–4.41 |

完整40行 source→capture→publish→copy→encode→decode→paint、每秒FPS、CPU、实际frame bytes、sender BWE/码率、queue/loss/PLI及缺测字段：[matrix-layer-check.json](matrix-layer-check.json)。较易阅读的分层表：[matrix-layer-check.md](matrix-layer-check.md)。

原720组的 capabilities 面板遮挡了marker底部，CRC全部无效；FPS仍保留，延迟不采用。Control只把marker z-index3改5后重跑全部8组，最终表优先 `-marker-visible`，各租户有效marker72–92个、invalid0。新fixture SHA256 `bee998b6276a4a3df0320d55f302be5dbcab60a7a79599170bbd5554dcc021c0`；1080旧fixture未遮marker，SHA `3dca352d58c9f61a4ea4887413598c1680e7d3d02764e1c9baf5d88a3ff46c3f`。旧case副本未改。

## 分层与观测成本

720单租户 source/capture/encode/decode约53，paint约31；1080单租户前四层约31，paint23–25。四租户720源约18、编码16–18、paint6–8；1080源本身约8、编码约10、paint约4。全机CPU p50约33–65%，四租户p95约67–81%；没有GPU利用率或逐进程CPU，因此不能把源下降直接判为某一个GPU引擎饱和。

1080×4、d1/TU1/VBR、每peer24M的对照：

| 组 | source FPS | encode FPS | paint FPS | 关键帧/租户/20s | 有效marker/租户 | render p95 |
|---|---:|---:|---:|---:|---:|---:|
| 5Hz marker，idle150ms | 7.7–7.9 | 9.7–10.3 | 3.7–3.9 | 51–61 | 63–65 | 1098–1205ms |
| marker0，idle150ms | 7.2–7.7 | 9.6–10.0 | 8.0–8.3 | 49–66 | 无 | 缺测 |
| marker1Hz，idle150ms | 7.4–7.8 | 9.8–10.2 | 6.6–7.5 | 51–61 | 19 | 1051–1094ms |
| marker0，idle0 | 7.7–8.2 | 7.4–7.9 | 6.5–6.9 | 1 | 无 | 缺测 |
| CSS合成滚动，marker0，idle150ms | 7.4–8.2 | 9.8–10.4 | 7.6–8.7 | 56–66 | 无 | 缺测 |

marker读回在四租户1080每次p50约169–188ms，单租户约7–15ms；1Hz仍有可见扰动，不作为“无干扰”测量。关掉marker提高paint，但源仍约8fps。CSS对照也未解除源瓶颈，因此全Canvas重绘不能单独解释此四租户结果。同机四个接收解码器、GPU读回和Node整形共享资源，结果不能直接外推四台物理客户端。

矩阵receiver PLI/loss增量及relay drop均0，实际sender video远低于24/48M，不是耗尽网络预算。单租户sender RTT各组p50为11–12ms、p95为11–19ms；四租户各组p50为11–16ms、p95为12–30ms。sender每包平均本地发送等待（totalPacketSendDelay增量/packetsSent增量）单租户0.09–0.81ms、四租户0.04–5.71ms。relay排队峰值约61–112KiB；原始RTT/排队lateness/累计bytes均保留。基准10ms与调度/队列增加的RTT须分开。

固定150ms尾IDR会在低源FPS的动态间隙反复触发：idle0将关键帧从49–66降为1，CPU p50从57.8%降为53.1%，编码不再比真实源多约2fps；paint没有改善。说明额外IDR确有负担，但不是源8fps的主因。主Agent已另安排按真实源间隔调节尾IDR；本表是修复前冻结binary，不能冒充新版本结果。

## 参数筛选与质量

筛选覆盖depth1/2/4、TU1/4/7、CBR/VBR、VBV250/1000ms。修复IDR标志短路、固定名义fps与HRD-off bitrate-only Reset后，1080单租户关键帧从约53降为5/20s；不再为普通BWE更新重启编码序列。d4/TU4相对d1只有小幅FPS变化，VBV250未显示稳定延迟收益。

CBR筛选实际输出约16–18Mbps，VBR约2.5–4.1Mbps；1080单租户frame bytes p95由约75KiB降到约22–25KiB。固定名义60fps而源约30，会使CBR实际输出约请求的一半；这是当前效率代价。不能只凭VBR更省带宽断定画质等价，已补真实接收画质：

| 同1080/d1/TU1/24M质量场景 | CBR RGB PSNR / MAE | VBR RGB PSNR / MAE |
|---|---:|---:|
| 静态首屏最终帧 | 23.46dB / 8.81 | 23.50dB / 8.48 |
| 大变化后停止最终帧 | 28.06dB / 4.12 | 27.91dB / 4.24 |

每次运行内部source/decoded均匹配CRC marker frameId与timestamp，ROI x24/y128/1000×260，包含文字和1px细线、不含DOM浮层。CBR/VBR是独立运行，各自引用本次源帧；不是两个编码器处理完全相同的运动序列，也不能把不同场景的23/28dB差异归因成某一参数收益。Sol已看PNG：首屏文字/细线均软化，停止后文字较清楚；VBR没有出现额外明显文字损坏。这支持当前VBR候选，但不等于所有运动画质已量化。CBR change-stop有20个receiver lost/1PLI，VBR为0lost/1PLI，最终参考帧都已恢复解码。

质量目录：`quality-static-1080-d1-tu1-cbr-24`、`quality-static-1080-d1-tu1-vbr-24-retry`、`quality-stop-1080-d1-tu1-{cbr,vbr}-24`。各目录`quality-0.json`和`source-trace/*-{source-scene,decoded}.png`保存数值/图像。原VBR静态第一次因source helper过期失败，未计入。helper已延长为有界10min、cleanup校验进程身份，动态零CRC会在保存raw后明确报错。

启动8M对照未执行：服务已经请求18M且PeerConnection::SetBitrate成功，但真实Init仍2M。官方allocator的初始化与network-connected后分配时序尚未被实验证明；没有新增一个实际不生效的CLI，也没有硬改Init绕过CC。需要后续用真实Init/SetRates与首屏截图验证启动预算。

## 输入结果与后续

720单租户d1/TU1/VBR/24M、每秒一次IME刺激：19次输入全部匹配、无超时，input→paint p50/p95/p99 **127.44/176.38/176.38ms**；152个marker，render→paint **105/117/121ms**，paint31.04fps。pending输入期间逐paint读marker，包含其同步观测负担；未声称是无probe输入结果。目录`input-720-d1-tu1-vbr-t1-24-marker-visible`。

优先后续：Windows本机物理显示接收端对照与GPU/逐进程负载归因；源capture/合成/共享GPU约8fps的四租户瓶颈；低干扰marker读回；首屏真实码率生效与细线质量。DeadlineTimer precise开关已编译，但本轮没有普通/precise成对性能数据，不应据此改变默认。无需继续盲扫编码器参数。

复算入口：`tools/summarize-streaming-matrix.py`从case原始metrics/summary/control.err独立生成40行JSON和表；`tools/analyze-streaming-cadence.py`重建raw chunks；`tools/compare-streaming-quality.ps1 -Name <case>`强制源/接收同marker再算PSNR。正式工具不依赖本报告或develop中的既有分析文件。

## 最终尾IDR修复验证

初始57min测量冻结后，按主Agent决定修复动态低fps尾IDR误触发：阈值至少150ms、至少约3倍真实源间隔、上限1s，只由真实源更新间隔；QSV默认改d1/TU1/VBR。最终service SHA256 `dfe5f31ae7035e72d8801adafc6eb426c79478ecc0547581dbede94bca4fb575`。没有把旧16组标成此新版本结果。

新版本只做一组1080×4、每peer24M、1Hz marker、5s暖机+20s有效验证，目录`final-adaptive-idr-1080-d1-tu1-vbr-t4-24`：

- source7.7–8.3/capture7.8–8.6/encode7.4–7.9/decode7.4–7.9/paint5.8–6.1fps；CPU p50/p95 56.2/68.7%。PLI、receiver loss、relay drop均0、encoder错误均null。
- 有效阈值263–480ms；每租户encoded关键帧增量1–2、tail提交增量0–2/20s，消除旧版约51–61个/20s的风暴。
- 每租户18–19个有效marker、invalid0。render→paint p50为680–728ms、p95/p99为804–1010ms。问题仍未达到目标，关键帧修复不能写成FPS达标或瓶颈已解除。
- Endpoint独立静态change-stop检查确认高fps后阈值仍150ms、tail提交1次、实际距最后源帧150.9553ms，encoder错误null；证据`develop/tmp/final-tail-static/metrics/client-metrics.jsonl`。

最终组完成后所有测试进程与host浏览器再次退出，停止扩展实验。原16组用于参数比较，新组用于证明最终交付版本消除尾IDR风暴。
