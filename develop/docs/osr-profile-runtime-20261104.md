# OSR 分段与 RTP playout 对照（2026-11-04）

同一套 instrumented Browser、SDK、Endpoint 和 Control 对照了不发 RTP playout-delay 与显式 min 0/max 50ms。Chrome 157 headless、UHD630/QSV、1920×1080/DPR 1、模拟约 60Hz，实际 atlas 1936×1008。CDP 每向 5ms、6,000,000 B/s（48Mbps）、0 loss，独占串行运行。每组先测 20 秒同步 marker，再沿同一 peer 测约 20 秒不读 marker，两窗均发 18 个可信点击。第一次默认组未进入有效测量，成功重试才计入对照。

| RTP 请求、窗口 | H264 decode FPS | Video compositor FPS | rVFC callback FPS | Video dropped / total | 接收→compositor p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 未设置、同步 marker | 58.28 | 54.95 | 51.76 | 64 / 1169 | 72.2ms |
| 未设置、无 marker | 58.46 | 55.48 | 55.53 | 58 / 1172 | 78.5ms |
| 0/50ms、同步 marker | 58.30 | 58.06 | 56.52 | 4 / 1169 | 47.2ms |
| 0/50ms、无 marker | 58.35 | 57.87 | 57.92 | 9 / 1170 | 50.4ms |

无 marker 窗仍有约 28ms 接收等待收益和约 2.4 FPS 合成收益。该窗 RTC actual jitter buffer delay 按 emitted frame 计算由 59.6ms 降到 28.9ms。两个模式的网络整形与 Viewer jitterBufferTarget=0 一致。compositor FPS 来自 rVFC 的 presentedFrames 增量，Video drop 来自同一元素的 getVideoPlaybackQuality() 增量，均为浏览器端计数。

## Native 和接收分段

表中 p95 取 analyzer 最接近 95% 的排序索引。四个窗口的 wire 样本为 1170、1172、1169、1171，全部与 OSR Begin、GPU ready 观察和编码身份精确连接。单位均为 ms。

| QPC 或同帧时钟分段 | unset marker | unset clean | 0/50 marker | 0/50 clean |
| --- | ---: | ---: | ---: | ---: |
| Comp Begin→ready Fence 观察 | 13.49 | 9.47 | 11.28 | 9.47 |
| Rend plane issue→result | 6.09 | 2.26 | 4.62 | 2.01 |
| Rend Signal 调用前→ready Fence 观察 | 7.20 | 6.95 | 7.48 | 6.84 |
| Encoder worker queue | 0.02 | 0.02 | 0.03 | 0.02 |
| HW submit→complete | 7.13 | 7.02 | 7.37 | 6.95 |
| Comp Begin→encoded return | 25.11 | 20.91 | 22.85 | 20.37 |
| Encoded return→接收最后包 | 18.22 | 18.09 | 18.15 | 17.73 |
| Decoder processing | 1.40 | 1.20 | 1.50 | 1.20 |
| Compositor submission→rVFC | 2.30 | 2.20 | 2.30 | 2.30 |

Rend 单 Work 队列四窗 p95 均 <0.01ms。QSV Reset 22/22/21/19 次，整段 worker SetRates p95 0.30/0.17/0.14/0.13ms。实验中主要改善发生在接收→compositor。Encoded return→receive 合计 sender 排队、传输和接收。Signal→ready 以 Comp 观察到实际 fence 为终点。

## 输入尾部和采样负担

18 个实际输入的 Viewer event→marker rVFC，中位数 120.3→112.4ms，第二大 165.0→153.1ms。Viewer nearest-rank p95 在 18 样本中取最大，因此报告 168.0→183.5ms。最大 0/50 样本是首次点击，发送前耗时 47.1ms，其中 event 时间戳→捕获监听器 14.5ms、监听器→实际 DC send 32.6ms。上一个 12.7ms 同步 marker 读回与前段重叠，该组缺少 focus ACK 时间。此样本 send→远端 handler 23ms，handler→被采样 marker draw 37ms（晚 3 个页面帧），draw→receive 47.6ms，receive→compositor 27.6ms。旧默认组最慢输入的接收→compositor 为 58.6ms。45ms 采样间隔会选到更晚的反应帧，marker 读完时间单独记录。

另做一组 0/50 Worker marker，18/18 反应匹配。最慢仍是首次点击 162.4ms，第二大 133ms。首击确实排队等待 focus，focus send→ACK 27.0ms，输入在 ACK 后 0.4ms 发送。后续输入没有 pending focus。108 个 Worker 样本全部完成，capture call p95 1.0ms、worker turnaround p95 10.5ms，最大在途 2，所有 ImageBitmap 均关闭。该组 decode 58.27、compositor 57.49 FPS，14/1170 Video drop，采样 render→rVFC p95 99ms。它使用不同的 marker 采样节拍。各组均未复现近 1 秒输入延迟。

Chrome 89.0.4389.90 做了 0/50 短兼容组。真实 H264 默认 video，playoutDelayHint=0，受信任 touch 的终态处理成功，peer、数据通道、video 元素和 track 保持。短窗约 58.12 decode/56.49 compositor FPS，3/175 drop。

## 策略和证据

Endpoint 新默认请求官方 RTP min 0/max 50ms。显式 --rtc-playout-max-ms=-1 从建连起省略该请求，原合法值 override 仍可用。Chromium 157 用最多 3 帧减去解码前 buffer 的 composition budget，Blink 采用官方低延迟 renderer。有效 min=0 时使用 8ms 最小 decode 调度间隔，积压时可提前调度，A/V sync 可提高有效 min。50ms 是 RTP 请求值。

原始记录在 develop/tmp/osr-video-profile-20261104 的 instrumented-default-retry、instrumented-max50、instrumented-max50-worker 和 instrumented-max50-chrome89。使用 [server trace analyzer](../../tools/analyze-streaming-server-trace.py) 解析主窗，使用 --profile video-profile-clean.json 单独解析无 marker 窗。按窗口筛选相同 stimulus 序号的远端 handler。Join 使用 Browser PID、generation、slot/value、Endpoint 逐帧 cookie、实际 wire RTP，以及输入 peer/client/browser sequence。Server 环允许覆盖启动记录，四个 A/B 窗口均完整保留 wire 对应 Rend 链。
