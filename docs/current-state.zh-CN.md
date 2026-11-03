# RemoteKit当前状态

更新：2026-11-04。Windows x64；Chromium官方157.0.8103.15，基线`1aa07b638799e59656559ae6c6649d4b197f555e`。复用out/dev、out/rel增量构建，继续支持Chrome89。

## 当前交付

Comp / Rend重构已完成源码构建及Chrome157/89真实功能验收，正在提交与制作发布包。用户最新要求完成后上传并返回取件码；此前“仅本地包”要求已被替代。目前尚未生成或上传新架构包。

Browser/SDK四目标及Endpoint Release已构建成功；Endpoint15项CPU测试与后续H264/生命周期定向检查、Slot/Wake编译期probe、WebRTC adaptation与3组BeginFrame probe通过。SDK195项导出依赖、4个公开头及import lib与实际消费者hash匹配；外部SDK/RTC/audio smoke 3/3通过，RTC smoke包含D3D纹理。

Chrome157/DPR2与Chrome89/DPR1真实通过默认video首帧、双Window画面及点击/text/wheel、单次Idle尾IDR与Wake、三档质量热切换、1440/1100/390布局及导航。组内RTC/video/track身份保持，两组共用同一Browser，无FATAL/CHECK/GPU退出；29个旧代全部退休，retired occupied与unknown retention均0。157标准jitterBufferTarget读回0，89无该属性但兼容playoutDelayHint读回0。前三次首帧失败及对应修复保留在运行记录，不计作成功证据。

157短限速组48→4→48Mbps中，GCC目标由33–38.6Mbps降至0.791Mbps，恢复10秒后3.512Mbps，视频持续解码；没有回到原目标，也未观测到网络触发编码尺寸变化。QSV共588次Reset，192次正status5；驱动会调整目标，例如请求1.5Mbps、读回4.908Mbps，不能当作实际线上码率。没有负Reset状态。旧capture性能与包验证不能代替本批证据。[构建记录](../develop/docs/comp-rend-build-20261103.md) · [真实运行记录](../develop/docs/comp-rend-runtime-20261103.md) · [问题清单](../develop/docs/open-issues.md)。

## 本次渲染与媒体契约

- Endpoint Comp选择空闲Slot，异步发送带generation/slot/value的Begin；Browser Rend返回Reject，或在实际GPU队列Signal对应Slot ready Fence。最多四个atlas Slot，活动深度按压力变化，允许多个请求在途。成功帧没有ready/present/release IPC。
- 每WebContents独立Aura root，经BeginFrameSource驱动专用Viz OSR OutputDevice，直接绘制共享BGRA目标；Browser在GPU上合成各plane为请求指定的atlas Slot。旧Capture/CopyOutput生产路径、旧自治节拍及桥接fallback删除，不需要本地屏幕Present。
- 每Slot独立ready/consumed Fence及元数据。必须观察真实ready后才编码；SDK、转换和硬件编码租约全部结束，且consumed实际完成后才能复用。Stop/Stopped仅证明有序请求排空；未完成GPU工作继续保留。
- Idle只在最后有效内容已提交、后续渲染需求停止时返回；后续Chromium需求通过绑定最后Idle身份的Wake恢复。已在途的晚到Begin不能清除唤醒证明。单次尾IDR通过force Begin取得合法Slot。
- 三档质量分别映射WebRTC的MAINTAIN_RESOLUTION、BALANCED、MAINTAIN_FRAMERATE。官方source adaptation选择缩放/丢帧，SetRates驱动硬件码率与帧率；删除自制延迟阈值、DPR因子和码率/FPS预设。Comp另外遵守客户端、编码器及协商H264的硬能力上限。
- 媒体适配缩放完整atlas，页面DIP和Client Scale不随网络改变。X/Y对齐取整分别进入ROI、输入与caret转换；尺寸变化保持旧布局输入门禁及新布局首帧屏障。
- 实际receiver设置jitterBufferTarget=0；Chrome89仅在标准属性缺失时使用可用的playoutDelayHint=0，能力与读回分别报告。
- SDK控制/渲染ABI为2，RTC ABI为3，SharedRenderMapping版本1。Browser、SDK、Endpoint须配套更新。显式native demo仍可独立构建，其fence模式明确Unsupported，不切回旧capture。

正式细节：[Comp / Rend](rendering.zh-CN.md) · [GPU](gpu-output.zh-CN.md) · [SDK](sdk.md) · [媒体反馈](media-feedback.md)。

## 保持的产品边界

Control拥有User、Window/tab、设置与有限Endpoint引用；Session托管Chromium恢复数据。当前每Tenant一个Browser进程、单Profile，Endpoint可分机部署。Client只持久化token，产品状态由WS快照和持久操作收据收敛；常规媒体、输入、浏览器操作与文件走WebRTC。

Viewer默认video，独立Window按客户端内容bounds布局、atlas只负责裁剪，关闭原生媒体入口。focus、导航、resize保持RTC与媒体身份；旧文档/布局撤销输入资格，新布局首个有效关键帧后才放行。Client触摸保留touch-action/preventDefault仲裁，移动编辑绑定文档/owner；真实移动软键盘仍须实体设备验收。

Memory Saver由Control维护：Viewer断线决定产品hidden与回收资格，RTC仅决定渲染需求；安全隐藏页面30秒冻结、120秒丢弃，Native执行点复查。保护条件或实例变化会重置计时，不把RTC连接反向当作产品visible。

搜索设置、起始页、文件对话框与Worker拍照选帧保留。音频来自Chromium播放target，经独立Opus管线发送；左右声道选择按整个Viewer持久化。本次质量偏好仅更新video sender。

## 已发布与重构前证据

最新已上传版本仍为`11299d9`，取件码467761，旧包名`RemoteKit-win-x64-streaming-qsv-nvenc-20261103-221813.zip`，462549523 bytes。SHA256：`0699efcb56288d0dea734c256cf2b2c37f41d261ef298441694352723aa2e79c`。它修复音频设备枚举和Viz同步完成致命退出；560项manifest/ZIP及包内真实WebRTC操作、设备枚举和双声道PCM通过。[发布后修复运行](../develop/docs/loopback-crash-runtime-qa-20261103.md) · [构建](../develop/docs/loopback-hotfix-build-20261103.md)。

其后的`70e4243`已提交推送，按当时要求仅测试、未上传。修复Video回退原因误报、hidden/未ACK期间metadata重试预算，以及Viz相同frame ID重复接纳。Control293项、增量编译、12补丁可逆及89/157功能组通过；真实整个Viewer hidden未由headless产生，截图原始回退原因仍未知。该本地包另通过560项manifest/ZIP及包内注册、导航、点击/输入/wheel/resize、10次设备枚举和双声道PCM；无fatal、媒体身份保持、MSTP/draw0。证据`develop/tmp/release-70e4243-product-qa/test-summary.json`，详见[运行](../develop/docs/video-lifecycle-runtime-qa-20261103.md)与[构建](../develop/docs/video-lifecycle-build-20261103.md)。这些均属于重构前路径。

历史双Tenant45秒组为canvas51.69/51.73FPS、Pixel marker p95 76/79ms，条件1920×1080/DPR1、atlas1936×1088、RTT10ms、每peer48Mbps、UHD630/QSV。用户取消额外稳定尾跑和单Tenant重复组，本次不重跑。Marker终点为canvas提交，不能改称video物理显示FPS。[完整条件及历史工具](streaming-experiments.zh-CN.md)。

## 明确保留的差距

每Session当前单Profile；完整IME replacement/span、原生popup widget合成/命中、目录上传、认证/证书、跨端剪贴板、PDF/打印及原生长按仍有缺口。POST reload缺少repost确认协议时明确拒绝。IPC传输故障后同Browser incarnation重附着仍需独立契约，不能重放未知mutation；跨进程重启不能恢复网页JS堆。

本机没有NVIDIA硬件、实体移动软键盘及真实摄像头效果验收。新OSR路径目前没有可靠的GPU完成时间戳，capture_time_us保持0并省略相应延迟样本；不能用提交/Flush时间补造，也不能引用旧capture-end延迟作为新结果。CPU测试、编译、真实GPU与实体硬件证据分别记录。

[系统架构](architecture.zh-CN.md) · [Control](control-plane.zh-CN.md) · [协议](streaming-protocol.md) · [输入](client-gestures.zh-CN.md) · [导航](navigation-operations.zh-CN.md) · [音频与文件](audio-and-files.zh-CN.md)
