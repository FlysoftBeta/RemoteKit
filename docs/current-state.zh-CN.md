# RemoteKit 当前实现

基线：官方 Chromium Release **157.0.8103.15**（`1aa07b638799e59656559ae6c6649d4b197f555e`），Windows x64。源码在本仓库；`tools/chromium.py` 把 browser、共享模型和 SDK shim 放入 Chromium 的 `//remotekit`。

服务端已采用每WebView独立无页面HWND的Aura宿主、null widget compositor和本地external BeginFrame，原生demo保留窗口。统一构建、Chrome89真实H.264/输入、桌面和平板四角、混合DPR、跨进程iframe中文输入及真实source GPU故障恢复已通过。重载低延迟实验约16FPS、marker p95为90–143ms，吞吐目标仍未达到。源进程仍有Chromium系统广播用SingletonHwnd，已确认它不是页面呈现窗口。

当前按用户指令持续推进≥50FPS/Pixel marker p95≤100ms目标，阶段包不作为停止点。单次尾IDR已改为实际keyframe编码成功才完成，并通过静态停止/重新活动实播；默认关闭的单plane直写共享槽候选通过功能及A/B。QSV同session异步VPP→Encode候选已通过深度1/2/4、输入、重连、几何切换和尾帧实播；单租户约30FPS/p95 80ms，四租户3D满载且无最终呈现收益，继续保留external默认。单租户采集约55FPS而发布约42FPS，已定位发布节拍的额外损失，正在修复。最新任务与问题见[持续性能目标](../develop/docs/performance-goal.md)。

当前测试会话另有客户端环境上限：断开RDP后DXGI无显示输出，Chrome89 GPU VSync回退Sleep17，实测约31ms，空页面RAF也只有32Hz。该结论已有原生探针和Chrome trace。用户已允许新版或修改版 Chromium 模拟刷新作为验收客户端，优先验证本地157基线已有的 `--fake-vsync-rate=60`，复用 `out/rel` 增量产物。双页手动重连的旧video元素解码继续但rVFC停止问题，已改为每连接新video并通过两次split重连实播；旧回调、stream、DOM及marker测量正确结束。

## 结构

- **browser**：独立 ContentMain/ContentBrowserClient/ContentRendererClient、BrowserContext 和 WebView adapter，不链接 Chrome 的 Browser/TabStripModel/BrowserView。服务使用无窗口Aura宿主，原生demo使用Views窗口。
- **endpoint**：独立 C++20 + CMake/Ninja。Tenant → Session → Profile → WebView；当前每 Session 一个 Profile。MaxRects、不旋转、有 padding、显式排布失败；输入用 viewport DIP。
- **SDK**：GN 构建 C ABI DLL，外部 CMake 只消费 C 头与 import lib。Mojo 本地 pipe 与跨进程 isolated 控制连接；新增真实 libwebrtc PeerConnection、SDP/ICE、DataChannel 与外部 H.264 编码 C ABI。
- **Control/串流服务**：Control是产品状态source of truth；Endpoint托管Session/browser与恢复数据，每租户一条H.264 atlas视频。
- **原生demo**：显式构建browser_demo与endpoint_client，保留原测试管理器；Fence默认，native HWND为对照入口。

## 串流接入状态

| 项目 | 当前证据 |
|---|---|
| Control与客户端 | SQLite产品状态、会话鉴权、Tab/分屏/导航/设备配置、周期对账、生产bundle；43项测试通过；1500ms媒体反馈与队列观测接通，尚未启用自适应策略；大metrics记录串行写入；真实beforeunload取消/确认、两次split重连通过；可配置LAN监听和HTTPS，本地TLS/secure-cookie检查通过 |
| Chrome89 | 现有89.0.4389.90 headed真实运行；Sol检查桌面/平板UI与实际视频HUD；Pixel marker、IME composition、触摸响应、重复focus输入及endpoint退出自动恢复通过；主动断连后不自动重连 |
| browser服务 | 单Session进程、动态页面、后台页不占atlas、独立Profile与恢复信息；1/4租户管理和尺寸重建实测通过 |
| WebRTC SDK | 真正PeerConnection、SDP/ICE、DTLS/SCTP、native纹理租约、实际wire RTP、时钟校准、发送端stats；ABI2与共享atlas v2统一编译，4项RTC检查（含旧ABI拒绝、真实127候选ICE/DC与stats关闭屏障）及旧SDK检查通过 |
| oneVPL | UHD630 legacy1.35真实异步编码；多inflight有效；固定名义fps、关闭HRD后240帧码率阶跃通过，普通码率Reset不重开序列；默认VBR/TU1/深度1/LowPower auto；显式LowPower ON及码率阶跃通过，实际模式与返回状态可观测 |
| NVENC | 独立硬件backend编译通过；本机没有NVIDIA GPU/编码驱动DLL，初始化明确不可用 |
| 显示与输入同步 | 按rVFC的实际RTP时间戳匹配显示代次；真实视频/marker验证通过。无按键悬停可进入未聚焦可见页面且不抢焦点，拖拽/点击等保留焦点约束；五按钮modifier已修正，真实hover/click/IME与mixed回归通过 |
| 呈现与设备切换 | renderer注册校验epoch/geometry，提供可选single-plane-direct，默认snapshot；多平面统一快照，静态同epoch重挂载保留像素；live desktop→tablet2的过渡几何故障已修复并实播验证，stale→ready推进epoch并限制坐标输入；单/双平面两种呈现方式的8阶段往返、真实触控/点击/IME、旧epoch拒绝与Sol视觉检查通过；32a8313新解压包的真实启动参数、首帧/hover/click/IME/关闭与Sol视觉验收通过 |
| 延迟定位 | 默认关闭的browser/SDK/Endpoint有界trace，关联同wire RTP与CopyOutput request；Ganesh/OpenGL的GPU flush批次计时已实测，ETW已有GPU队列/CPU调度证据。capture_time_us明确为capture end；HUD不再把该段误标为完整捕获耗时 |
| 网络实验设施 | 真实UDP 10ms/24/48Mbps整形与Chrome89候选/转发通路验证通过 |
| 性能 | 四1080精准render16加RTP播放延迟0/0，40秒复测canvas15.95–15.97FPS、marker p95 90–143ms；实际render20再次GPU满载。目标未达，默认render-fps仍0沿用输出配置，播放延迟默认unset；配对条件见串流实验 |

网页viewport/DPR与媒体采样分离已运行验证，用于高DPR和分屏超出接收level时等比缩小视频；输入按mediaScale映射，统计显示源/编码尺寸。同一atlas内desktop@1与tablet@2保持独立网页DPR。平板真实页面检查已通过：Android Chrome UA不带Mobile、CH Android/mobile=false、platform Linux armv81、DPR≈2、viewport/screen820×1180、coarse/no-hover/touch10；使用公开原生设置，无JS伪装或CDP附加。WorkerNavigator另行核对。

实验条件、已测数值与最终性能表见 [串流实验](streaming-experiments.zh-CN.md)。

RTC支持显式RTP播放延迟请求，默认未设置。新离屏宿主精准render16下，0/0在交错复测中重复降低接收等待，且canvas约16FPS；40秒对照的native收包→video呈现p95从97–114ms降至2.69–3.79ms。可用`run.cmd --browser-render-fps=16 --rtc-playout-max-ms=0`复现该重载档，不作为所有负载的默认值。本文paint统计为canvas绘制提交；GPU完成和物理屏刷新未测，marker读回成本另报。

新一轮4×1080分段实验确认：提前向同Session GPU队列提交ready Wait会阻挡旧帧VPP。可选ready gate把VPP等待p50约41–46ms降到5–7ms，但最终FPS/p95无稳定收益，默认关闭。Chromium capture pending上限1/2同样未改善整体吞吐，作为默认关闭的实验补丁保留。单720 direct呈现有匹配场景收益，四1080无一致收益，默认呈现方式保持snapshot。不同源节拍、marker频率和特殊flag的组不混用；详见串流实验。

新离屏宿主、精准render16的四租户请求级profile中，两个完整覆盖窗口的Session捕获Created→SendResult p95约25ms，Skia submitted→finished约22ms；同RTP样本的native收包→video呈现p95约100ms，JS绘制提交约2ms。旧窗口路径曾出现捕获p50约216ms、PerformWork任务post→run约139ms，不能当作新路径当前耗时。诊断trace与关闭profile的性能组分别报告，详见[逐段profile](../develop/docs/osr-render16-segment-profile.md)。

服务模式已修复宿主DPI额外放大：每WebView通过官方capture scale override使实际backing跟随页面DPR；原生demo继续跟随宿主DPI。宿主150%下，desktop1920×1080@1和tablet820×1180@2分别实际提交1920×1080、1640×2360，混合平面的触控与中文输入通过。同帧静态画质PSNR由23.50提升至25.87dB。混合页仍共用atlas采样密度，desktop可能被放大到共同atlas比例；客户端平面尺寸标签由编码矩形反推，取整时可相差约1 DIP。

## 已实现

| 能力 | 当前状态 |
|---|---|
| 独立 content embedder、多页呈现 | 已构建运行；使用 Views/Aura |
| 原生窗口 DPI | endpoint/browser 统一 PMv2；嵌入窗口从创建时即为无边框；父窗口响应 DPI 变化，以物理客户区像素调整子窗口 |
| GPU atlas | 官方 GPU capture → browser staging/三槽共享纹理 → endpoint 自有 cache；ready/consumed shared fence；共享内存发布帧与布局；已通过真实视频链路运行 |
| 输出节拍/重建 | 全 atlas 帧率上限、damage 合并、槽满保留最新；DPI 新代资源导入、GPU 失败最多3次重建；稳态无 browser↔endpoint 逐帧 Mojo |
| Session 存储隔离 | 独立 BrowserContext/路径，localStorage 隔离测试通过 |
| UA/Client Hints | 官方 embedder_support 算法、Chrome 品牌、GREASE、平台与完整版本；运行验证通过 |
| window.chrome | 官方 loadTimes/csi；普通网页 chrome.app stub；范围见[兼容表面](browser-compatibility.md) |
| 输入模型 | Session/实例/文档/焦点 token 与序号校验；UTF-16 composition 校验 |
| browser 输入 adapter | 实际 focused widget、OOPIF 路由、独立 char、双三击、按键/鼠标/IME 收尾；触控采用官方 TouchEmulator 与最终 ACK/gesture 路径 |
| Fence client 输入 | letterbox/atlas 像素 → viewport DIP；SDK 工作线程保序；busy 有界重试、旧 token/输出代次丢弃；IMM composition/caret 候选窗反馈 |
| 生命周期 | desired/actual、request/complete 分开；freeze/thaw 检查 renderer ack；原地 discard 等待实际回调 |
| unload/restore adapter | 完整 history/PageState，同进程 sessionStorage namespace；真实提交后完成；opaque chunk 导入导出校验 Session/Profile/版本，POST 自动恢复明确拒绝 |
| 页面请求 | dialog/beforeunload、普通文件选择、context menu、pseudo fullscreen、find/zoom/edit/navigation；once 回复、文档失效取消，控制端轮询 pending/events |
| Profile 服务 | 默认 deny 的 origin/embedding 权限配置；HTTPS-only 会话目录下载、进度/取消和 Windows quarantine；不包含 SafeBrowsing |
| patchset | SHA-256清单、检查/应用/逆序撤回、失败回滚；四项默认关闭补丁：bounded capture、CopyOutput profile、旧宿主offscreen root、capture render rate。统一GN构建及4项工具测试通过；render rate有真实Manager/Throttler CPU probe，未做实播矩阵。新离屏宿主不依赖后两项补丁 |
| 独立 SDK 消费 | GN build、完整 runtime 导出、MSVC CMake/Ninja link 和 smoke 通过 |

## 验证与限制

此前 native 路径的 endpoint 核心测试、4 项 patchset 测试、SDK smoke 和隐藏窗口集成测试已通过，涵盖 identity、Session 存储隔离、输入 token、生命周期与 URL restore。SDK 50ms 无响应请求在63ms结束并使旧 handle 失效。这些结果不覆盖本轮新增 GPU、完整导航恢复及页面请求。

此前 DPI/GPU 阶段只做编译；本轮串流任务已授权并运行实验。GPU共享纹理、硬件编码、视频传输及正常尺寸重建已通过实际链路检查。原生 Windows IME、完整触控手势、下载和GPU故障恢复仍需目标机器测试。测试包记录 backend、构建指纹和文件校验和。

保留 Aura，不称为无窗口 embedder。旧 demo 为固定 WebView 集合；动态管理的接入状态见上节。window.open 仍明确阻止；原生 popup 在 GPU 输出中的合成/命中尚未验证。pointer/keyboard lock 明确拒绝。目录上传、tooltip 原生 hook、HTTP/代理认证、客户端证书、PDF/打印及生产重连/认证未接通。跨 browser 的 sessionStorage 不随导航 blob 恢复。CDP 附加期间远程触控明确拒绝，以免争用同一个 emulator；native 与 injected touch 也遵循官方互斥规则。音频未接。真实编码视频、延迟和FPS结果以上述串流接入状态为准；SDK暴露项目所需C ABI，不是完整libwebrtc C++ API包。

## 入口

当前运行包为`develop/tmp/RemoteKit-win-x64-streaming-qsv-nvenc-20261101-111347.zip`，440.5MiB，对应`55ffdf1`，manifest为clean；SHA256为`97e3422e1b676f543053038a342134b435b17b9ef48d1c7bb7bf2c226271a924`。537个文件hash全部匹配，打包与全新解压后的独立smoke通过。Chrome89收到1928×1088 H.264，首次hover不抢焦点，点击marker60001、IME42和RTC close200通过，无pageerror；Sol视觉通过，测试页自身左下文字有重叠。测试数据/Profile/metrics均在包外，验收进程已关闭。完整证据位于`develop/tmp/delivery-55ffdf1-20261101-111347`，旧58cb326包继续保留。

构建与运行：[README](../README.md)；[系统设计](architecture.zh-CN.md)；[GPU 输出](gpu-output.zh-CN.md)；[架构取舍](design-review.zh-CN.md)；[打包](packaging.zh-CN.md)；[控制协议](control-protocol.md)；[SDK](sdk.md)。本机调试输出为 `C:\src\chromium\src\out\dev\remotekit_browser.exe`。
