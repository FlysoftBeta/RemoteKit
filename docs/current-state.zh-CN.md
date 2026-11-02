# RemoteKit当前状态

更新：2026-11-02。Windows x64；Chromium官方157.0.8103.15，固定基线`1aa07b638799e59656559ae6c6649d4b197f555e`，复用out/dev、out/rel增量构建。Chrome89继续支持。

## 本轮结果

双租户45秒同组实际canvas **51.69/51.73FPS，Pixel marker p95 76/79ms**，每路45个有效CRC。条件为1920×1080/DPR1、atlas/编码1936×1088、RTT10ms、每peer48Mbps，QSV TU7/LPON/VBR/depth1、36/max44Mbps；接收端Chromium157 headless、UHD630硬件H264/GPU canvas、fake60、immutable frame/fifo2及Worker CRC。Marker终点是canvas提交。

用户已取消额外120秒稳定复验与单租户重复复验。后续产品改造做功能检查，不重复跑分；完整配对和证据见[性能记录](streaming-experiments.zh-CN.md)。同条件headed→headless的Intel3D从93.55%降至64.33%，其中包含RDP显示链开销的消除。

## 已实现并联调

| 范围 | 当前行为与证据 |
|---|---|
| 产品Control | SQLite多用户、首个正式用户管理员、服务端注册口令、独立Window/tab、鉴权WS、单Viewer租约、对账；普通入口不使用匿名HTTP轮询 |
| Viewer | MUI沉浸外壳、桌面split/窄屏聚焦、覆盖式设置、实际内容尺寸；普通页不暴露实验面板、不存localStorage设置 |
| 页面功能 | 每origin仅UA/CH、首次请求/redirect/history/restore正确；真实popup收养保opener/sessionStorage、自然close；标准dialog和导航beforeunload |
| 生命周期 | 默认120秒隐藏回收，Browser完整canDiscard守卫、真实discard/restore；Viewer visibility与RTC渲染需求分离；离线snapshot/维护不重启Browser |
| 输入 | Chrome89/157真实H264 canvas、鼠标、dialog回复及恢复；重载/重新登录/接管后输入序号分层修复并复验，旧token/epoch与重复输入仍拒绝 |
| 自适应 | 三质量档、ClientScale、面积预算、有效>300ms反馈降分辨率和迟滞恢复；真实DC采集时钟与paint形成WS反馈，静态尾帧排重 |
| 编码与GPU | QSV TU7/LPON/VBR/depth1、16对齐、auto输入在兼容QSV路径选shared；Viz直写目标及几何fallback；普通码率Reset不重开序列 |
| SDK/网络 | 真正libwebrtc PeerConnection/SDP/ICE/DTLS/SCTP、native纹理租约、wire RTP；每Session运行媒体策略保留拥塞控制 |
| 测量设施 | 有界Browser/SDK/Endpoint trace、GPU pass计时、ETW/引擎占用、分块metrics校验、真实paint/CRC与时钟置信度；固定实验独立于产品策略 |

Sol已实际检查Chrome89与157的MUI/H264/输入、用户隔离、多Window/窄屏、UA、popup、dialog、质量/ClientScale、120秒memory saver、WS断线/接管。Chrome89保留兼容video路径；新版接收能力与共享呈现验证见下文。原产品报告：[产品运行QA](../develop/docs/product-runtime-qa.md)。原生Windows输入法完整候选窗行为不能由协议composition检查替代。

注册管理新增批次：首个正式账号为管理员，更多→管理员面板配置后续注册口令；旧数据库迁移最早正式用户，诊断账号不参与。Control全122项、类型检查、生产构建与smoke通过。Sol实际验证首注管理员、设置/错误/正确口令、普通用户入口隔离及独立登录；390×844窄屏无溢出，管理面板保存前中后内容区不变。账号密码和注册口令独立，配置只保存加盐hash。

## Viewer连接与画质改进

普通产品改为trickle ICE，能力探测预热并缓存；模拟网络保留原完整收集与relay路径。真实本机4K检查中，冷源首canvas约1019.8ms、已运行源重连约368.6ms，ICE分别124.2/85.5ms。冷源从首次尝试打开输出到成功约561.7ms（含viewport/可见性准备），编码器配置约160.5ms；这些是单次功能检查，不是旧新版平均耗时对照。

现代接收端按能力选择H264 5.2/5.1/4.2；Chrome89保留4.2兼容。高画质取消固定4K面积缩放，优先viewport×ClientScale完整尺寸。实际5.2 source/encoded/decoded均3856×2176（含atlas边距），内容canvas3840×2160、mediaScale1。受控5.1仍保持该尺寸，名义50FPS对应有效29FPS上限，3秒实际解码约27.55FPS；源、采集与编码预算一致。自动档保持帧率优先。

canvas回退保留多合格平面共享WebGL纹理与画布，单平面/Chrome89或失败使用2D。此前同流四平面对照中，客户端CPU约1.217→0.418核、3D约25.94%→10.59%，绘制58.60→59.97FPS；该对照编码1980×1110，不能当完整4K性能。原canvas集成已验证四窗2912×1632不下采样、真实可见ROI的Marker CRC、静态非等比缩放、上下文丢失和单次刷新恢复。默认video的新证据见下文。

本批统一Browser/SDK增量构建、Endpoint九套CPU测试、Control全148项及生产构建/smoke通过。细节见[共享呈现联调](../develop/docs/shared-presentation-runtime.md)、[候选对照](../develop/docs/viewer-presentation-candidates.md)及[连接画质实现](../develop/docs/connection-quality-implementation.md)。

标签页加载spinner已修复：原通用span规则把MUI图标当标题扩宽并裁切。标题样式现独立，桌面与390px窄屏实测图标均13×13px，旋转中心稳定、加载结束正常消失；见[视觉检查](../develop/docs/loading-spinner-runtime-qa.md)。

此前video+clip-path固定1936×816/50FPS、157接收端四组对照中，单video接收CPU约0.291核、3D计数0%，WebGL为0.343核/11.50%；双video未见解码负载翻倍。源/解码均约50FPS，没有呈现帧率优势，也未复现用户Chrome138的12FPS。该历史实验不代表正式默认video的运行结果，见[对照记录](../develop/docs/video-clip-evaluation.md)。

## 默认video实现批次

正式Viewer已接入默认video协商，每个可见平面共享接收track并独立验证RTP/epoch。客户端内容bounds决定目标布局，服务端atlas只用于源裁剪；video关闭controls、画中画、远程播放与额外媒体交互，声音保留独立管线。默认不启动MSTP/canvas绘制，能力或协议失败保留canvas回退。

Endpoint在真正编码结果发送处设布局屏障，覆盖旧inflight结果；客户端隐藏video、撤销输入ready并跨两rAF确认后，当前布局首个成功关键帧才放行。静态重发保持实际纹理epoch/尺寸，不能给旧纹理套新布局。统计区分video compositor计数增量和canvas JS提交，rVFC回调数不当显示FPS。

Native Debug/Release增量构建、12套CPU及Control179项、类型检查、生产构建/smoke已通过，包含后台切换期间canvas回退动作恢复及旧play Promise拒绝隔离。89/157正式video单窗/split、bounds与输入、resize、157 DPR2、重连、实际音频PCM及文件共存已通过；默认MSTP/viewport draw计数均为0。同尺寸1456×832 atlas的双窗权重交换使A/B源位置真正互换，客户端仍各自正确裁剪。

上述8423204首版验收仅覆盖点击等输入，遗漏连续滚轮与原生scrollbar拖拽，不能据此宣称完整输入通过。用户反馈后复现并修复三处问题：稳定viewId注册避免focus/导航拆除video；wheel先完成焦点确认，并在Browser复用Aura滚动序列处理后再路由；mouse move按held modifiers构造Blink button以保留原生拖动。观察到的闪断是video/srcObject重建，原RTC并未重连。

修复版Control182项、类型检查、生产构建与smoke通过，Browser out/dev增量通过。89/157真实连续组均通过：失焦后wheel、连续burst、间隔后重开、nested wheel、根/nested scrollbar拖动、跨Window滚动、resize与Viewer reload后滚动；验证了真实scrollY/scrollTop及DOM事件。focus/导航/resize保持video、srcObject与RTC身份，旧epoch ACK暂存期间客户端拒绝旧输入并在放行后恢复。完整证据见[输入与生命周期回归](../develop/docs/video-input-runtime-qa.md)。本次没有重跑历史性能矩阵；音频/上传仍引用首版功能组，不冒充新增复验。

真实检查发现并修复一次静态resize空layout的源码原因：Viz失败capture未结算Oracle pending，导致无damage的刷新一直被拒绝。0007现统一恰一次结算成功/失败交付；Browser与小测试目标已增量构建，3个直接调用真实交付/Oracle的CPU回归通过，patchset hash与隔离撤回/重放通过。修复后原split→focused→静态首metadata延迟→1100→390序列在2秒内恢复epoch28/gen10和video ready；本次运行未自然触发GPU取消，取消机制由CPU注入回归验证。此前3次诊断未复现不算修复证据。完整记录及截图见[默认video运行QA](../develop/docs/default-video-runtime-qa.md)。

触控保留客户端采样时间与有界历史，服务端不再用包到达间隔估计手势；0008区分同步完成回调与真正派发拒绝，0009修复无屏幕时零PPI导致的惯性失效。服务构建固定逻辑PPI96与generic-desktop手势配置，客户端DPR和媒体帧率预算独立，native demo保留宿主适配。最终正常/途中70ms停顿/抬手100ms延迟三组滚动为502/501/502 DIP，均有约404–418ms惯性、零拒绝；嵌套滚动、OOPIF、touch-action/preventDefault、取消和DPR2坐标另有真实检查。新增Chromium unit用例未单独构建content_unittests，运行证据来自实际生产链路。见[可复用检查入口](touch-source-qa.md)与[触控运行记录](../develop/docs/touch-source-runtime-qa.md)。

## 新增音频与文件

Browser真实音频播放target、独立PCM共享环和SDK Opus发送已实现，不依赖系统声音捕获。整个Viewer统一保存左右声道选择。157已测实际PCM声道门控与重连，89已测实际PCM、静音保存与恢复；一次闪光/声脉冲点测音频比canvas晚5.6ms，尚无长期同步或真正网络音频gap实验。

真实网页文件选择已完成单/多文件、Unicode名称与字节、零字节、取消、导航失效、旧lease ticket拒绝以及同文档history后的延迟读取；89单文件通过。157桌面与390px窄屏dialog/菜单通过视觉检查。

摄像头改为不可变ImageBitmap交给OffscreenCanvas Worker，同一帧评分与编码。首次冷burst同步p95从首版31.2ms降为157的1.5ms、89的5.35ms；各6次采样，均无>50ms长任务。两版显示3张1280×720候选，89拍摄中取消后轨道、Worker与图像资源释放。使用fake-camera，实体设备成像效果和旧能力fallback性能尚未验证；见[摄像头优化](../develop/docs/camera-bitmap-worker-optimization.md)。

Browser/SDK已增量构建，Endpoint11套CPU通过；最终Control171项、类型检查、生产构建与启动smoke全部通过，包含文件单选与摄像头fallback修正。实现边界见[音频与文件](audio-and-files.zh-CN.md)，功能证据见[运行QA](../develop/docs/audio-files-runtime-qa2.md)。

## 当前默认与资源规则

服务端每页无页面HWND的Aura离屏宿主，不走屏幕Present；进程仍有Chromium辅助SingletonHwnd。产品默认启用已验证捕获优化，unsupported几何走明确fallback。Browser↔Endpoint稳态没有逐帧Mojo；真实GPU完成与三槽租约不因重建/故障而放宽。

默认service针对UHD630选择QSV；显式encoder=auto保留copy和NVENC回退，显式NVENC仍支持。普通客户端按实际能力选择接收level；高码率请求不能超越接收协商或网络上限。更多状态归属与流程见[系统设计](architecture.zh-CN.md)、[Control设计](control-plane.zh-CN.md)、[GPU输出](gpu-output.zh-CN.md)。

## 审查修复

审查修复版已修复串行恢复阻塞、恢复快照遗漏、token注销作用域、atlas几何边界、反馈序号重置、关闭墓碑积累及两项关闭/回复竞态。四页恢复ensure约0.204秒，其他Tenant观察不再等待；真实冷恢复验证了history、表单和滚动位置，POST只回退GET。证据见develop/tmp/recovery-regression与geometry-regression。

## 保留差距


- 每Session当前一个Profile；跨Browser sessionStorage、完整IME replacement/span、原生popup widget合成/命中覆盖，以及目录上传、认证/证书、跨端剪贴板、PDF/打印等仍是保留差距。官方注入触摸路径关闭了原生longpress/showpress定时器，原生长按功能尚未补齐。
- 本机无NVIDIA硬件，NVENC只有编译/接口边界检查。音频真实网络gap、autoplay拒绝及上传断传/commit竞态未作运行验证；实体摄像头效果和能力fallback性能仍待验证。
- 生产capture-end→paint是带时钟置信度的估算；Pixel marker测量及物理屏幕点亮是不同终点。

## 发布与入口

8423204默认video首版已提交、推送并上传。随后发现的滚轮、原生scrollbar与video生命周期缺陷已按上述范围修复和真实验证，修正版必须从新的本地提交重新打包上传；首版取件码744995不代表修正版。实现契约见[默认video计划](../develop/docs/default-video-plan.md)，起始状态见[完整交接](../develop/docs/HANDOFF-2026-11-02-default-video.zh-CN.md)。本次发布优先上传，GitHub推送尽力而为；长期提交推送约定不变。

串流包包含Browser、Endpoint、Node及Control生产runtime，完整解压后运行run.cmd。打包执行smoke、逐文件manifest与ZIP校验，不携带开发Profile、数据、凭据或PDB；smoke覆盖服务启动与管理，媒体功能依据对应真实运行报告。版本、取件码与最终hash记录在本机develop/tmp的release delivery文件，并随交付回复提供。先前Astra全链审查和有界修复已完成，后续新增功能按实际范围验证发布。

[构建运行](../README.md) · [Control](../control/README.md) · [打包](packaging.zh-CN.md) · [接口](streaming-protocol.md) · [SDK](sdk.md) · [历史选项归档](experiments-archive.zh-CN.md)
