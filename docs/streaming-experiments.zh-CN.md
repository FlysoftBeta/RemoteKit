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

**本轮仍未达到实际呈现平均FPS>50且render→paint p95<100ms。** 已完成16组网络矩阵、输入/画质对照及GPU瓶颈定位，并修复宿主DPI造成的额外绘制。QSV默认保持异步深度1、TargetUsage 1、VBR、VBV1000ms、LowPower auto；保留WebRTC拥塞控制与参数覆盖。NVENC维持原参数。

### 当前版本：修复宿主DPI后的结果

网页报告DPR1并不保证原生绘制也为1：本机150%缩放曾使1920×1080页面实际提交2880×1620，再缩回1080p。服务现在用官方每WebView capture scale override，让实际backing跟随页面DPR。宿主缩放设置和native demo不变；混合desktop1/tablet2的真实提交尺寸、触控和中文输入均已验证。

以下均为每peer 24Mbps、每向5ms，暖机5秒、有效20秒，默认QSV参数。marker0用于分层吞吐；1Hz用于延迟，二者分列。

| 场景 | 客户端 / marker | source FPS | encode FPS | paint FPS | render→paint p50 / p95 / p99 ms |
|---|---|---:|---:|---:|---|
| 720p×1 | 默认 / 1Hz | 53.2 | 约53 | 31.74 | 106 / 111 / 113 |
| 1080p×1 | 默认 / 0 | 52.9 | 52.8 | 31.8 | 未采样 |
| 720p×4 | 默认 / 0 | 46.4–46.9 | 20.5–22.1 | 11.7–12.3 | 未采样 |
| 1080p×4 | 默认 / 0 | 20.0–20.4 | 11.9–12.6 | 9.2–9.3 | 未采样 |
| 1080p×4 | 默认 / 1Hz | 20.2–20.5 | 约12 | 8.5–8.7 | p95 1004–1096 |
| 720p×1 | disable-frame-rate-limit / 1Hz | 53.1 | 约53 | 53.03 | 99 / 103 / 104 |
| 1080p×1 | disable-frame-rate-limit / 1Hz | 52.8 | 约53 | 52.70 | 103 / 105 / 109 |

特殊flag仅用于独立Chrome89诊断profile，计数来自真实wire RTP对应的canvas绘制。它解除当前环境约32Hz的呈现限制，但增加CPU消耗，四租户未获益；没有作为产品默认。单租户各20个有效marker，四租户各19个；当前是同机、已断开的RDP会话，不是四台物理客户端的测量。

四1080的同条件marker0对照中，源FPS约8→20，paint约6.5–6.9→9.2–9.3。GPU 3D引擎仍约99%忙，新的损失发生在copy→encode及接收呈现。逐进程采样器约占0.05–0.12核，已计入结果；没有把GPU busy直接解释为硬件固有吞吐上限。

修复后d4/TU7四1080编码升至15.8–16.1 FPS，paint仍8.7–9.2；显式LowPower ON也未明显改善最终呈现，因此不改默认。本机auto的Query/初始化实际值均为OFF(32)，显式ON为16，已确认发生模式切换。`--qsv-low-power=auto|on|off`可复算，stats记录请求、Query和初始化实际值及返回状态，显式值不支持时明确失败。ON的240帧码率阶跃、BT709 limited和HRD关闭检查通过。

同静态帧/ROI的PSNR从23.50提升至25.87dB，MAE从8.48降至7.86；文字轮廓改善，细线仍有损失。完整过程和逐进程证据见[GPU吞吐定位](../develop/docs/gpu-throughput-probe.md)。

### 修复前的参数矩阵

矩阵每组暖机5秒、有效20秒；每租户一个可见WebView和独立接收页面，DPR1，H.264 level4.2。四租户带宽分别为每个接收端24或48Mbps，总预算96/192Mbps。没有为取得FPS而缩小本表视频。Chrome89的playoutDelayHint实际设置并读回0；抖动缓冲统计字段缺测。

Q为深度1/TU1/VBR，T为深度4/TU7/VBR，均名义60fps、VBV1000ms。范围覆盖各租户；每秒分布汇合租户秒样本。延迟取相同RTP的可见canvas绘制时刻，marker以5Hz采样。
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
### 原矩阵的分层与观测成本

| 条件 | 源/采集 | 编码/解码 | 实际呈现 |
|---|---:|---:|---:|
| 720p，1租户 | 约53 FPS | 约53 FPS | 约31 FPS |
| 720p，4租户 | 每租户约18 FPS | 16–18 FPS | 6–8 FPS |
| 1080p，1租户 | 约31 FPS | 约31 FPS | 23–25 FPS |
| 1080p，4租户 | 每租户约8 FPS | 约10 FPS，包含重复尾帧 | 约4 FPS |

原矩阵在已断开的Windows RDP会话运行，四个接收端与服务器共享同一主机/GPU。页面均报告visible；全机CPU p95最高约81%，当时尚未采集GPU引擎与逐进程CPU。客户端单租户RAF/rVFC约32Hz，关闭marker、改变回调注册顺序、disable-gpu-vsync、挂载可见video和进程计时策略均未解除这一节拍。后续的尺寸修复和flag对照见上节。

四租户1080的同步marker读回每次p50约169–188ms。关闭采样后呈现升至8.0–8.3 FPS，但源仍7.2–7.7 FPS；1Hz采样时呈现6.6–7.5 FPS、render p95为1051–1094ms。读回增加呈现损失，不能解释源端约8 FPS。独立CSS合成滚动场景的四租户源也约8 FPS。

原矩阵各组PLI、接收丢包增量及relay丢包均为0，实发视频码率低于链路预算。修复后的个别高负载组出现接收丢包，不能把旧矩阵的零丢包结论套用到全部新实验。

### 已落实的编码修正

- 关键帧请求无条件取出后合并，修复一次请求造成连续两帧IDR的问题。
- QSV名义fps保持配置值；码率更新使用StartNewSequence=OFF，并关闭阻止动态更新的NAL/VUI HRD声明。240帧升降码率持续完成，无重新初始化。单租户1080的20秒关键帧由53次降为5次，p95由231ms降为215ms。
- 固定名义60fps而源约30fps时，CBR实际输出约为请求的一半；报告分别记录请求值、驱动参数和实际字节。
- 固定150ms尾IDR在约8fps的动态间隙反复触发。现改为至少150ms、至少3倍平滑源帧间隔、最多1秒，仅真正新源帧更新估计。正常静态检查仍在150.9553ms补一帧；低fps时避免重复尾帧风暴。

自适应版本另做1080p四租户、每peer24Mbps、1Hz marker验证：有效阈值263–480ms，每租户20秒关键帧1–2次，encoder错误/PLI/丢包均无；呈现5.8–6.1 FPS、render p95为804–1010ms，各18–19个有效marker。上面的16组表仍保留固定150ms版本，用于参数比较，不替换成这个新版本的数据。

### 画质与输入

同1080p、深度1/TU1、24Mbps链路下，使用各次运行内匹配marker帧号和时间戳的源图/解码图，比较文字与1px细线区域：

| 场景 | CBR：RGB PSNR / MAE | VBR：RGB PSNR / MAE |
|---|---:|---:|
| 静态首屏最终帧 | 23.46dB / 8.81 | 23.50dB / 8.48 |
| 大变化后停止最终帧 | 28.06dB / 4.12 | 27.91dB / 4.24 |

Sol视觉检查确认：首屏两种模式均有文字软化和细线损失；停止后的文字较清楚，VBR未出现额外明显退化。VBR筛选实发约2.5–4.1Mbps，CBR约16–18Mbps，支持选择VBR。两种模式是独立运行，以上不是全运动序列的等价质量证明。

720p单租户、VBR/TU1/d1、24Mbps：19次IME输入全部匹配，无超时；input→paint p50/p95/p99为**127.44/176.38/176.38ms**。152个marker的render→paint为105/117/121ms，呈现31.04 FPS。等待输入响应期间逐帧识别marker，包含同步读回的观测负担。

首屏预算仍需后续验证：服务请求18Mbps且SetBitrate成功，但初始编码配置出现2Mbps；尚未实验证明网络连接后的分配时序。未绕过拥塞控制硬改初始编码码率。

### 复算与证据

`tools/summarize-streaming-matrix.py`从各case原始metrics、summary和日志生成40行分层表；`tools/analyze-streaming-cadence.py`复算节拍；`tools/compare-streaming-quality.ps1`核对同marker后计算画质。工具不依赖develop中的既有分析文件。

完整过程与原始case索引见[参数实验报告](../develop/docs/streaming-parameter-results.md)，分层表见[矩阵汇总](../develop/docs/matrix-layer-check.md)。720p旧fixture有浮层遮挡marker，最终表已采用修正后重跑的全部8组，各租户72–92个有效样本；旧无效延迟未混入结果。
