# 串流实验与测量口径

日期：2026-11-01。目标客户端为现有 Chrome 89.0.4389.90 Desktop，编码设备为 Intel UHD Graphics 630，驱动30.0.100.9805。oneVPL dispatcher v2.17.0 实际连接 legacy API1.35。Endpoint 正式测量使用 MSVC Release；Chromium 复用 out/dev（is_debug=false、component build、dcheck_always_on=true）。

## 判定方法

每组暖机3–5秒，采集至少20秒有效动态内容。记录分辨率、源atlas尺寸、编码采样比例、网页DPR、可见平面数、租户数、编码参数和网络条件。延迟报告p50/p95/p99及样本数，FPS报告平均及每秒分布；优先以p95<100ms、平均动态显示FPS>50评估目标。静态页面不以低FPS判定失败。

Pixel marker 从实际接收视频像素识别，包含源帧号、时间、输入刺激号和CRC。输入到画面响应使用同一客户端performance.now；本机loopback可显式开启Date.now画面时间比较，跨机器不直接相减。采集到Endpoint就绪使用经一致性检查的Chromium TimeTicks/QPC校准，编码提交/完成使用QPC。RTP时间戳采用WebRTC实际发送值，客户端rVFC回调匹配显示代次后才显示/命中输入。

本文的paint是Viewport调用drawImage返回后的JS时间，FPS按独立RTP的绘制提交计数，不是GPU完成或物理屏幕刷新。marker读取匹配RTP的授权plane source及其明确sourceRect，并记录读回完成时间与成本；它也不等同于Viewport的物理显示完成。Chrome89的rVFC元数据读取与drawImage(video)不是原子取得同一个frame handle；多平面的共同快照保证后续平面使用相同像素，不宣称像素与RTP已获得原子绑定。

## 捕获与呈现分段定位

Fence保证GPU读写顺序，不能消除排队。Chromium官方capture begin在预留帧缓冲之前，end在收到CopyOutput完成结果后、按序交付之前。Windows mappable ARGB路径等待GPU finished callback。因此begin→end包含请求排队、GPU工作和完成观察，不能直接称为GPU执行时间。共享帧的`capture_time_us`取自capture **end**；HUD“捕获完成→纹理就绪”不含捕获本身。

新增`REMOTEKIT_SERVER_TRACE=<目录>`，默认关闭，以有界记录关联source generation/frame、私有cache cookie、encoder/input RTP和实际wire RTP；关闭peer后写文件，不增加browser↔endpoint逐帧IPC。`tools/analyze-streaming-server-trace.py CASE...`输出分段分布、同RTP marker关联和缺失项。QPC/TimeTicks/壁钟映射与客户端timeOrigin夹测共同记录；各阶段p95不能相加。

四1080、每peer24Mbps/10ms RTT、d1/TU1/VBR、默认客户端flag的同版本ready gate对照：

| 阶段或结果 | Gate关闭 | Gate开启 |
|---|---:|---:|
| VPP真实fence等待p50 | 41–46ms | 4.7–7.4ms |
| 捕获完成→encoded返回p50 | 125–141ms | 61–98ms |
| 解码FPS | 11.5–12.1 | 13.7–14.4 |
| Canvas提交FPS | 6.4–7.0 | 6.35–6.90 |
| Marker render→canvas提交p95 | 906–1223ms | 1133–1218ms |

原因已确认：同Session的D3D immediate context提前排入新帧的ready Wait，会阻挡旧帧VPP。`REMOTEKIT_ATLAS_READY_GATE=1`先观察ready完成，再执行原Wait/copy/consumed顺序，减少该等待，但接收端等待增长，端到端没有稳定收益，默认保持关闭。

客户端新增可选`single-plane-direct`呈现方式：唯一可见平面与注册renderer的epoch/geometry匹配，且该epoch已有首次快照绘制后，同次rVFC直接绘制video到plane canvas；多平面和过渡期使用snapshot。默认仍为snapshot。同一31–32源render/s的单720对照，canvas提交22→30.5FPS，marker p95 405→156ms；四1080没有一致收益。不能与较早53源FPS组混用。marker/画质工具已修正缩采样ROI重复乘DPR的问题；desktop1/scale1旧结果不受影响。

Chromium补丁提供默认关闭的`RemoteKitBoundedCapture:max_pending/1`或`/2`，限制预留至按序交付的请求数，保留damage并合并refresh，不改变lease/fence回收。早期marker关闭组，cap1把capture p50约159–163ms降至87–101ms，但canvas仍约8–9FPS；后续组cap1/2的真实capture约1.6/3.2FPS，renderer的42–48次render/s不能当作采集FPS。上限没有稳定整体收益，默认不启用。最后变化按源实际写入marker与接收CRC匹配，Stop/reopen检查通过。

`tools/watch-streaming-resources.ps1 -Name CASE`使用PDH按进程和物理引擎采样；CASE必须是已准备的实验目录。四租户高负载组物理3D引擎约99% busy，但busy含调度/等待，不证明纯shader执行或硬件延迟下限。Intel驱动的VideoDecode名称也不能直接推断工作是接收端解码。缺少覆盖采样区间的资源记录时明确标缺失，不填0。

完整同帧证据与case索引见[服务器分段报告](../develop/docs/server-frame-age-probe.md)和[捕获上限实验](../develop/docs/bounded-capture-probe.md)。当前各对照均未达到动态FPS>50且marker p95<100ms。

官方细粒度trace已关联一次308.388ms慢捕获：CopyOutputRequest存续304.223ms，SendResult至capture end为3.156ms，再至browser回调0.777ms。现有GPU-thread CopyOutput事件未携带request id，renderer GPU timers不能当作该copy的执行时间。同一稳态窗口205次完成检查任务按toplevel.flow关联，requested delay为2ms，实际post→run p50 47.092ms、p95 61.074ms，任务CPU体p50约0.022ms。该调度滞后已测到，但对具体捕获延迟的贡献仍需GPU完成时间才能量化。原生trace有约5–10%的吞吐影响，且仅Session3/4覆盖部分正式采样窗口；详见[官方捕获profile](../develop/docs/official-capture-profile.md)。下一步以同一request补齐提交/完成打点，并用独立ETW诊断区分GPU队列与CPU调度。

独立GPUView ETW采集已完成，稳定串流记录12.75秒，零丢失事件/缓冲。已解析的250ms片段按context→device→payload PID归属，并按context+submitSequence配对完整DMA包：四个源GPU进程的具体包提交等待125–225ms，DMA Start→Stop跨度约3–4ms；这证明该诊断片段确有长GPU提交等待。DMA跨度不是纯copy执行，完整包筛选会排除跨窗口长包，不能外推为全窗分布。源GPU进程385个显式CPU Ready→Run配对最长0.439ms，未显示这些观测线程发生CPU运行机会饥饿；缺失线程名，未定向识别GpuMain。工具为`tools/streaming-etw.ps1`，命令、时钟锚、覆盖范围和原始证据见[ETW报告](../develop/docs/etw-gpuqueue-profile.md)。

请求级profile补丁已把同一CopyOutput的dispatch、flush、Skia submitted/finished、mailbox和SendResult连通，并取得Ganesh/OpenGL实际GPU flush批次elapsed。重启后独立4×1080诊断中，S4稳态142个完整请求的Created→SendResult p50/p95为215.977/283.458ms，submitted→finished为203.317/272.052ms，GPU batch elapsed为0.813/1.050ms。同boot单720的241个完整请求为9.677/14.723ms，batch elapsed为0.657/0.690ms。各阶段分位不可相加；elapsed不是映射到CPU时钟的硬件完成时刻，不能把余量全部算作通知延迟。

四租户慢帧229的finished落在CommandBufferStub::PerformWork任务内，该任务请求约2ms，精确flow post→run为139.454ms。S4仅1/142个finished落在surface CheckAsyncWorkCompletion，故撤回直接调整surface 2ms poll的假设。CopyOutput局部显式submit均Skipped，但成功Skia submitted约在flush return后1ms出现，也没有据此强制submit。重启前后数据、startup/稳态窗口和GPU elapsed含义详见[请求级profile报告](../develop/docs/copy-output-profile.md)。

继续展开该CrGpuMain任务：到期后137.464ms的滞后中，137.361ms被前一RunTask覆盖，其中DXGISwapChainImageBacking::Present占131.914ms、CPU时间仅0.465ms。同线程的高优先级完成检查无法抢占正在阻塞的Present，所以没有提升poll优先级或缩短其间隔。其他Session也出现84–148ms的Present。详见[完成观察阻塞调查](../develop/docs/completion-observer-investigation.md)。

### 源端窗口与负载对照

各行是独立的同binary配对实验：四1080、每peer24Mbps/RTT10ms、Chrome89默认snapshot、1Hz marker、profile关闭、5秒暖机加20秒有效窗口。范围覆盖四租户；各行基线不能互换。

| source候选 | 配对基线：canvas FPS / marker p95 ms | 候选：canvas FPS / marker p95 ms | 结论 |
|---|---|---|---|
| 关闭DirectComposition | 8.29–9.74 / 992–1082 | 8.15–8.89 / 864–1009 | 等待转移至NativeViewGLSurfaceEGL::PostSubBuffer，未改善最终吞吐 |
| 官方offscreen root | 7.64–8.50 / 1085–1195 | 6.30–6.70 / 1633–1952 | 去掉Present后源render约20升至40–42，GPU积压与最终结果恶化 |
| host scale强制1（已修正窗口边框） | 8.29–8.69 / 989–1127 | 6.74–7.54 / 987–1027 | 源render/capture提高，编码/呈现下降，3D仍约99% |

三项均保留为显式实验选项，默认不启用：服务参数`--browser-direct-composition=off`、`--browser-host-scale=1`，以及Feature `RemoteKitOffscreenRoot`。只作用于source browser，不改变Chrome89 receiver。分项报告见[source DirectComposition](../develop/docs/source-direct-composition.md)、[offscreen root](../develop/docs/source-offscreen-root.md)及[host scale](../develop/docs/source-host-scale.md)。

有效host-auto基线的20个资源样本中，同一物理3D engine平均busy99.206%，按PID归属source GPU52.301%、source browser13.319%、Endpoint19.895%、receiver GPU13.689%。计数按完整LUID/physical adapter/engine分组跨PID求和，不混合engine、不截断到100%。VideoDecode21.480%中Endpoint占14.181%、receiver占7.297%；VideoProcessing9.380%全部来自Endpoint，没有独立VideoEncode实例。Windows驱动engine标签不等于API职责；busy也不能直接解释为shader算术饱和。

已修复source宿主窗口的边框尺寸差额：服务窗口使用无边框客户区，atlas1928×1088不再被窗口外框尺寸挤小；原生demo保持原行为。此前WebView实际提交仍完整，该问题是本地root裁剪。真实renderer metadata、桌面/平板四角像素、右下mouse/touch、IME和reload验证通过；host scale有效对照使用修复后的同一binary，未混入旧裁剪样本。

### 无页面HWND宿主

服务已切换为每WebView独立的无原生窗口Aura宿主，从创建时使用null widget和external BeginFrame；不依赖旧offscreen-root/capture-rate实验补丁。每host使用独立BeginFrame source ID，避免多页任务混入同一ACK跟踪。真实多页、混合DPR、OOPIF中文输入及source GPU进程故障恢复通过，官方trace不再出现窗口Present。进程中的SingletonHwnd已通过对象身份核查为系统广播辅助窗。

以下配对均为1080p、24Mbps/RTT10ms、默认snapshot、1Hz marker、profile关闭、5秒暖机加20秒稳态；每对使用相同binary和Client bundle。

| 租户 | 旧窗口canvas FPS / marker p95 ms | 新离屏60fps驱动canvas FPS / marker p95 ms |
|---|---|---|
| 1 | 31.6 / 186 | 29.3 / 155 |
| 4 | 7.0–7.8 / 976–1196 | 5.9–6.3 / 1377–1435 |

四租户source由18.0–18.6升至32.6–34.3FPS，但编码仍约11FPS，3D busy99.2→99.8%。这组采用相对计时器的初版pacer，配置60并未实际达到60。新增`--browser-render-fps=0..60`独立控制本地pacer（0沿用输出配置），capture/atlas/QSV名义fps不随之改变。具体运行与输入证据见[离屏宿主报告](../develop/docs/source-aura-osr.md)。

### 本地pacer定时修复与预算

初版RepeatingTimer允许Windows延迟合并且每次按实际唤醒时刻重排，配置60/30/20的实际tick约34/22.5/16Hz。现改为官方DeadlineTimer绝对相位，跳过过期槽；远期deadline先预唤醒，再在官方max precise delay阈值内精确定时。预唤醒不发帧，ACK只消费已有tick，未修改全机timer。轻量640×360的实际提交/ACK已验证为59.98/30.02/19.98Hz，RAF也与60/30/20吻合。

精确定时后的四1080，同binary/bundle、snapshot、1Hz marker、24Mbps/10ms、5+20秒：

| 实际source预算 | encode FPS | canvas FPS | marker p95 ms | GPU3D均值 |
|---|---:|---:|---:|---:|
| 16 | 15.9–16.1 | 14.44–15.40 | 311–379 | 96.12% |
| 20 | 17.5–18.1 | 10.30–10.94 | 736–800 | 99.60% |

20档又进入满载，16档最终输出更好；两档都未达到目标。默认render-fps仍为0，没有将固定低上限推广为默认。静态点击/IME与关闭后重新订阅通过。详细计时、GPU角色和帧率口径见[精准pacer报告](../develop/docs/source-render-deadline.md)。

### 新离屏路径的播放延迟复核

精准render16、四1080、snapshot、marker1Hz、每peer24Mbps/RTT10ms、无特殊客户端flag、全部profile关闭。保持browser、Endpoint与Client不变，使用已有`--rtc-playout-max-ms=0`请求RTP min/max=0/0。首组20秒有收益后，再按unset→0/0各采样40秒，前后形成0→unset→0交错复核。

| Peer | unset canvas FPS | 0/0 canvas FPS | unset marker p95 | 0/0 marker p95 |
|---|---:|---:|---:|---:|
| 0 | 15.27 | 15.95 | 169ms | 143ms |
| 1 | 15.07 | 15.97 | 233ms | 92ms |
| 2 | 15.64 | 15.95 | 180ms | 136ms |
| 3 | 15.17 | 15.97 | 172ms | 90ms |

native收包→video呈现p95从97–114ms降至2.69–3.79ms，loss/PLI/NACK均0。GPU3D均值79.28→78.23%；首组96→78%的大降幅未重复，不作为稳定收益。延迟收益重复，FPS仍受16上限，未达到>50FPS/<100ms目标。保持默认配置，重载测试可显式运行`run.cmd --browser-render-fps=16 --rtc-playout-max-ms=0`。

40秒大报告发现Control并发appendFile写块交错；原始字节保留，独立恢复文件已核验完整JSON及Peer/Session/SSRC、RTP连续性。随后修复完整记录串行写入，新增四Tenant大报告回归；未改变Client媒体路径。详细证据见[播放延迟报告](../develop/docs/source-playout-delay.md)，请求级分段见[新路径profile](../develop/docs/osr-render16-segment-profile.md)。

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

四1080/1Hz的76个同RTP marker中，render→paint-submit平均932ms；render→最后视频包接收约661ms，接收→paint约271ms（其中解码约34ms、video presentationTime→JS提交约10ms）。同步marker读回另加平均168ms、p95 283ms，未计入paint延迟。现有逐环节统计缺少每RTP的server capture/VPP/编码时间关联，不能把661ms具体分配给某个服务器队列。

修复后d4/TU7四1080编码升至15.8–16.1 FPS，paint仍8.7–9.2；显式LowPower ON也未明显改善最终呈现，因此不改默认。本机auto的Query/初始化实际值均为OFF(32)，显式ON为16，已确认发生模式切换。`--qsv-low-power=auto|on|off`可复算，stats记录请求、Query和初始化实际值及返回状态，显式值不支持时明确失败。ON的240帧码率阶跃、BT709 limited和HRD关闭检查通过。

同静态帧/ROI的PSNR从23.50提升至25.87dB，MAE从8.48降至7.86；文字轮廓改善，细线仍有损失。完整过程和逐进程证据见[GPU吞吐定位](../develop/docs/gpu-throughput-probe.md)。

### RTP播放延迟上限对照

`playoutDelayHint=0`只设置接收缓冲下限。新增`--rtc-playout-max-ms=N`通过已协商的RTP扩展请求min=0/max=N，默认-1不设置；数值为0–40950内的10ms整数倍。720p单租户使用同一特殊客户端flag、1Hz marker，各20个有效样本：

| RTP请求 | 绘制提交FPS | render→提交p95 | 同RTP接收→提交均值 |
|---|---:|---:|---:|
| 未设置（默认） | 53.03 | 103ms | 37.85ms |
| 0/0ms | 46.13 | 82ms | 9.74ms |
| 0/10ms | 45.43 | 92ms | 11.33ms |

接收等待减少，但JS/canvas消费节拍下降；不能把不同组的53 FPS和82ms合成一个结果。四1080的max0也降低了部分延迟，却使绘制提交由8.5–8.7降至7.2–7.5 FPS。因此默认保持未设置，保留显式选项。分段、丢包和读回成本见[播放延迟对照](../develop/docs/playout-delay-probe.md)。

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
