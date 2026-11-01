# 串流接入设计与实施状态

2026-11-01。本文记录本轮架构决定与实施拆分；性能目标需真实测量。

## 边界决定

- Control 保存 Tenant、Tab、地址意图、激活/分屏与设备配置，是产品状态的 source of truth。SQLite 不储存 Chromium PageState；Tab 只引用 Endpoint Session/WebView。对账重新创建丢失引用并清理 orphan。
- Endpoint 使用独立 CMake/Ninja，管理 Session、browser 子进程、恢复信息、GPU 消费、编码和 PeerConnection。libwebrtc 放在 GN SDK 内，跨 DLL 用 C ABI；oneVPL/NVENC 编码适配器通过有明确寿命的 C 回调连接。
- 本轮选择一个 Session 一个 browser 子进程。每个进程只承接一个租户，拥有独立 Profile、atlas 与控制连接，避免现有全局 atlas 包含其他租户像素。每个 Session 内仍可多个 WebView，MaxRects packing 为一个 H.264 视频轨；多 Profile 目标不变。
- Control 负责客户端身份、短期连接授权和 SDP/ICE 中转；Client 与 Endpoint 直接传媒体和 DataChannel。Endpoint 不接受客户端自报 tenant 权限，连接授权绑定 Session。管理接口默认本机并验证共享管理凭据。
- 旧原生 demo 保留为显式构建目标。生产形态的 endpoint 服务不依赖 HWND 呈现；browser 继续保留必要 Views/Aura 平台能力。

## 帧与输入

Browser capture → Fence atlas → Endpoint 自有纹理 → GPU 色彩转换 NV12 → 异步硬件 H.264 → libwebrtc RTP。browser 源槽在 endpoint GPU copy 完成后归还，编码器持有独立有界纹理池。积压时保留最新帧，不形成随网络拥塞增长的排队。

每个 PeerConnection 只暴露所属 Session 的布局与 token。WebView/代次使用十进制字符串；输入坐标为 viewport DIP。布局变化与视频几何变化需配套版本；旧布局输入直接拒绝。分屏裁切同一视频，不重复创建多个视频传输。

静止后从 endpoint 保留的最新纹理补一次 IDR，帮助大变化后质量收敛。基准等待 150ms；低帧率时等待至少三个真实源帧间隔，最多 1s，避免每两个动态帧之间反复补 IDR。每次内容更新最多补一次，不调用 renderer 强制循环绘制；拥塞、PLI 与重建请求合并。

## 测量与实验

逐环节记录 capture、endpoint ready/copy、编码提交/完成、发送与客户端解码/显示；不同机器单调时钟不能直接相减。Pixel marker 用客户端发出刺激并在接收视频像素中识别同一序号，使用同一客户端时钟计算往返可见响应；另报时钟对齐后的单向估计和误差。FPS 按动态片段测量，静态页单独报告。

实验矩阵包括 1/4 租户、24/48Mbps、10ms RTT、文本滚动/动画/大变化后静止，收集 p50/p95/p99 延迟、显示FPS、编码耗时、码率、丢帧和清晰度。QSV 参数先验证驱动支持，再比较异步深度、参考帧、GOP、码控、VBV与质量预设，禁止以配置值代替实际结果。NVENC 本机无硬件，单列编译与运行证据。

## 实施任务

| 任务 | 负责人 | 当前状态 |
|---|---|---|
| browser单Session服务、动态页面、tablet、demo编译隔离 | endpoint_probe | v2统一编译；混合DPR、设备模式reload、browser kill历史恢复实测通过 |
| WebRTC C ABI与NVENC | media_probe | ABI2、真实双Peer/ICE/DTLS-SCTP/lease/stats关闭屏障通过，NVENC编译通过 |
| 无窗口GPU消费、QSV、多租户endpoint_service | endpoint_probe | 上一批包验收通过；新一轮补充逐帧QPC时间、帧ID及wire RTP关联诊断，定位排队与GPU等待 |
| Control/React/marker/网络模拟 | control_server | 上一批26 tests和解压包实播、输入、视觉验收通过；新一轮只读核查画布复制与单平面快速路径，待接口决定后实验 |
| 独立QSV/端到端矩阵 | media_probe | 前两轮及playout对照完成；新一轮独占GPU采样窗口，补SDK/捕获trace并关联视频引擎、CPU与同RTP各段帧龄 |
| 正式文档、评估、commit/push | 主Agent | 持续维护；完整结果验证后按范围提交推送 |

试验评估：暖机3–5秒，有效采样至少20秒；延迟p50/p95/p99、每秒FPS分布，优先p95<100ms+平均动态FPS>50；720p/1080p、DPR、可见平面数明确记录。网络模拟额外Node单核开销要一起报告。

## 已知问题

- 旧demo atlas汇集所有Session；网络服务必须使用已新增的单Session进程边界，禁止把旧demo直接暴露。
- UHD 630 legacy1.35已由oneVPL dispatcher真实编码验证；纯编码吞吐不代表实际视频链路。
- 本机无 NVIDIA GPU，无法取得 NVENC 硬件性能结论。

## 集成待核对

- GPU纹理跨异步编码的所有权：COM引用不等于池槽租约，必须 retain/release 计数直到硬件完成，关闭时排空。
- H.264 SDP level/SPS与实际1920x1080@60匹配：SDK本地5.1不证明Chrome89远端接收上限，需保留真实offer/caps/config/SPS；必要用已验证客户端接收配置，不能盲目改高level。
- 布局与视频已用实际wire RTP关联presentation epoch；真实流匹配通过。20秒633/633命中，元数据提前到达，当前32Hz不是epoch gate造成，不改为未经需要的ACK区间方案。
- 720p单租户源/编码/解码约53fps，而client RAF/rVFC约32Hz；marker off、disable-gpu-vsync、可见video和进程timer policy均无改善。工具在Windows已断开的Session2；第二轮继续有限的客户端GPU/节拍对照。
- 旧marker终点为授权snapshot，不含随后Viewport RAF等待；新客户端授权帧事件立即paint，记录选中平面paint时间并低频读同RTP marker，pending input期间全帧采样。正式结果使用新口径。
- 四租户码率按各客户端24/48Mbps与总encoder吞吐分别报告，不把四流共用24Mbps和每客户端24Mbps混作同一实验。
- UI关闭beforeunload真实userActivation、确认与取消均通过；修正Control漏读closing状态下pending_close请求的问题。
- 重复focus不改变token导致输入永久排队已修复为关联请求ACK；真实IME81→82和touch32769通过。Endpoint退出后同tenant/两tab及静态首帧恢复已通过。
- VPP与QSV/NVENC显式VUI统一BT709 limited；真实QSV四份SPS验证通过。
- 四租户1080p首轮资源诊断：UHD 630 3D引擎平均97.63%，VideoDecode 12.8%、VideoProcessing 5.2%；采集完成前p50耗时140–162ms。CIM采样器约占0.7核，改为低开销采样后再做对照；不同引擎百分比不能相加。
- 已测得宿主1.5让desktop1920×1080实际提交2880×1620，修复为service每WebView通过官方capture scale override匹配页面DPR，保留native demo。四1080源约8→20；混合desktop1/tablet2及touch/中文输入通过。逐PID资源、flag与画质对照见gpu-throughput-probe.md。
- QSV LowPower加入auto/on/off及实际模式观测；默认auto不变。显式ON和240帧码率阶跃通过，唯一四1080对照没有最终呈现收益。不会据请求值猜测驱动内部路径。
- 新的非阻塞问题：client平面尺寸标签用编码矩形反推，混合缩采样可相差约1 DIP；应将明确的原始viewport尺寸与输出epoch一起传递，不能拿tenant全局配置冒充每view实际值。本轮不扩协议。
- db8ca75独立ZIP实播通过，但发现首次hover错误横幅；已修为无按钮move/leave可悬停未聚焦可见live页面，仍验全部token/序号，其他输入需focus。Control五按钮modifier位同步修正，实际首次hover不抢焦点、click/IME与mixed均通过。
- 已补RTP playout-delay显式API/CLI，默认unset。720单租户特殊flag下：unset 53.03FPS/p95 103ms，max0 46.13FPS/82ms，max10 45.43FPS/92ms；不混合不同配置宣称达标。
- 后续性能诊断优先项：按同一RTP补齐server capture/VPP/encode阶段时间及GPU执行/等待计时。当前四1080的render→收包约661ms，只有聚合统计不足以确定具体队列；接收后的等待已用RTP界限对照验证，但没有消除JS/canvas消费损失。
- 最终交付：`develop/tmp/RemoteKit-win-x64-streaming-qsv-nvenc-20261101-065450.zip`，440.5MiB，revision58cb326/clean，SHA256 `0c696646a192462678d34b1910bb7975331b99c0c26a0a4b25f265e364611c77`。全新包外解压验收记录在`develop/tmp/final-package-58cb326-result.json`，首次hover不改focus/epoch，click CRC60001、IME42，截图无错误，应用依赖来自包内；数据/Profile/metrics均包外。运行验收完成，无剩余测试/打包任务。

## 新一轮定位与改进

用户已授权开始实验和改进，并允许随时检查video engine占用。上一批交付保留为checkpoint；本轮从39abcda开始。

第一阶段按同一wire RTP关联源capture、atlas发现/ready、私有copy、SDK投递、worker排队、VPP、MFX提交/完成和发送交接。诊断默认关闭、有界保存；不增加browser↔endpoint逐帧IPC，不改变GPU租约。QPC、TimeTicks与壁钟需要测量映射和误差，缺失阶段不能用猜测填补。

初始场景为1×720、4×720、4×1080，保持24Mbps/10ms RTT和既有编码默认。标记关闭时测吞吐，必要的1Hz标记测延迟，至少一组比较诊断开关开销。PDH按进程与物理引擎记录3D、Video Encode/Decode、Video Processing及采集器CPU成本；引擎名称不直接代表调用者的编码/解码任务。

客户端已决定实现可选的单平面快速路径：只有一个可见plane、元数据匹配，且唯一renderer注册的epoch/geometry均匹配时，同次rVFC直接绘制video到plane canvas。多平面、迟到元数据、挂载与布局过渡保持一次快照兜底，默认暂不切换。Viewport backing为encoded crop大小，CSS resize保留现有像素。新增明确plane source与sourceRect描述，诊断不得把plane canvas当完整atlas；最终是否作为默认取决于同场景A/B及视觉/输入验收。

Chrome89的rVFC元数据读取与drawImage(video)并非原子取得同一个frame handle；现有快照保证后续平面共享像素，不能误写成已证明像素与RTP原子绑定。

本轮新发现并纳入处理：

- 布局通知先授权帧、再通知React，旧绘制订阅可能仍持旧surface；原bounds与viewId/epoch检查不足以验证该订阅几何。源码时序风险，尚未复现实播错误。两种呈现路径都需校验订阅epoch/geometry。
- benchmark质量裁切将已编码的view.width/height再次乘DPR×mediaScale，非1比例下错误。迁移plane source API时同步修正；既有desktop1/scale1质量结果不受此问题影响。
- AtlasPool会在source ready尚未完成时向同Session的D3D11 immediate context排入GPU Wait，后续旧ready帧的VPP可能被挡住；各Session没有共享C++ D3D锁。新增默认关闭的`REMOTEKIT_ATLAS_READY_GATE=1`供A/B：先观察ready完成，再保留原Wait/copy/consumed顺序。不提前释放租约，也不把GPU利用率当作已证明此处是瓶颈。是否改变默认由同4×1080 trace与性能对照决定。

首组trace确认，shared frame的`capture_time_us`取自Chromium的`capture_end_time`，不是capture begin。四1080同wire样本中，browser capture begin→end约400ms，capture end→encoded返回约145ms均值；后者不能误写成整个捕获/服务器耗时。MFX Submit与encoded C ABI调用p95均不足1ms。后续需用官方capture元数据设置位置和必要的短时trace解释捕获内部排队，结合客户端时间夹测闭合marker render→receive；不再仅通过QSV参数解释整个延迟。

第一阶段完整结果见`server-frame-age-probe.md`。ready gate把VPP等待中位数约42–46ms降到5–7ms，但四1080最终FPS/p95没有一致改善，默认保持关闭。单720在本组31–32源FPS下，direct使canvas提交22→30.5FPS、p95 405→156ms；不可与此前53源FPS组混用。客户端33 tests与真实Chrome89首帧/hover/click/IME、静态renderer重挂载、split fallback、预配置tablet2的ROI裁切和Sol视觉检查通过。

第二阶段选择默认关闭的Chromium capture pending上限实验（1/2，对照原默认）。官方capture begin在ReserveVideoFrame之前，end在OnFrameReadyForDelivery收到完成结果后；Mappable ARGB路径等待GPU finished callback。因此该区间包含排队、GPU工作和完成回调。现有trace重建出每Tenant最高5–9个未完成捕获。限制计数采用`next_capture_frame_number_ - next_delivery_frame_number_`，包含完成后等待按序交付者；保持dirty/content版本，在名额释放时按最小capture period合并refresh，Stop取消旧代次重试。不得通过提前归还纹理减少时延。Chromium修改需要正式patchset/hash与可复现验证。

直播设备切换已定位并修复：Chromium把旧16:9画面暂时放入1640×2360新画布，content rect为1640×923、纵向偏移718；原校验把这张过渡帧视为producer失败，并非GPU设备丢失。每次capture绑定允许从首张几何不匹配帧起固定2秒的过渡期，丢弃过渡帧并合并refresh；Poll独立检查截止时间，后续坏帧不延长等待。正常几何结束过渡，格式、句柄与设备错误仍立即失败。stale→ready进入新layout epoch，客户端必须匹配新视频才能绘制并发送坐标输入；服务端也拒绝未就绪平面上的坐标输入。34项Control测试、Native CTest及统一GN构建通过；真实live双plane desktop→tablet2与CRC通过，完整单/双plane、direct/snapshot两种路径的8阶段往返已通过，touch/click/IME101–112均有CRC，29次stale布局无stale绘制，旧epoch拒绝；Sol视觉检查通过。

往返验收发现本地textarea保持focus时，远端焦点已切换，pointerdown的editor.focus不会再次触发onFocus，导致首个touch.start被拒。已采用pointerdown显式请求远端focus，保持关联ACK、排队与epoch/token校验，触控/IME回归通过。最终bundle为index-CTjYS6kC.js，34 tests/build/typecheck/smoke通过；撤回了全连接首错保留的额外行为，仍由inputResults完整序列定位首因。待clean revision打包并验收首帧。用户曾临时占用3001，重试已确认自建服务和本轮bundle，端口冲突不算产品故障。

捕获pending上限1/2实验已完成，结果见`bounded-capture-probe.md`。早期cap1减少捕获帧龄，但最终FPS没有改善；后续组实际capture降至约1.6/3.2FPS，不能把renderer的42–48次render/s当作采集FPS。最后变化已按源实际写入marker与客户端CRC验证送达，Stop/reopen通过。cap与ready gate均保持默认关闭。当前运行同默认canvas trace-off/on及独立CSS compositor场景，使用官方Viz/GPU trace区分排队、执行与回调；trace开销组不作为性能提升证据。

功能修复与既有trace已提交并推送`be9546d`。原生官方trace已取得初步细粒度证据：session4/capture_counter153的捕获至browser回调约308ms，其中CopyOutputRequest生命周期304.223ms，SendResult至capture end为3.156ms，再至browser回调0.777ms。现有GPU-thread CopyOutput CPU事件无request id，renderer GPU timers不能代替该copy的执行时间。

优先级P1：完成检查调度异常。205次带toplevel.flow关联的GPU delayed check任务请求延后2000us，实际post→run p50 47.092ms、p95 61.074ms，任务CPU体p50约0.022ms。需要区分timer/线程排队、GPU提交/执行、完成检查，不把全部304ms归因于通知。

默认关闭的独立profile补丁0002已实现并完成增量构建：以同一request关联capture创建、GPU dispatch、flush、真实submit分支及提交回调、GPU elapsed（支持时）、完成观察与SendResult。保留原submit/poll/callback/lease行为，记录后端与semaphore数；Skia flush elapsed可能含此前未flush工作，不能标为纯copy。关机前1×720得到413个完整请求，Ganesh/OpenGL支持elapsed，flush batch p50约0.66ms、p95约3.63ms；四租户实验在关机时进行中，恢复后检查文件完整性并按需要用新case重跑，不跨boot混合QPC或性能对照。

官方profile及ETW工具/报告已分别提交推送c767c6d、77cb5bb。ETW零丢失；250ms完整包样本中源GPU提交等待125–225ms、DMA跨度约3–4ms，源GPU进程显式CPU Ready→Run最长0.439ms。不能把DMA跨度当纯copy，也不能把进程统计当GpuMain定向结论，详细范围见etw-gpuqueue-profile.md。

关机恢复已完成：旧四租户组的metrics/trace已写完，保留为旧boot记录；新boot独立四1080与单720均完成，未跨boot合并时间轴。请求级结果见copy-output-profile.md：四S4请求p50约216ms，submitted→finished约203ms，同批GPU elapsed约0.81ms。主要等待已定位到提交与完成观察之间，不能全算callback延迟。

优先级P1后续定位改为真正的PerformWork/MakeCurrent完成观察入口。S4慢帧实际PerformWork任务post→run139.454ms；surface CheckAsyncWorkCompletion仅覆盖1/142个finished，撤回直接调surface poll的假设。局部submit虽Skipped，成功Skia submitted约1ms后已出现，不盲目强制submit。后续需要同context的not-ready/ready观察边界，与GPU队列分开量化。本轮不再加补丁或改变调度参数，先交付已验证批次。

0002回调所有权审阅、两项补丁撤回/重应用、统一增量构建/SDK导出和4项patchset测试已通过；已提交推送55ffdf1。新包`RemoteKit-win-x64-streaming-qsv-nvenc-20261101-111347.zip`为clean55ffdf1，461935509字节，SHA256 `97e3422e1b676f543053038a342134b435b17b9ef48d1c7bb7bf2c226271a924`。537项文件校验、两次独立smoke、真实Chrome89首帧/hover/click60001/IME42/close200及Sol视觉均通过，证据在delivery-55ffdf1-20261101-111347；9个自建进程已清理、端口3117无监听。旧checkpoint保留，本批交付完成。性能目标仍未达到，P1后续定位保持上述真实完成观察路径与GPU队列问题。

## 提交后等待的实质改进

用户要求继续改进。对既有慢帧进一步关联发现，S4完成观察任务迟到137.464ms，其中137.361ms被已执行任务覆盖；内部DXGISwapChainImageBacking::Present持续131.914ms。S3/S2同类Present为147.837/84.290ms。CrGpuMain被同步Present阻塞，同线程高优先级完成检查不能抢占它，因此不实施该优先级方案。

主Agent选定首个有界对照：仅串流Session source browser使用标准`--disable-direct-composition`，保留GPU、官方CopyOutput和Fence；接收端Chrome89不改。Endpoint新增可覆盖的`browser-direct-composition=auto|off`，初始默认auto。先确认off路径真实GPU/H264与profile，再用相同二进制、默认编码、snapshot、24Mbps/10ms进行四1080 auto/off对照及单720回退检查。以canvas FPS、同RTP marker p95、读回成本和功能正确性决定是否保留/推广，不能仅凭Present scope消失就判成功。

直接source→共享slot、单plane省一次atlas copy在源码层面可行，但需要正确维护最新像素位置、padding和多plane/静态fallback；暂缓，先处理已有直接证据的Present阻塞。root compositor仍呈现2880×1620而WebView捕获1920×1080的额外开销也在只读核对，未经验证不改viewport/DPR。

第一对DComp auto/off已完成：off上游render/encode略升、CPU下降，但canvas FPS无改善。profile证明阻塞转移到NativeViewGLSurfaceEGL::PostSubBuffer（慢帧约448ms），故停止其余矩阵，不推广off默认。

主Agent选择下一实现：默认关闭Feature RemoteKitOffscreenRoot，仅source Session browser的VizProcessTransportFactory把root_params->widget置为官方null surface handle，保留浏览器侧真实HWND、Compositor可见性、完整尺寸和生命周期。官方SkiaOutputDeviceOffscreen保留GPU纹理、Reshape/BeginPaint与swap ACK，没有原生Present；不是隐藏Compositor或软件截图。独立0003补丁，先profile验证，再同binary/profile-off/marker1Hz四1080 A/B与必要重复；有最终收益后才测轻载/重建/输入并决定默认。宿主DPI的root额外像素面积作为后续独立变量，不混入本次对照。

offscreen首对退化：源render约20→40–42/s，capture约20→10/s，canvas约7.6–8.5→6.3–6.7FPS，marker p95约1085–1195→1633–1952ms；3D busy仍约99%。原生Present虽消失，但提交更多GPU工作，不能推广此默认，余下矩阵停止。静态点击/IME最后变化通过；0003仅保留默认关闭诊断能力。

下一独立变量为source-only标准`--force-device-scale-factor=1`，通过Endpoint `browser-host-scale=auto|1`和prepare参数控制，初始默认auto。源码确认ScreenWin与WinHost的Chromium DPI解释会跟随forced值，RWHV native DSF分母也变1；Control仍独立设置网页DPR1/2。先验证root实际尺寸、desktop/tablet backing与混合输入，再做同binary、DComp auto、offscreen关的auto/host1端到端对照。有最终收益才重复和轻载回归；不修改系统DPI，不手工调整root transform。

source宿主实际仍有系统边框，ConfigureOutput却把atlas客户区尺寸当outer size。已改为source-only frameless，native demo保持原行为；真实renderer metadata、四角像素、右下mouse/touch、IME/reload和mixed通过。旧裁剪是本地root裁剪，renderer提交仍完整，不能夸大为视频丢边。修复后有效auto/host1对照仍无最终收益，默认保持auto；报告见source-host-scale.md。

下一架构实验为真正的source BeginFrame admission：默认关闭Feature RemoteKitCaptureRenderRate，参数max_fps。直接Throttle会被正在capture的豁免取消，因此在GPU FrameSinkManager当前捕获子树规则中显式应用，不维护Host ID缓存。FrameSinkThrottler新增默认0的capture_render_interval，仅>0时与explicit及cadence有效间隔取max；为0时保留原行为，停捕获/重算清理旧值。不注入JS、不隐藏页面、不增加browser↔endpoint逐帧IPC。

0004已完成统一构建及真实Manager/Throttler CPU probe（on/off），尚无实播性能数据。用户纠正架构后停止30/20矩阵，保留默认关闭的实验源码，不将其作为新输出路径的依赖。

## 当前执行：按设计替换服务渲染宿主

用户指定参照`C:/src/tmp/electron-investigation/IMPLEMENTATION-SKETCH.zh-CN.md`第5节，并明确Aura无需去除。之前将保留Aura连带成保留原生显示窗口是主Agent架构判断失误；不再沿该窗口路径追加拦截修补。

主Agent选定每WebView独立的无原生窗口Aura WindowTreeHost，参考官方Headless宿主。保留WebContentsViewAura/RWHVAura、DelegatedFrameHost、输入/OOPIF/IME；source不创建Views Widget或atlas显示窗口。ui::Compositor从构造开始使用null accelerated widget及external BeginFrame，直接采用官方离屏目标，不依赖0003。rectangle packing在现有GPU桥完成。

服务虚拟host统一DSF1，与Windows屏幕DPI脱钩；页面设备DPR仍由现有仿真与capture scale override控制。host物理尺寸、内容DIP、网页backing及atlas位置分别维护。browser本地pacer按输出fps驱动，每host最多一个未ACK tick并合并过期tick；ACK与真实GPU完成分开，现有source lease和双向Fence保留。旧窗口路径只作明确诊断对照，原生demo维持原行为。

profile_resume负责实现、唯一GN/GPU窗口、真实Chrome89功能与1/4租户对照；delivery_resume准备最小验收集并做独立代码审阅。先验证single视频/input/IME、DPR切换/mixed及OOPIF，再测无native Present和性能，不把架构替换本身宣称为已达到目标。

新宿主统一编译及single720真实Chrome89 H264、hover、click60001、IME42已通过，90次BeginFrame提交/ACK一致。四角与右下mouse/touch、IME92、reload及静态最后变化通过；真实renderer metadata为desktop1920×1080@1、tablet1640×2360@2，host分别1920×1080与820×1180@1。Windows的InputMethodMinimal仍有纯虚方法，故采用官方Headless同款MockInputMethod避免本地WinTSF，远程IME继续直达RWH。

窗口枚举发现不可见Chrome_WidgetWin_0，经当前ui_gfx.dll加载基址、PE/PDB vtable及对象身份确认是gfx::SingletonHwnd广播辅助窗，证据osr-aura-edges/window-object-proof.json。不是页面呈现窗口；不把整个Chromium进程描述为零HWND。独立源码审阅未发现确定缺陷，mixed/OOPIF/GPU恢复及性能对照仍在执行。

已解决P1：split第二个离屏host曾使Viz CHECK退出。修正子进程LoggingSettings继承HANDLE后取得准确日志：Got overlapping IssueExternalBeginFrame。多个host复用了kManualSourceId，Viz的全局sink观察按source_id归属，使不同host的pending互相污染。已采用CEF式官方StubBeginFrameSource为每host分配独立source_id，未修改Viz观察/ACK语义。双host各239次提交/ACK一致，8阶段设备/呈现切换、静态恢复、旧epoch拒绝及混合DPR/中文输入通过；16秒官方trace无DXGI或NativeViewGLSurfaceEGL的Present/PostSubBuffer。

P2输入修复：OOPIF实播已有双renderer及iframe中文预编辑/提交、切回主文档和再次输入证据。其间leave后出现invalid_mouse和布局移动；旧trace未保存x/y，不能确定缺字段还是非有限值。delivery已将leave按当前几何clamp，无效尺寸/非有限坐标拒绝，并补mousecancel结束。主Agent复核后确认模型允许捕获中的有限越界坐标，因此move/up/cancel保持原始DIP，避免破坏拖拽/边缘滚动；不放宽browser验证。35项测试/typecheck/build/smoke通过，最终bundle为index-Bsj1jkWQ.js，profile负责实播验收。证据osr-aura-oopif-final/metrics/client-metrics.jsonl。跨iframe切换后IME验收等待实际DOM焦点反馈，不把点击派发完成误当已聚焦。

真实source GPU进程故障已通过：同一Chrome89连接，GPU19116→1544，decoded35→181，后续click/IME同RTP marker88返回；有效共享输出generation/epoch保持1。这组无pending tick，221提交/ACK；另一组in-flight时controllerGeneration1→2、cancelled1并恢复1752ACK，覆盖断连取消。未用ACK或故障伪造GPU完成，也未为测试强制共享输出重建。接下来运行新Client边界实播和同binary的1/4×1080新旧宿主性能pair。

60fps新旧宿主配对结果：单1080 source/encode32.0→36.4，marker p95 186→155ms，但canvas31.6→29.3；四1080 source18.0–18.6→32.6–34.3，encode11.2–11.9→11.1–11.9，canvas7.0–7.8→5.9–6.3，p95 976–1196→1377–1435ms，3D99.2→99.8%。架构与功能已接通，60fps驱动下负载仍积压，未达到目标。

下一步由主Agent固定独立browser-render-fps（0沿用输出上限），只影响新OffscreenHost本地pacer，不改capture/atlas上限、QSV名义fps、码率和客户端。以同新binary/最终bundle做四1080的60基线、30、20各一次有界对照，依据最终呈现/marker结果决定背压方案；不采用0004，不先实现自适应算法。delivery只读盘点真实资源和capture时序信号，防止把ACK或不存在的静态capture当作GPU完成。

## 用户新增建议与当前继续范围

用户澄清：暂不展开下面五项新增建议，当前任务继续；之前将其理解为暂停全部工作有误。自建上一轮实验进程及managed浏览器已清理，代码checkpoint a1b88cf已推送。继续修复已经定位的pacer定时量化问题、验证渲染预算/背压效果，不另扩展新的建议任务。

用户指定后续方向：

1. 停止出帧后至少补一次forced IDR，但只补一次；先核对现有自适应尾IDR实现，不重复叠加。
2. 目标帧率随客户端显示器和网络条件自适应。
3. 支持背压，避免无效源工作挤占编码/呈现资源。
4. 尝试更高码率并测量画质、延迟与拥塞。
5. 使用高精度计时器。

最新三档同binary对照：pacer配置60/30/20，canvas分别4.85–6.03/6.72–8.22/15.24–15.89FPS，marker p95分别1657–2112/875–1014/184–317ms。20档实际pacer约16/s，不能写成真实20FPS。详见source-render-pacer.md。

已定位的定时机制：RepeatingTimer默认FlexibleNoSooner且按实际回调时刻重排，Windows存在约16ms leeway；官方precise deadline机制可避免该延迟，但默认MaxPreciseDelay=36ms，20fps的50ms任务会被降级。高精度manager已经由Content初始化。主Agent选定DeadlineTimer绝对phase，远deadline先coarse预唤醒，进入阈值内再precise；预唤醒不发BF，跳过过期phase，不忙等或手动全机timeBeginPeriod。先验证实际60/30/20 tick，再比较四租户实际16/20，最多补一个60对照。策略尚在实施。

## 输出采样决策

平板高DPR/分屏可能超过接收端level的MaxFS/MaxMBPS。保留网页viewport/DPR及browser源atlas，由endpoint GPU NV12转换等比下采样到协商限制；NativeBuffer逻辑尺寸是编码尺寸，真实D3D texture尺寸保持源尺寸。layout坐标转编码像素，mediaScale独立于deviceScaleFactor，输入按两者乘积转DIP。stats/HUD明确源/编码尺寸与比例。该选择用于功能与编码约束，不把缩小后的FPS报告成原分辨率性能。
