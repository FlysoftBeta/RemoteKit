# RemoteKit 系统设计

本文定义组件职责、页面语义、资源寿命及扩展接口，独立于开发机上的外部资料。具体代码已接通的能力、构建结果和未验证项见 [当前状态](current-state.zh-CN.md)；架构取舍见 [选择记录](design-review.zh-CN.md)。下文的目标行为不等于实现完成。

## 组件与构建边界

RemoteKit 在 Windows/D3D11 上提供独立 Chromium content embedder，由 endpoint 接入控制和输入，最终将多个 WebView 的画面排入一个视频通道。编码、音频和 WebRTC 传输目前不接线；库接入与媒体管线接线分别推进。

| 组件 | 归属与职责 |
| --- | --- |
| 测试管理器／未来控制服务 | 保存 Tenant、Session、Profile、WebView 的逻辑清单、配置和期望状态；保存 browser 导出的恢复信息，决定持久化时机 |
| browser | 承接逻辑页面，管理 BrowserContext、WebContents、输入焦点、生命周期、页面请求和采集，报告实际状态 |
| endpoint | 导入 GPU 资源、等待与归还 Fence、合成呈现、接入输入；未来承担格式转换、编码及传输 |
| Chromium 子进程与服务 | 继续承担网页执行、网络、合成、GPU 和浏览器自身音频；不由 endpoint 重写 |

当前测试管理器运行在 browser harness 内，复用独立 endpoint 模型库；原生 endpoint client 管理进程、输入与 GPU 消费。这个 demo 布置不等于最终控制服务的部署方式。

browser 在固定官方 Chromium Release 上用 GN 构建，不链接 Chrome Browser、TabStripModel 或 BrowserView。endpoint 使用独立 CMake/Ninja，不包含 Chromium 私有头，也不在 CMake 配置过程中触发 Chromium 构建。两者通过 C ABI SDK 和 Mojo 对接，跨 DLL 不传 STL、libc++、Abseil 或 Chromium C++ 对象。

Mojo 当前使用 NamedPlatformChannel + IsolatedConnection，两个进程保留独立 broker 图。测试协议为版本化 UTF-8 JSON，64位值用十进制字符串，一次消息最多1MiB。同步 SDK 调用在工作线程执行；超时或传输失败使连接失效，避免回复错配。当前一个管理连接可访问启动时配置的全部 Session，Session ID 本身不是认证凭据。

Mojo、libwebrtc 的库接入需要可复现的 SDK/runtime 导出。当前 WebRTC 仅接 timeutils，完整库边界仍待完成；不为补库接入而启动 peer connection、codec 或传输管线。

## 隔离、身份与逻辑配置

Tenant 对应一个 Session，Session 是数据隔离边界，下面可包含多个 Profile。Profile 对应具体 BrowserContext 和存储目录。当前只支持一个 Profile；同 Session 的 WebView 共享该 Profile，跨 Session 不共享 BrowserContext、路径、恢复数据或控制权限。多 Profile 不能改变 Session 的外层隔离语义。

WebView 是稳定的逻辑页面，WebContents 是按需存在的执行实例。只有逻辑创建与关闭改变 WebView 集合；冻结、丢弃、卸载、renderer 退出或 browser 重启都不应改变它的身份。

逻辑配置包括归属、导航意图、viewport、可见性、焦点、静音和输出订阅。可见、聚焦、需要输出、需要保留执行实例是不同维度；后台活动也可能要求保留执行。配置应在实例替换后重新应用，而不是依附旧 HWND、widget、surface 或音频流。

实例、文档、焦点、操作和输出资源分别有代次。事件只对其原始目标有效；不能把旧点击、按键、composition 或页面请求重新解释为对新文档的操作。尺寸和 GPU 资源变更也要使旧输出定位失效。

当前 demo 的 WebView 集合在启动时固定。动态创建、正常关闭及 browser 重启后自动承接逻辑清单尚未接通；现有自增 ID 与启动参数不能替代控制服务保存的逻辑身份。

## 生命周期与观测

生命周期层提供机制，不装配 Chrome MemorySaver 淘汰策略。调用方表达期望状态，browser 执行 adapter 对照实际活动决定受理、阻止、延后或失败。受理、renderer 完成、输出就绪、内存回收不能混用。

观测至少覆盖可见性、加载/交互、发声和媒体活动、输出需求、页面请求、renderer 健康、操作进展及可获得的资源使用。PID 可以被多个页面共享；进程计量不能直接写成单页独占用量。保留 content 的默认进程优先级聚合；更细资源归因可扩展 PerformanceManager，不引入 Chrome 的策略集合。

| 转换 | 执行与完成条件 |
| --- | --- |
| 冻结／解冻 | 使用 SetPageFrozen，观察 renderer lifecycle 确认；调用函数不等于完成 |
| 原地 discard | 保留 WebContents/controller，等 renderer discard 完成；恢复走 LoadIfNecessary |
| 卸载／恢复 | 保存导航与必要存储关联后销毁 WebContents；为同一 WebView 创建新实例，导入并等待实际导航提交 |
| 逻辑关闭 | 独立于资源回收，处理关闭确认和 beforeunload 后移除逻辑页面；demo 终止进程不等价于这个流程 |

冻结前页面应 hidden，暂停实际采集但保留订阅意图，收尾 composition 与待处理交互。发声、媒体/设备活动、导航 pending commit、输入锁及关联活跃页面都是阻止原因。共享 BrowsingInstance 的页面需要按关联集合判断，不能仅冻结隐藏 opener。当前 adapter 对存在其他关联活跃 Contents 的情况直接阻止，不自动编排整组转换。

原地 discard 的流程是检查活动与导航、停采集、失焦并清理输入/请求，再调用现有 WebContents 的 Discard。content 完成专用空文档提交、子 frame/BFCache 清理和 reload 标记；宿主不另建替代 Contents，也不直接 kill renderer。WasDiscarded 通知不足以证明完成，更不证明内存已回收。内部空文档不能覆盖用户导航历史或恢复记录。

卸载不要求先 discard。逻辑 viewport、订阅和其他配置继续保留。要求持久保证的恢复信息，应先交由管理方可靠保存再确认卸载完成；当前 demo 仅在 browser 内保存快照并提供导出，尚无外部持久化确认协议。

当前操作都有代次与有界收尾；snapshot 区分 pending、最后结果和状态不确定。超时不能假装成功；状态不确定时，现有实现只允许用 unload 清理。它还没有自动重试、期望状态 reconciliation 或完整的 browser 崩溃恢复管理器。

## 导航持久化与统一恢复

管理方保存逻辑页面清单及期望配置，browser 提供实际提交、重定向、历史变化与 Chromium 专用恢复数据。管理方无需解释 PageState。无需复制 Chrome SessionService、启动页或 tab 选择策略。

恢复按现有实例状态分流：frozen 解冻；discarded 在原 controller 上 LoadIfNecessary；已卸载或 browser 重启则重新关联正确 Profile，创建 Contents，Restore 导航栈，再按执行需求加载。只有初始地址时走普通导航。之后重新取得实际 widget，应用 viewport、可见性、静音和订阅，并请求首帧。页面恢复与输出恢复分别报告，没有输出订阅时不应等首帧才确认执行恢复。

导航数据保留全部 history、选中索引及 renderer 已报告的 PageState，使用 NavigationController/NavigationEntry 和 ContentSerializedNavigationBuilder 转换。导入校验格式、大小、Session/Profile 与 Chromium 版本。当前提供有界分块导入/导出，不自动规定磁盘文件格式或保存时机。

恢复范围要分开：

- PageState 可恢复滚动和部分表单；不恢复 JS heap、任意 DOM、运行任务或网络连接。
- cookies、localStorage、IndexedDB 由 Profile 的存储环境持久化，不能恢复到另一 Session。
- 同进程卸载用强引用维持 sessionStorage namespace，旧 Contents 销毁后才允许新实例接续。
- 跨 browser 的 sessionStorage 要另存 namespace 数据，目前未实现，导航 blob 不含这部分内容。
- POST 和不可恢复上传不能自动重放。当前明确拒绝自动恢复含 POST 的状态；确认重提交接口尚未接通。

未来恢复管理器必须持续检查最新期望状态；如果恢复期间页面已关闭或需求被取消，不能仍按旧请求重新拉起。恢复失败保留逻辑页面及失败原因。

## 内容视图、合成与 GPU 输出

保留 Views/Aura 平台适配和 content 视图，继续使用 ui::Compositor、cc、Viz、GPU。该选择减少 Windows 输入、widget 和 OOPIF 的平台重实现；不等于装配 Chrome 窗口产品层，也不等于无 Aura/无 HWND embedder。若以后更换内容视图后端，需要一并覆盖 view 工厂、native types、compositor transport、popup 与输入，不能只替换一个类。

示例用不旋转的 MaxRects 将多个 WebView 排入单个 atlas/window，带 padding，排布失败显式返回。当前 viewport 为固定大小；动态配置与重排能力尚不完整。viewport 使用 DIP，采集/atlas 使用像素，endpoint 显示时还有 letterbox 缩放。PMv2、DPI 切屏和命中变换须使用同一组几何信息。

当前输出链是 GPU capture → browser staging atlas → 三槽共享纹理 → endpoint 自有 cache。browser 在能打开 capture 资源的 adapter 上建立桥接 device，endpoint 按相同 LUID 导入。bridge 的两段 copy 用于增量更新与按全 atlas 帧率发布，代价是额外 GPU 带宽。

跨边界的同步约定是：真实 GPU 写完才可读，真实 GPU 读完才可复用。capture 源 lease 等桥接读完再归还，输出槽另等 endpoint consumed fence。消费端重绘自己的 cache，不重新读取已归还的 producer 槽。未来编码器也只持有 endpoint 自有输入纹理，不能用网络排队延长 browser 源纹理寿命。

Mojo 处理建立、共享句柄、配置、输入和资源重建；正常输出没有 browser↔endpoint 的逐帧通知、ready、present、release 或回复。Chromium 内部 frame/capture IPC 保留。句柄按目标进程复制，配置或资源代次变化重新导入；旧代停止发布，已提交 GPU 访问完成后才回收。设备移除不等于 fence 正常完成。

当前用共享内存发布帧元数据、布局和输入状态，不传像素、不替代 GPU Fence。共享内存不是协议的硬性前提：固定槽池可研究以 Fence value 编码槽位/序号，其余状态走控制通道。用户已质疑当前元数据机制，保留还是替换尚未决定；不能把当前实现写成不可变要求。

资源数量和队列必须有界。满时合并到最新内容或丢弃旧帧，GPU 等待提交到队列，UI 不做无界 CPU 等待。停止、resize、实例替换、adapter/device 变化都要收尾源租约和旧导入缓存。详细完成点、故障处理及当前 ABI 见 [GPU 输出](gpu-output.zh-CN.md)。原生 popup widget 的画面归属与输入命中必须属于父 WebView；目前 GPU 路径尚未验证这一点。

## 节拍与时钟

browser 负责网页合成与采集节拍，endpoint 调整输出需求、目标帧率和尺寸；网络 pacing 以后由 WebRTC 独立处理。当前保留 Chromium 合成节拍，限制 damage capture 与全 atlas 发布频率，不另造 external BeginFrame 时钟。需要自有时钟时应在 browser 本地合并未确认的 tick，仍不做逐帧跨进程往返。

静态页面保留最后图像，窗口重绘使用消费端 cache。订阅、恢复、resize 后需要 refresh。背压来自真实资源占用和 consumed fence，不来自 endpoint 的逐帧控制回复。保留采集时间戳及其单调时钟含义；未来音视频对齐不能直接用接收时刻替代采集时刻。

## 输入、焦点与 IME

browser 持有每个 Session 的页面焦点，并解析当前实际输入 widget。endpoint 采集设备事件，将稳定语义通过 Mojo 传入，未来可更换为 DataChannel。切换时先收尾旧 composition、按键和捕获，再 blur 旧目标、更新焦点代次并 focus 新目标，随后反馈文本状态。可见性与焦点分别管理；隐藏、丢弃、卸载、失效或断线都要主动清理输入。

键盘发给实际 focused widget，保留物理扫描码、DomCode、DomKey、修饰键、repeat 及独立字符事件，避免与 IME 重复插入。鼠标/滚轮走 InputEventRouter 的 OOPIF 路由；宿主还需处理 popup 与 capture 的目标选择。移动可合并，按键、点击、composition 保序。当前远程触控复用 TouchEmulator 的手势和最终 ACK 路径，首次触点异步命中 OOPIF 后锁定序列目标；pending 时明确 busy，不接受后再乱序重放。

坐标从 endpoint 客户区像素，经 letterbox 和 atlas 布局换算到 viewport DIP，browser 再转换到目标 widget/screen。旧输出代次不能用于新布局。Fence 模式保持 endpoint 的原生键盘焦点，browser 设置逻辑 page focus，避免不可见 capture HWND 抢走输入。

IME 接口分别表达 set composition、commit、cancel、finish，映射到 content 的实际 Ime 方法。文本、选区、替换范围和 composition spans 使用 UTF-16 语义，不能拆开代理对。当前支持文本及 composition 内选区，尚未提供完整 replacement range/span 协议。

TextInputManager 是文本状态来源，恢复或 iframe 焦点改变后重新取得 active widget。caret/selection 几何统一反馈 viewport DIP，不泄露密码周边文本。普通失焦完成 composition，导航/销毁取消旧文档 composition。当前 IMM client 根据 caret 定位候选窗；逐字符边界反馈及真实输入法行为仍需补齐和验证。

## 页面请求与浏览器功能

页面请求由 browser 保存原始 callback、文档身份及取消语义。控制端回复只对仍有效的请求生效；导航、frame 删除、discard、卸载或断线时完成一次取消，不把旧请求交给新文档。下载等已脱离文档的工作按自身寿命管理。当前测试协议轮询 pending/events；正式事件协议不受这个 demo 形式限制。

| 能力 | 设计边界与当前进度 |
| --- | --- |
| 新标签／window.open | 目标是先执行同步 popup 策略、承接 pending WebView，再由管理方配置 viewport；当前固定拓扑明确阻止并报告事件，动态承接未实现 |
| 页面 popup widget | 应在父 WebView 内保持子 surface 层次、位置及命中；Aura 路径保留，GPU 输出仍待验证 |
| context menu／tooltip | 结构化展示与选择/取消，动作绑定原 frame/document；菜单已接，tooltip 只有报告入口，缺原生 hook |
| fullscreen | browser 报告请求/状态，管理方调整 viewport；当前 pseudo fullscreen，不创建额外本地窗口 |
| pointer／keyboard lock | 授权后须支持相对输入、锁定状态及退出/断线释放；当前明确拒绝，未接相对输入 |
| JS dialog／beforeunload | 异步远端确认；beforeunload 还参与正常逻辑关闭，不能等同于强制卸载 |
| 文件上传 | 上层返回服务端可访问文件；目录上传保留相对路径。当前仅普通文件与异步验证，目录未接 |
| 下载 | Profile 会话文件区、进度、取消、结果及文件引用；独立于发起页面。当前 HTTPS-only 与系统 quarantine，不含 SafeBrowsing |
| 权限 | 自有 origin/embedding 规则，不弹本地 prompt；当前默认 deny，有限类型可配置，不自动装配对应 API 服务 |
| HTTP／代理认证、TLS／客户端证书 | 专用请求与回调，不混入通用权限；当前缺远端应答接口 |
| 剪贴板 | 文本读写与实际复制/粘贴流程对接；已有编辑命令，跨端文本同步协议未完成 |
| 查找／缩放 | 复用 WebContents/HostZoomMap；命令与异步 find 结果已接，页面级缩放不影响其他 WebView |
| PDF／打印 | PDF 作为可选模块；打印 PDF 结果进入下载，物理打印机不接。当前均未装配 |
| File System Access | 限制持久文件/目录 handle，普通 file input 独立；明确禁用策略仍需接入核对 |
| service worker／后台任务 | 保留 content 能力，寿命归 Session/Profile，关闭单页不清整 Session；background sync 等服务未完整装配 |
| DevTools | 保留本机 CDP，不自动创建调试窗口；当前附加期间拒绝远程 touch，避免争用 emulator |

UA/Client Hints 的目标是 Google Chrome 的品牌、版本、GREASE、平台与覆盖行为；window.chrome 使用 renderer native bindings，缺少服务时给对应 stub。具体表面见 [兼容性](browser-compatibility.md)。不引入 Chrome 的密码/自动填充、历史/书签、拼写、翻译和扩展产品装配；内部导航栈照常保留。设备、WebAuthn、通知和 accessibility 的额外产品服务当前不装配，不等于主动删除 content 自身基础设施。

## 后续媒体边界（当前不实施）

下面保存媒体扩展所需的接口约束；不作为现在接线编码器、音频或 WebRTC 的授权。

视频继续使用全 atlas 的单视频通道，endpoint 从自有纹理进入 VPP/Copy 和 NV12 输入池，编码器消费其自有资源。浏览器源读取完成即可归还，不等编码或网络。库层先明确可独立消费的 ABI、工具链与 runtime，随后才接媒体源和传输。

音频按网页输出组采集，不录 Windows 系统混音。可用 WebContents 的 audio group 和 Audio service loopback 承接该页及 iframe 当前/未来输出流；browser 管采集寿命，endpoint 负责各页缓冲、重采样和 Session 内混音。样本使用音频共享管道和其信号机制，GPU Fence 不承担音频同步；这也不决定视频元数据是否使用共享内存。

目标混音格式为48kHz、stereo、10ms，即每块480 frames；不同输入格式通过 FIFO/resampler 整形。每 Session 一条混合 Opus track，不跨 Tenant/Session 混音。后台音乐不会因焦点切换停止；页面发声、订阅、远端 mute/gain 和服务端扬声器静音分别管理。服务端本地静音应通过音频 group LocalMuter 实现，保留 loopback，不能全局静音系统；当前尚未接 LocalMuter，也未承诺浏览器现有网页播放已静音。

音频线程不做同步 Mojo、磁盘或长时间 GPU/锁等待；队列有界，过载丢旧、缺样补静音。discard/unload、实例替换、Audio service 重启或格式变化时重建实际流、清旧 FIFO，并重新对齐单调时间线。保留采集时间供音视频及 RTP/RTCP 时钟映射使用。第一阶段只考虑网页输出，媒体设备输入不接，getUserMedia 必须给明确结果。

## 实施与验收边界

以可构建的小步接通执行、输出、输入和生命周期，再接管理恢复与页面功能；每项同时记录实际接线与验证范围。当前完成情况只在 [当前状态](current-state.zh-CN.md) 汇总，不能用设计目标代替运行证据。

后续场景应覆盖多页同时呈现、OOPIF 输入、中文预编辑与 emoji、选区替换、冻结/原地 discard/卸载后的恢复、browser 重启后重新承接逻辑清单、resize 和 GPU 重建；背景音频场景只在媒体范围开启后执行。场景清单不代表已经执行，实际证据单独记录。
