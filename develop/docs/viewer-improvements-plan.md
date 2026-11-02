# Viewer连接、触控、分辨率与呈现改进

用户新增任务：连接慢、触屏滚动困难、高画质不是满分辨率、多画面显示FPS低于decode；完成后上传。此次明确授权针对这些新问题做有界实验，不重复旧性能目标的稳定矩阵。客户端设备/UA待用户补充，先Chrome89/157隔离验证。

## 已证实与决策

- 双侧串行完整ICE收集：改为普通产品trickle+Endpoint异步answer/candidate事件，经Control绑定lease/attempt/connection。既有网络模拟显式保留full-gather relay路径，不能旁路模拟。
- H264 level4.2与固定60FPS预算限制真实像素：能力探测支持level5.2并按策略FPS采样；89兼容与Headless UA修正。无WebCodecs时仅接受真实WebRTC MediaCapabilities证据。能力未知/失败必须解释，网络超时不能永久降档。静态档位切换单次刷新。
- 高画质显式preferResolution：增加level5.1能力分支，原尺寸满足FS/轴长但超过MBPS时降低有效FPS，requested与effective分开。3856×2176在5.1下为29FPS；单帧硬上限仍需缩放，不能用降帧率绕过。源采集、SDK、编码与提交节拍使用同一有效预算。
- 触摸使用arrival时钟，40/80ms规则可破坏惯性：客户端保存采样时间、固定gesture clock、合并历史和可靠终止；Browser保留touch-action/preventDefault/OOPIF/原生惯性。完整客户端手势授权不在此小修内，不把所有touch转wheel。
- 本机headless生产基线未复现数量级decode/paint差距，但四plane同解码流对照中共享WebGL降低CPU约1.22→0.42核、3D约26%→11%，paint58.6→约60。集成>=2plane自动共享画布，原2D回退；不弱化RTP/layout/输入门禁。实验数据见viewer-presentation-candidate目录/报告。

## 集成约束

Transport按连接→触控→共享呈现顺序交接，不并改。native由connection_quality_audit统一构建，touch提供core/Browser变化。GPU计时结束后才构建。真实验收覆盖连接分段/候选取消、52实际解码尺寸/静态档切换、触摸延迟扰动/网页语义、WebGL resize/contextlost/实际Marker ROI与overlay。

WebGL失败静态页可发当前peer限频media.refresh，请求一次缓存帧/IDR；不得靠读取隐藏2D报告实际像素。刷新/重画同RTP不累计unique FPS。frameSource、renderer backend、实际限制和等待/丢弃原因进入现有stats，不新加产品调参面板。

## 当前分工

connection_quality_audit：信令、能力/采样、Endpoint service、统一native构建。
touch_scroll_audit：触摸时钟/历史/终止、Browser/core及模型测试。
viewer_presentation_experiments：基线/对照、共享WebGL/Marker与视觉验证。
root：架构、接口、集成审阅、文档、commit/push和最终发布委派。

## 集成发现与待办

- 已修复／触控派发：真实轨迹第二次move的同步completion被Browser当作未送达，取消后整段move/end遭拒；0008兼容补丁明确返回官方派发结果，最新真实组零拒绝。第二组驱动逐包等待CDP ACK人为拖慢输入，修正固定deadline后，正常/stall70/up100三组均313DIP（源位移320，含slop），网络扰动不再改变拖动距离。证据：develop/tmp/touch-source-qa-1793604552739/result.json。
- 已修复／触控惯性：Windows fallback ScreenWin返回PPI(0,0)，使默认PhysicsBasedFlingCurve失效。禁新曲线判别恢复惯性；0009无效PPI回退官方96后默认新曲线真实三组502/494/503DIP、零拒绝，正常曲线保留。
- 已完成／宿主独立化：服务构建自动设置内部service-input marker，惯性PPI固定96、GestureProvider固定GENERIC_DESKTOP；demo保留CURRENT_PLATFORM与有效物理PPI。Client DPR与媒体帧率预算保持独立，不新增用户旋钮。最终三轨迹502/501/502DIP、零拒绝/clockRejected，约404–418ms惯性；已小型增量构建并export，全部自有进程退出。证据：develop/tmp/touch-source-qa-1793605790097/result.json。
- 已修复／加载spinner：通用tab span样式误中MUI根span导致66×13px及裁切；标题专用class后桌面/窄屏均13×13、动画中心稳定。A真实视觉QA与最终Control148/build通过。
- 已修复／信令：异步rtc.signal最初使用内部数字Session ID而非产品Tenant UUID，导致路由遗漏；真实trickle已通，增加UUID不等于内部ID的运行回归。
- 已验证／共享呈现：真实ROI CRC、静态非等比resize、contextlost缓存重绘及无缓存单次refresh、89的2D回退已通过。最终报告由C整理。
- 已验证／画质连接：实际5.2完整4K、受控5.1完整尺寸29FPS预算、自动档52FPS优先和冷/暖首屏已通过。静态切档产生2个相距14ms的IDR，后续2秒无新增；重复刷新留作低优先级收束，不能写成单个IDR或误归因尾帧。
