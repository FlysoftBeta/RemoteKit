# RemoteKit系统设计

本文说明当前职责与资源规则；验证结果见[当前状态](current-state.zh-CN.md)。长期目标与尚未装配的能力分开列出，不能把当前限制固化为产品需求。

## 组件与隔离

| 组件 | 职责 |
|---|---|
| Control | 用户、Window/tab、地址意图、设置、鉴权、Viewer租约、信令、对账与Memory Saver策略 |
| Endpoint | Tenant→Session、Browser进程与恢复文件、GPU消费/转换、编码、WebRTC、输入校验与路由 |
| Browser | 独立content embedder、Profile/WebContents、页面/输入/生命周期/恢复、离屏采集与源资源 |
| Chromium服务 | Renderer、网络、Viz/GPU及已有网页运行基础设施 |
| Client | MUI工作区、实际内容区观测、直接WebRTC接收/输入、呈现与指标 |

每User当前拥有一个Tenant/Session；每Session独立Browser进程、Profile路径、恢复数据及atlas，不能跨租户混用。Session下多Profile是保留目标，当前只支持一个。Window/tab是产品关系，不是数据隔离边界。

Browser使用固定Chromium GN构建，不装配Chrome Browser/TabStripModel/BrowserView；Endpoint用独立CMake/Ninja，不包含Chromium私有头。SDK以C ABI连接Mojo及libwebrtc，跨DLL不传C++运行时对象。独立endpoint_service是默认入口，旧Browser harness/native client仅显式demo目标保留。

Control启动Endpoint并以JSONL管理；Endpoint持有Browser本地Mojo连接。网络用户只通过已认证Control/RTC会话进入，不把Session ID当凭据。详细接口见[串流协议](streaming-protocol.md)、[本地Browser协议](control-protocol.md)、[SDK](sdk.md)。

## 产品状态、生命周期与恢复

Control保存产品真相，Endpoint Session/Browser保存Chromium专用恢复状态。WebView是稳定逻辑身份；WebContents是可丢弃、卸载和重建的执行实例。实例、文档、焦点、操作、输出分别有代次，旧请求不能改投新对象。

产品visible、焦点、渲染需求、保留执行实例是不同状态。Viewer WS断开使visible=false；RTC不可用停止渲染/编码，不改产品visible。源输出故障/重建/暂停以新epoch空layout撤销Client旧ready，恢复后匹配新帧才允许输入。

Control默认回收隐藏120秒且Browser canDiscard允许的页。Browser以实时媒体/设备/导航/锁/关联页面/输入/请求等完整守卫决定能否执行，并等待真实renderer完成。accepted、pending、actual、last_lifecycle分开；失败/超时不能冒充完成。相关联的活跃Contents可能阻止单页回收。

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

已验证的单plane/DPR1路径由Viz直接写三个拥有CSI的共享目标；不满足条件时使用既有捕获/桥接路径。Endpoint在兼容QSV/external/depth1时直接租用BGRA槽，其他模式使用自有cache。NV12转换和异步编码持有各自真实资源租约，不能用COM引用替代防覆盖协议。

两个完成域必须独立正确：源capture lease保护Viz资源，共享输出槽由consumed保护。真实GPU写完才ready，真实读完才可复用。CPU发布、copy返回、BeginFrame ACK、device loss的UINT64_MAX都不是完成证明。固定三槽及有界队列提供背压；详细状态和退役规则见[GPU输出](gpu-output.zh-CN.md)。

browser↔Endpoint没有逐帧ready/present/release Mojo。共享内存目前只承载一致元数据与布局，不传像素；这是实现选择，不是用户要求必须使用。Chromium内部IPC及Endpoint↔Client帧元数据属于不同边界。

Endpoint使用oneVPL异步H264或显式NVENC，libwebrtc负责网络控制与pacing。目标部署UHD630默认QSV TU7/LPON/VBR/depth1、高码率及16像素atlas对齐；显式auto/NVENC保留。产品媒体策略按Session更新，实际码率继续服从WebRTC拥塞控制，普通rate Reset不重开序列。

## 节拍、输入与测量

Browser本地高精度pacer驱动external BeginFrame，每host最多一个未ACK tick；过期tick合并，不向Endpoint逐帧索取刷新。静态按需出帧，Endpoint空闲后做一次尾IDR，不无限重复。源预算结合显示/网络反馈，Client队列及编码队列有界。

输入经DataChannel进入Endpoint，校验Session/peer、页面完整token和输出代次；连接内客户端序号与Session持续Browser序号分层，重登录不会回退Browser序号。焦点确认先于排队输入，键鼠/IME/touch保序，移动可合并。Browser使用实际focused widget及OOPIF路由，触控沿官方ACK/gesture路径。

坐标按Client CSS、letterbox、编码矩形、mediaScale/DPR转换到viewport DIP，再到widget/screen。IME的composition/commit/cancel/finish使用UTF-16；完整replacement range/span、逐字符候选几何仍有扩展空间。

Stats区分源、采集、编码、解码及实际canvas提交。生产采集完成→paint估算使用QPC/UTC与Client时钟校准，排除静态重复和低置信度；Pixel marker带CRC作端到端实验，两者不混称。分段p95不可直接相加，见[测量设施](streaming-experiments.zh-CN.md)。

## 页面能力与保留目标

页面回调由Browser持有，按文档身份取消/回复。新窗口收养真实WebContents，保留opener；alert/confirm/prompt/beforeunload走产品Dialog。站点UA/CH在导航/redirect起点选择，viewport和输入设备特征独立。UA/window.chrome的兼容目标与当前覆盖见[兼容性](browser-compatibility.md)。

以下差距保留，不因旧demo拒绝或没有UI就视为用户取消：多Profile；跨Browser sessionStorage；完整IME replacement/span与真实输入法专项；原生popup widget像素/命中覆盖；目录上传、远端HTTP/代理认证与证书选择、完整跨端剪贴板、PDF/打印等产品装配。现有普通文件/下载/权限/find/zoom/edit等机制的接入边界见当前状态和Browser协议。

音频已接入Browser自己的播放目标，不录制系统混音。Browser在Session内重采样/混音为48kHz stereo、10ms/480帧块，通过独立共享音频环交给Endpoint/SDK的Opus track；不得跨Session混音。文件选择由Browser真实FileSelectListener完成，Endpoint Session托管文件生命周期。产品设置、上传流程与资源边界见[音频与文件](audio-and-files.zh-CN.md)，验收范围见当前状态。
