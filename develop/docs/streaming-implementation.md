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
| 无窗口GPU消费、QSV、多租户endpoint_service | endpoint_probe | Release与model检查通过；真实QSV连续码率/fps阶跃通过；最终包待功能/矩阵收口 |
| Control/React/marker/网络模拟 | control_server | build、25 tests、生产smoke通过；新paint、触控/IME marker、自动重连/主动断连、真实关闭确认/取消通过；等待最终ZIP的真实RTC首帧/输入验收窗口 |
| 独立QSV/端到端矩阵 | media_probe | 已完成16组/40租户段、画质/输入/尾IDR对照；选定VBR/TU1/d1，目标未达。第二轮45分钟正在定位源吞吐和客户端节拍（UTC 21:24–22:09），独占GPU测试与Chromium构建 |
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
- 干净checkpoint为56f1495，已推送并生成20261101-052354 ZIP；包内Node/SQLite/UI/browser管理smoke通过。最终ZIP还需一次真实RTC首帧、marker和输入验收，不能用管理smoke替代。

## 输出采样决策

平板高DPR/分屏可能超过接收端level的MaxFS/MaxMBPS。保留网页viewport/DPR及browser源atlas，由endpoint GPU NV12转换等比下采样到协商限制；NativeBuffer逻辑尺寸是编码尺寸，真实D3D texture尺寸保持源尺寸。layout坐标转编码像素，mediaScale独立于deviceScaleFactor，输入按两者乘积转DIP。stats/HUD明确源/编码尺寸与比例。该选择用于功能与编码约束，不把缩小后的FPS报告成原分辨率性能。
