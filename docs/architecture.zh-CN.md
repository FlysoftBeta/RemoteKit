# RemoteKit系统设计

本文说明当前职责与资源规则；验证结果见[当前状态](current-state.zh-CN.md)。长期目标与尚未装配的能力分开列出，不能把当前限制固化为产品需求。

## 组件与隔离

| 组件 | 职责 |
|---|---|
| Control | 用户、Window/tab、地址意图、设置、鉴权、Viewer租约、信令、对账与Memory Saver策略 |
| Endpoint | Tenant→Session、Browser进程与恢复文件、GPU消费/转换、编码、WebRTC、输入校验与路由 |
| Browser | 独立content embedder、Profile/WebContents、页面/输入/生命周期/恢复、OSR绘制与atlas合成 |
| Chromium服务 | Renderer、网络、Viz/GPU及已有网页运行基础设施 |
| Client | MUI工作区、实际内容区观测、直接WebRTC接收/输入、呈现与指标 |

每User当前拥有一个Tenant/Session；每Session独立Browser进程、Profile路径、恢复数据及atlas，不能跨租户混用。Session下多Profile是保留目标，当前只支持一个。Window/tab是产品关系，不是数据隔离边界。

Browser使用固定Chromium GN构建，不装配Chrome Browser/TabStripModel/BrowserView；Endpoint用独立CMake/Ninja，不包含Chromium私有头。SDK以C ABI连接Mojo及libwebrtc，跨DLL不传C++运行时对象。独立endpoint_service是默认入口，旧Browser harness/native client仅显式demo目标保留。

默认单机包由Control启动Endpoint并以JSONL管理；远端模式由独立Endpoint主动建立认证WSS管理连接。Control与Endpoint不要求共享文件系统或时钟，管理断线不销毁已有Session/RTC，但立即撤销正常Viewer产品权限，恢复后由Control重新授权。Endpoint持有Browser本地Mojo连接。网络用户只通过已认证Control/RTC会话进入，不把Session ID当凭据。Cookie身份与工作区解锁权限分开；摄像头RGB与人脸计算由Endpoint处理，Control发起挑战并裁定授权，见[高级认证](authentication.zh-CN.md)。详细接口见[串流协议](streaming-protocol.md)、[本地Browser协议](control-protocol.md)、[SDK](sdk.md)。

## 产品状态、生命周期与恢复

Control保存产品真相，Endpoint Session/Browser保存Chromium专用恢复状态。WebView是稳定逻辑身份；WebContents是可丢弃、卸载和重建的执行实例。实例、文档、焦点、操作、输出分别有代次，旧请求不能改投新对象。

产品visible、焦点、渲染需求、保留执行实例是不同状态。Viewer WS断开使visible=false；RTC不可用停止渲染/编码，不改产品visible。源输出故障/重建/暂停以新epoch空layout撤销Client旧ready，恢复后匹配新帧才允许输入。

Control默认对持续安全隐藏30秒的页面冻结，120秒丢弃；在线与Viewer断线共用单调时钟计时及Browser canDiscard资格，保护条件、实例替换或长观察间断清空计时。基础后台调度及进程优先级由content visibility驱动，多个可见Window不因失焦降为hidden。Browser执行点复查实时媒体/设备/导航/锁/关联页面/输入/请求等守卫，并等待真实renderer完成。accepted、pending、actual、last_lifecycle分开；失败/超时不能冒充完成。相关联的活跃Contents可能阻止单页回收，详细规则见[Control设计](control-plane.zh-CN.md#可见性与memory-saver)。

| 操作 | 实际行为 |
|---|---|
| freeze | SetPageFrozen及renderer ACK |
| discard | 保留WebContents/controller，官方Discard；恢复LoadIfNecessary并等待非错误主frame commit |
| unload | 保存导航关联后销毁执行实例，保留逻辑WebView |
| restore | 为原WebView恢复/重建实例、应用配置，完成后才可见 |
| close | 正常beforeunload确认后移除逻辑页；与回收不同 |

导航恢复保留history、选中索引和renderer已报告PageState，绑定格式/Chromium版本/Session/Profile。同BrowserContext卸载可保留sessionStorage namespace；跨Browser的sessionStorage尚未恢复。PageState不恢复任意DOM、JS heap或网络连接。POST与不可恢复上传不自动重放。

在线对账先同步站点规则/媒体策略，再ensure和恢复页面；缺失对象用有限产品地址重建。离线snapshot不启动Browser，离线维护带requireRunning消除检查后退出的竞态。自然关闭以持久事件/ACK区分，不按普通missing重建。完整产品流程见[Control设计](control-plane.zh-CN.md)。

## 渲染、GPU和编码

服务端每WebView使用无页面HWND的Aura宿主和null-widget compositor，目标从创建时就是离屏纹理，不经过本地屏幕Present。Aura继续承接输入/IME/OOPIF。Browser进程仍有Chromium系统辅助SingletonHwnd；原生demo保留Views窗口。

不旋转MaxRects把可见平面排入atlas，含padding。viewport为DIP，页面DPR决定实际backing，atlas/编码像素及mediaScale另记；命中排除padding和letterbox。产品内容区尺寸来自Viewer，不把平板UA变成固定viewport模拟。

正式Viewer默认协商video呈现，各可见Window的video共享同一接收track；客户端内容bounds决定目标布局，atlas仅决定源裁剪。Endpoint在编码结果真正发布前建立布局屏障，等Client隐藏旧画面并确认后，以当前布局关键帧恢复。每个video自身匹配真实RTP/epoch后才恢复输入。稳态不增加逐帧握手，不运行额外MSTP/canvas绘制；能力或协议失败保留canvas回退，详见[串流协议](streaming-protocol.md)。

新路径使用专用Viz OSR OutputDevice直接绘制每plane共享BGRA目标，Browser按当前布局GPU合成为Endpoint指定的atlas Slot。旧capture、CopyOutput及桥接fallback已删除。NV12转换和异步编码持有真实资源租约，不能用COM引用替代防覆盖协议；新路径验收状态见[当前状态](current-state.zh-CN.md)。

plane绘制与atlas合成通过实际GPU Fence排序；每Slot独立ready/consumed Fence保护写入、读取及编码租约。当前最大容量四槽，活动深度有界调整，缩减不抢占在途Slot。CPU发布、提交返回、BeginFrame ACK、device loss的UINT64_MAX都不是完成证明。详细状态和退役规则见[Comp / Rend](rendering.zh-CN.md)。

Endpoint Comp通过专用异步Mojo向Browser Rend发送带代次、Slot、Value的Begin。Rend返回Reject或Signal该Slot的真实GPU Fence，成功没有逐帧ready/present/release Mojo。共享内存只承载一致元数据与布局，不传像素。换代Stop/Stopped屏障证明请求终结，不代替GPU完成；Chromium内部IPC及Endpoint↔Client帧元数据属于不同边界。

Endpoint使用oneVPL异步H264或显式NVENC，libwebrtc负责拥塞控制及媒体适配。质量三档只对应DegradationPreference；原生AdaptFrame决定缩放/丢帧，SetRates驱动硬件码率与帧率。QSV纯码率Reset保持序列，改变帧率时更新VUI时基并请求关键帧。协商与硬件上限仍有效。

## 节拍、输入与测量

Endpoint Comp拥有节拍，依据客户端能力、WebRTC限制与Slot压力发送Begin，Browser只按请求经BeginFrameSource驱动root。每root保持Chromium顺序interval，多Slot可同时处于渲染、GPU与编码阶段。静态空闲后只做一次尾IDR，同内容刷新不生成新内容身份。

输入经DataChannel进入Endpoint，校验Session/peer、页面完整token和输出代次；连接内客户端序号与Session持续Browser序号分层，重登录不会回退Browser序号。焦点确认先于排队输入，键鼠/IME/touch保序，移动只在不丢语义时合并。Client-v1触控由Client计算候选手势与完整惯性，Browser保留官方逐包ACK、preventDefault和touch-action裁决及OOPIF路由；不并行运行两套默认手势识别，见[Client手势](client-gestures.zh-CN.md)。

常规产品动作亦经当前RTC送Endpoint，再由Control唯一提交器受理、持久化和对账。操作收据与乐观界面不是第二份产品真相；受理、运行、提交、拒绝和结果未知分开，未知操作不自动重放。空起始页可以没有源渲染需求，但保留Session数据通道，新增网页不因此重建连接。

坐标按Client CSS、letterbox、编码矩形、各轴mediaScaleX/Y与DPR转换到viewport DIP，再到widget/screen，覆盖WebRTC尺寸对齐的轴向取整差异。IME的composition/commit/cancel/finish使用UTF-16；完整replacement range/span、逐字符候选几何仍有扩展空间。

Stats区分源提交、实际Fence完成观察、编码、解码、video compositor提交观察及canvas JS提交；rVFC回调次数不代表显示FPS。有效源完成时间存在时，呈现估算使用QPC/UTC与Client时钟校准，排除静态重复和低置信度；新OSR路径目前缺此时间戳，相应样本省略。Pixel marker带CRC可独立作端到端实验，两者不混称，也都不证明物理屏幕点亮。分段p95不可直接相加，见[测量设施](streaming-experiments.zh-CN.md)。

## 页面能力与保留目标

页面回调由Browser持有，按文档身份取消/回复。新窗口收养真实WebContents，保留opener；alert/confirm/prompt/beforeunload走产品Dialog。站点UA/CH在导航/redirect起点选择，viewport和输入设备特征独立。UA/window.chrome的兼容目标与当前覆盖见[兼容性](browser-compatibility.md)。

以下差距保留，不因旧demo拒绝或没有UI就视为用户取消：多Profile；跨Browser sessionStorage；完整IME replacement/span与真实输入法专项；原生popup widget像素/命中覆盖；目录上传、远端HTTP/代理认证与证书选择、完整跨端剪贴板、PDF/打印等产品装配。现有普通文件/下载/权限/find/zoom/edit等机制的接入边界见当前状态和Browser协议。

音频已接入Browser自己的播放目标，不录制系统混音。Browser在Session内重采样/混音为48kHz stereo、10ms/480帧块，通过独立共享音频环交给Endpoint/SDK的Opus track；不得跨Session混音。文件选择由Browser真实FileSelectListener完成，Endpoint Session托管文件生命周期。产品设置、上传流程与资源边界见[音频与文件](audio-and-files.zh-CN.md)，验收范围见当前状态。
