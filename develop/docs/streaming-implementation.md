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

已批准下一步默认关闭的独立profile补丁：以同一request关联capture创建、GPU dispatch、flush、真实submit分支及提交回调、GPU elapsed（支持时）、完成观察与SendResult。保留原submit/poll/callback/lease行为，记录后端与semaphore数；Skia flush elapsed可能含此前未flush工作，不能标为纯copy。先短1×720和4×1080诊断，随后决定是否改调度。Control只读核对WPR/ETW工具可用性，GPU实验由media独占。新包等待这批诊断与clean revision，不覆盖旧checkpoint。

## 输出采样决策

平板高DPR/分屏可能超过接收端level的MaxFS/MaxMBPS。保留网页viewport/DPR及browser源atlas，由endpoint GPU NV12转换等比下采样到协商限制；NativeBuffer逻辑尺寸是编码尺寸，真实D3D texture尺寸保持源尺寸。layout坐标转编码像素，mediaScale独立于deviceScaleFactor，输入按两者乘积转DIP。stats/HUD明确源/编码尺寸与比例。该选择用于功能与编码约束，不把缩小后的FPS报告成原分辨率性能。
