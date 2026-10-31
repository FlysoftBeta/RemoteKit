# 本机 UDP 网络实验设施

2026-11-01。默认关闭，不改系统接口或安装驱动。Control 的 `REMOTEKIT_NETWORK_SIM` 接受 JSON：`{"oneWayDelayMs":5,"downlinkMbps":24,"uplinkMbps":1000,"maxQueueBytes":300000,"maxQueueDelayMs":100}`。48Mbps实验修改downlinkMbps。正式使用说明见control/README.md。

## 通路与范围

每个 PeerConnection 创建只绑定127.0.0.1的两个UDP socket。给Endpoint的客户端offer改为serverRelay，给Chrome的answer改为clientRelay。客户端→clientRelay的数据必须从serverRelay发给Endpoint；反向必须从clientRelay发给客户端，保证ICE/DTLS/RTP/RTCP/DataChannel走同一有界调度器。浏览器候选先校验原地址属于本机，再将已选wildcard socket端口的目标固定为127.0.0.1。Native Endpoint必须实际公布127.0.0.1候选，不能将绑定LAN接口的端口直接改写成loopback。Control在启用模拟时自动只给Endpoint子进程注入REMOTEKIT_RTC_LOOPBACK_TEST=1；正常模式不追加该诊断设置，Node父环境不变。Chrome89 raw host可能公布本机虚拟接口198.18.0.1，但loopback路由实际源为127.0.0.1同端口；已通过真实运行验证。

只支持IPv4/UDP/host、BUNDLE和完整gathered SDP，删除TCP/其他直连候选及trickle入口。ICE失败时保持失败，不回退未整形通路。Chrome测试实例显式关闭mDNS；普通产品启动不加该flag。发送端/接收端必须是本机自建测试实例。relay拒绝不匹配已登记端口/loopback来源的数据包；进程和连接结束关闭socket。

每方向延迟为5ms，Mbps按UDP负载+28字节IPv4/UDP头计算，虚拟链路发送完成deadline随后加基础delay。队列最多300000bytes、4096packets、100ms序列化积压，超过丢包；记录原始接收/转发/丢弃、队列峰值和scheduler lateness。Windows Node setTimeout最初实测把5ms延迟放大到系统tick，造成RTT p50约31.8ms；改为队列非空时setImmediate对单调deadline轮询。无流量不忙轮询，饱和流成本约一个Node核心；报告包含整个Node进程CPU，不能把共享进程CPU重复算成每连接独占。

## 实测证据

`node tools/streaming-experiment-echo.mjs` 实际发送loopback UDP包，记录于develop/tmp/network-sim-echo.json（原始RTT样本、端口与完整计数）。最新结果：

| 项目 | 观测 |
|---|---|
| 10ms目标RTT | p50 10.2253 / p95 10.4093 / p99 11.7152ms |
| 24Mbps，提供48Mbps负载 | 实收wire 24.0010Mbps，drop7459，队列峰值300000bytes |
| 48Mbps，提供96Mbps负载 | 实收wire 48.0030Mbps，drop15115，队列峰值300000bytes |
| 源socket异常 | 0 |
| 饱和Node平均CPU | 24Mbps约0.967核，48Mbps约0.936核 |

Chrome89.0.4389.90 headed双Peer真实WebRTC验证使用独立临时profile，工具tools/streaming-experiment-webrtc.mjs，独立3012端口，记录develop/tmp/network-sim-webrtc.json。客户端selected remote为127.0.0.1:59296，第二个Chrome发送端peer selected remote为127.0.0.1:59297，分别匹配relay的client/server socket。实际视频640×360，66帧解码，30fps；relay下行148285bytes，对应client pair147677bytes、video123032bytes；上行6124bytes，sendErrors=0。DataChannel20次echo大多数10.5–11.0ms，首包21.75ms。该低码率VP8通路实验Node约0.276核。3个启动时ICE请求在answer目标登记前被拒绝，后续ICE重试成功。

真实Native Endpoint H264通路也已验证，case为develop/tmp/select-1080-d1-tu4-cbr-48-loopback。原始answer含真正127.0.0.1:59863候选，SDK selected remote host127.0.0.1:59856与serverRelay一致，Chrome selected remote127.0.0.1:59855与clientRelay一致。SDK selected local prflx127.0.0.1:59855是STUN观测到的代理外侧映射，并非底层绑定端口。下行实际转发103217418bytes、上行142423bytes，双方向sendErrors=0、socketErrors=0；sender真实availableOutgoingBitrate为40Mbps。完整候选、计数和真实接收视频样本在该case的metrics中。

Native最初逐接口bound socket向loopback发STUN时Windows返回10049。SDK诊断ENV启用官方factory.Options.network_ignore_mask=0后提供真实loopback候选；普通模式沿用原设置。新增仅保留127候选的真实ICE/DataChannel/Stats/close SDK smoke通过，随后上述实际编码视频通路成功。Node仍只绑定127，没有改成LAN代理或直连回退。

以上证明实际网络通路。编码性能矩阵另行记录；不得用JS动画或CDP Network.emulateNetworkConditions代替WebRTC网络整形。

## 检查

`npm run build`通过；`npm test`25项通过，新增sim opt-in/SDP候选清理、本地真实双向UDP源socket与有界队列/drop测试。正常未设置REMOTEKIT_NETWORK_SIM时不创建relay、不重写SDP。
