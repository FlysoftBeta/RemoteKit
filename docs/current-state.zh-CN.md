# RemoteKit当前状态

更新：2026-11-02。Windows x64；Chromium官方157.0.8103.15，固定基线`1aa07b638799e59656559ae6c6649d4b197f555e`，复用out/dev、out/rel增量构建。Chrome89继续支持。

## 本轮结果

双租户45秒同组实际canvas **51.69/51.73FPS，Pixel marker p95 76/79ms**，每路45个有效CRC。条件为1920×1080/DPR1、atlas/编码1936×1088、RTT10ms、每peer48Mbps，QSV TU7/LPON/VBR/depth1、36/max44Mbps；接收端Chromium157 headless、UHD630硬件H264/GPU canvas、fake60、immutable frame/fifo2及Worker CRC。Marker终点是canvas提交。

用户已取消额外120秒稳定复验与单租户重复复验。后续产品改造做功能检查，不重复跑分；完整配对和证据见[性能记录](streaming-experiments.zh-CN.md)。同条件headed→headless的Intel3D从93.55%降至64.33%，其中包含RDP显示链开销的消除。

## 已实现并联调

| 范围 | 当前行为与证据 |
|---|---|
| 产品Control | SQLite多用户、服务端设置、独立Window/tab、鉴权WS、单Viewer租约、对账；普通入口不使用匿名HTTP轮询 |
| Viewer | MUI沉浸外壳、桌面split/窄屏聚焦、覆盖式设置、实际内容尺寸；普通页不暴露实验面板、不存localStorage设置 |
| 页面功能 | 每origin仅UA/CH、首次请求/redirect/history/restore正确；真实popup收养保opener/sessionStorage、自然close；标准dialog和导航beforeunload |
| 生命周期 | 默认120秒隐藏回收，Browser完整canDiscard守卫、真实discard/restore；Viewer visibility与RTC渲染需求分离；离线snapshot/维护不重启Browser |
| 输入 | Chrome89/157真实H264 canvas、鼠标、dialog回复及恢复；重载/重新登录/接管后输入序号分层修复并复验，旧token/epoch与重复输入仍拒绝 |
| 自适应 | 三质量档、ClientScale、面积预算、有效>300ms反馈降分辨率和迟滞恢复；真实DC采集时钟与paint形成WS反馈，静态尾帧排重 |
| 编码与GPU | QSV TU7/LPON/VBR/depth1、16对齐、auto输入在兼容QSV路径选shared；Viz直写目标及几何fallback；普通码率Reset不重开序列 |
| SDK/网络 | 真正libwebrtc PeerConnection/SDP/ICE/DTLS/SCTP、native纹理租约、wire RTP；每Session运行媒体策略保留拥塞控制 |
| 测量设施 | 有界Browser/SDK/Endpoint trace、GPU pass计时、ETW/引擎占用、分块metrics校验、真实paint/CRC与时钟置信度；固定实验独立于产品策略 |

Sol已实际检查Chrome89与157的MUI/H264/输入、用户隔离、多Window/窄屏、UA、popup、dialog、质量/ClientScale、120秒memory saver、WS断线/接管。生产能力探测已使157选择level4.2，真实双窗完整尺寸首帧通过；Chrome89保留兼容video路径。报告：[产品运行QA](../develop/docs/product-runtime-qa.md)。原生Windows输入法完整候选窗行为不能由协议composition检查替代。

首版506c45e发布检查：Control全套104项、生产构建与smoke通过；Endpoint收束后8项CPU suites、SDK2项通过，Browser/SDK/Endpoint增量构建通过。最终ZIP的559个文件hash全部匹配，包内普通注册/鉴权WS/Browser启动smoke通过；最终包smoke未另测RTC媒体。

## 当前默认与资源规则

服务端每页无页面HWND的Aura离屏宿主，不走屏幕Present；进程仍有Chromium辅助SingletonHwnd。产品默认启用已验证捕获优化，unsupported几何走明确fallback。Browser↔Endpoint稳态没有逐帧Mojo；真实GPU完成与三槽租约不因重建/故障而放宽。

默认service针对UHD630选择QSV；显式encoder=auto保留copy和NVENC回退，显式NVENC仍支持。普通客户端探测解码能力后选择level4.2，失败回native；高码率请求不能超越接收协商或网络上限。更多状态归属与流程见[系统设计](architecture.zh-CN.md)、[Control设计](control-plane.zh-CN.md)、[GPU输出](gpu-output.zh-CN.md)。

## 审查修复

审查修复版已修复串行恢复阻塞、恢复快照遗漏、token注销作用域、atlas几何边界、反馈序号重置、关闭墓碑积累及两项关闭/回复竞态。四页恢复ensure约0.204秒，其他Tenant观察不再等待；真实冷恢复验证了history、表单和滚动位置，POST只回退GET。证据见develop/tmp/recovery-regression与geometry-regression。

## 保留差距


- 每Session当前一个Profile；跨Browser sessionStorage、完整IME replacement/span、原生popup widget合成/命中覆盖，以及目录上传、认证/证书、跨端剪贴板、PDF/打印等仍是保留差距。
- 本机无NVIDIA硬件，NVENC只有编译/接口边界检查；音频不在本轮。
- 生产capture-end→paint是带时钟置信度的估算；Pixel marker测量及物理屏幕点亮是不同终点。

## 发布与入口

首版506c45e已构建并上传。Astra完成全链审查与有界修复复核；修复后的Control117项、生产构建/smoke及原生恢复/几何回归通过，审查修复版按打包/上传流程交付；取件码与最终hash保存在本机发布delivery记录并随交付回复提供。发布包不携带开发Profile、数据或凭据。首版交付记录位于develop/tmp/release-506c45e-delivery.json。

[构建运行](../README.md) · [Control](../control/README.md) · [打包](packaging.zh-CN.md) · [接口](streaming-protocol.md) · [SDK](sdk.md) · [历史选项归档](experiments-archive.zh-CN.md)
