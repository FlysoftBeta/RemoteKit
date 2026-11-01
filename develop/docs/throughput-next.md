# 0/0播放请求下的高帧率吞吐复核

## 结论

0/0没有解决高负载吞吐。单1080在GPU未满载时，接收端RAF仍约32Hz；四1080在source60和30两档均把3D引擎推至约99.8%，最终canvas只有约6FPS。下一轮应分别定位默认Chrome89的32Hz呈现节拍，以及四租户source渲染/采集与共享GPU的资源分配。单纯把render从60降至30仍没有退出满载区。

本轮三组使用相同binary、Client和fixture，全部指纹相同；profile关闭、snapshot、marker1Hz、DPR1、1920×1080 viewport、1928×1088编码、QSV d1/TU1/VBR、名义60fps、RTP请求0/0。每peer独立24Mbps、每向5ms整形，各暖机5秒+有效30秒，无额外客户端实验flags。Chrome为89.0.4389.90，现有host-managed Playwright driver运行headed实例。未改生产源码、GN、默认或正式工具。

## 分层结果

| 场景 | source RAF / 实际render FPS | Endpoint atlas copy FPS | encode FPS | decode FPS | 实际canvas FPS | marker p95 ms | marker数/Peer | GPU3D均值 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 单1080 render60 | 60.00 / 55.27 | 42.99 | 42.99 | 42.92 | 29.92 | 86 | 30 | 69.01% |
| 四1080 render60 | 52.46–54.62 / 40.82–42.74 | 12.16–12.90 | 9.26–9.80 | 9.20–9.86 | 5.56–6.00 | 1249–1473 | 27 | 99.73% |
| 四1080 render30 | 29.20–29.37 / 29.02–29.20 | 25.16–25.83 | 11.76–12.46 | 11.80–12.50 | 6.20–6.86 | 703–729 | 27–28 | 99.80% |

实际render来自fixture的真实绘制计数；RAF不能替代它。capture回调逐帧trace按本轮profile-off边界关闭，独立capture FPS缺测；atlas copy是Endpoint完成读取共享输出的计数，不能改称capture FPS。canvas从原始metrics.displayFps读取，通用matrix工具的paint字段仍缺测，表格没有沿用其missing字段。

三组全部marker CRC有效、页面visible、receiver loss/PLI/NACK增量0、relay drop0。实际sender RTT单租户p50/p95为11/12ms；四60各Peer p50为12–13ms、p95为13–20ms，四30为12ms、15–20ms。基础模拟延迟仍10ms，重载存在调度附加时间。

## 单租户默认Chrome89的节拍

| 观测 | 实际结果 |
|---|---|
| receiver RAF | 32.076Hz，间隔p50/p95 31.147/32.022ms |
| rVFC | 29.971Hz，间隔p50/p95 31.189/32.153ms |
| decode | 42.925FPS |
| native receiveTime→presentationTime | p50/p95 0.930/2.305ms |
| presentationTime→rVFC now | p50/p95 12.895/25.944ms |
| Client videoSnapshot CPU调用 | p95 0.905ms |
| Client viewportDraw CPU调用 | p95 0.365ms |
| marker同步读回 | p95 12.565ms |

低延迟请求已使接收→视频呈现段很短，但callback/canvas没有跟随43FPS解码输出。RAF本身也呈现约31ms量化，这给下一轮默认客户端调度定位提供了明确入口。不能把它归因于物理30Hz：只读显示探针报告Intel显示60Hz，DWM refresh/compose均60.00024Hz、QPC refresh period16.6666ms。

环境为session2、remote-session metric1、WTS disconnected、protocolCode0；host-managed receiver的已记录root PID19536，其父Playwright MCP PID9588也在session2。DWM统计处于断开会话，refresh/frame累计值极小，因此60Hz报告只能排除配置为30Hz，不能证明DWM持续真实交付60帧。接到窗口归属检查要求时driver已关闭全部receiver，没有伪造已不存在窗口的当前monitor归属；父进程身份保留在receiver-session-attribution.json。

## GPU角色与编码压力

同一Intel物理3D引擎按PID归属求和，不混合独立engine：

| 角色3D均值 | 单60 | 四60 | 四30 |
|---|---:|---:|---:|
| source GPU | 28.97% | 64.17% | 49.79% |
| source browser桥 | 9.13% | 9.42% | 17.98% |
| Endpoint | 17.73% | 14.41% | 20.70% |
| receiver GPU | 13.18% | 11.54% | 11.33% |
| 物理VideoDecode总busy | 16.18% | 17.04% | 20.09% |
| 物理VideoProcessing总busy | 7.36% | 7.06% | 8.80% |

VideoDecode分别由Endpoint 9.68/11.30/13.01%、receiver 6.51/5.74/7.07%组成；VideoProcessing非零实例均属于Endpoint。独立VideoEncode标签没有非零采样，驱动标签不能直接当作API职责。

| 编码/队列观测 | 单60 | 四60 | 四30 |
|---|---:|---:|---:|
| 实际wire video Mbps | 3.51 | 1.44–1.83 | 1.15–1.36 |
| 采样的appliedBitrate均值 Mbps | 20.51 | 21.13–21.70 | 20.68–21.67 |
| 采样lastEncodeMs p50 | 8.58ms | 18.22–25.10ms | 13.92–34.89ms |
| 采样lastEncodeMs p95 | 10.61ms | 72.20–85.79ms | 63.70–88.62ms |
| 采样lastGpuCopyMs p95 | 7.92ms | 85.11–126.67ms | 63.93–89.70ms |
| 采样captureToReadyMs p95 | 20.56ms | 103.67–129.68ms | 75.90–110.52ms |
| encodeDropped，30秒增量/Peer | 0 | 104–109 | 394–417 |
| 尾IDR，30秒增量/Peer | 0 | 13–26 | 2–5 |

appliedFps始终60，LowPower实际OFF(32)。lastEncode/copy/captureToReady是每秒最新值采样的分布，不是全帧耗时分布。Worker现有队列采用至多一个pending、后到替换前一个，drop表说明背压持续；本轮未开启逐帧worker trace，不能测得独立worker queue等待分位数。四60下编码和copy耗时拉长，尾IDR重新较频繁；需与源帧间隙及重负载GPU等待一起分析，不能把所有低吞吐都归到QSV硬件。

## 证据与清理

原始case为develop/tmp/throughput-next-{1x1080-render60,4x1080-render60,4x1080-render30}-playout0，分别含完整metrics、原始presentation chunks、source轨迹、Endpoint snapshots、GPU/CPU samples、配置和指纹。汇总为develop/tmp/throughput-next-result/feedback.json，逐Peer wire bitrate和整形统计在matrix-layer-check.json。Windows显示探针在四30 case，父进程归属在result目录。

四60采样完成后保存receiver.png；Sol目视确认正常连接、1920×1080 DIP、marker和诊断动画实际可见，未出现黑帧或错误页。截图发生在正式计数窗口后。

所有自建Chrome89/context、RTC连接、Control/source/resource进程均已清理。核查没有Chrome89、RemoteKit或ninja存活，3001仅余TIME_WAIT，无监听；三个宿主cua node server.mjs未动。
