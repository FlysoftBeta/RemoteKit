# 串流实验与测量口径

日期：2026-11-01。目标客户端为现有 Chrome 89.0.4389.90 Desktop，编码设备为 Intel UHD Graphics 630，驱动30.0.100.9805。oneVPL dispatcher v2.17.0 实际连接 legacy API1.35。Endpoint 正式测量使用 MSVC Release；Chromium 复用 out/dev（is_debug=false、component build、dcheck_always_on=true）。

## 判定方法

每组暖机3–5秒，采集至少20秒有效动态内容。记录分辨率、源atlas尺寸、编码采样比例、网页DPR、可见平面数、租户数、编码参数和网络条件。延迟报告p50/p95/p99及样本数，FPS报告平均及每秒分布；优先以p95<100ms、平均动态显示FPS>50评估目标。静态页面不以低FPS判定失败。

Pixel marker 从实际接收视频像素识别，包含源帧号、时间、输入刺激号和CRC。输入到画面响应使用同一客户端performance.now；本机loopback可显式开启Date.now画面时间比较，跨机器不直接相减。采集到Endpoint就绪使用经一致性检查的Chromium TimeTicks/QPC校准，编码提交/完成使用QPC。RTP时间戳采用WebRTC实际发送值，客户端rVFC回调匹配显示代次后才显示/命中输入。

## 网络模拟

使用只绑定loopback的双UDP socket整形器，两端SDP候选指向整形器；确认selected candidate与实际转发字节，失败不回退直连。每方向基础延迟5ms，下行24或48Mbps；按UDP/IP28字节开销计量。无额外随机丢包，过载时按有界队列丢包。它模拟链路延迟和容量，不代表实地无线干扰或重传。

启用`REMOTEKIT_NETWORK_SIM`时，Control只向Endpoint子进程注入`REMOTEKIT_RTC_LOOPBACK_TEST=1`，通过官方factory网络过滤选项允许真实127候选。原生UDP socket绑定具体网卡，不能把该网卡候选改写成127；模拟器要求Endpoint实际提供127候选。正常LAN串流不启用此实验选项。

| 设施验证 | 结果 |
|---|---|
| 目标RTT10ms | p50 10.2253ms、p95 10.4093ms、p99 11.7152ms |
| 24Mbps整形 | 实收24.0010Mbps |
| 48Mbps整形 | 实收48.0030Mbps |
| 饱和整形CPU成本 | 约0.94–0.97个Node CPU核心 |
| Chrome89真实双Peer | selected candidate均经过代理，视频/DataChannel与转发字节对应 |

正式性能结果还需计入同机多接收端和整形器的资源成本。四租户代表四个独立会话/接收端，每客户端的带宽预算分别记录，不能与四流共享同一总带宽混淆。

## H.264 接收档

Chrome89的默认SDP level来自固定640×480/30fps配置探测，并非硬件最大吞吐查询，见[官方decoder factory](https://chromium.googlesource.com/chromium/src/+/89.0.4389.90/third_party/blink/renderer/platform/peerconnection/rtc_video_decoder_factory.cc#29)。但本地answer较高level也不能单独证明远端能力。

Control保留原生offer档和明确的Chrome89接收档，保存original/effective SDP。4.2档在本机MediaCapabilities file探测中supported/smooth/powerEfficient均为true，真实1928×1088码流已解码，SPS为42402a；WebRTC类型的MediaCapabilities在89中抛TypeError，未用预测结果替代吞吐测量。SDK按远端实际声明约束编码level，拒绝驱动超限结果。5.1档已实际解码1656×2376平板输出；超限时保留网页设备特征并缩小视频采样。

## 已执行的编码与功能检查

- UHD630真实D3D11 BGRA→NV12→oneVPL异步H.264：720p120帧，depth1约700ms、depth4约485ms。这是编码吞吐。
- Release1928×1088、level4.2/depth4：240帧连续2→18→0.5→18Mbps及60→22→29→60fps阶跃，约1559.64ms持续完成。驱动低档实际接受1.047Mbps，报告实际值。
- 1/4租户管理、幂等页面创建、后台页不占atlas、关闭与平板输出重建通过。
- 实际H.264视频marker和DataChannel输入响应通过，RTP/显示代次匹配通过；在途RTC关闭约52ms完成。
- NVENC已编译；本机无NVIDIA GPU和驱动编码DLL，不能提供该硬件性能结果。
- VPP与编码VUI统一为BT.709 limited；真实QSV码率阶跃中的四份SPS均确认fullRange=false、colourDescriptionPresent=true、primaries/transfer/matrix=1。

## 端到端结果

正式20秒矩阵尚在进行。短功能片段的帧率不作为达标结论，最终结果将在本节按真实编码尺寸和实验配置列出。

初步20秒无网络整形基准中，源/编码/解码约53 FPS，客户端rVFC与授权帧约32 FPS。关闭marker读回、提前注册rVFC均未改变这一节拍；帧代次匹配633/633，无等待或缺失。运行会话为已断开的RDP会话，DWM声明60Hz，正在做客户端垂直同步对照。

这批诊断的marker时间终点是帧授权，尚未覆盖随后可见canvas的绘制等待。后续正式基准改用选中平面的实际paint时刻，并分开报告解码、rVFC、canvas绘制FPS和marker采样率；旧数据保留用于定位，不混入最终端到端结果。
