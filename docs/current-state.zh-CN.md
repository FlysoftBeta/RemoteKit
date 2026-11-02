# RemoteKit当前状态

更新：2026-11-03。Windows x64；Chromium官方157.0.8103.15，基线`1aa07b638799e59656559ae6c6649d4b197f555e`。只复用out/dev、out/rel增量构建，继续支持Chrome89。

**当前架构重构批次已完成规定范围的功能验收，正在提交和打包上传。** 上一发布为4de343c（取件码354383），不是本批新包。六模块审计、独立集成复审及运行发现问题的修复已完成；root负责契约、集成与提交，独立代理负责实现、构建与真实验证。具体证据见[问题清单](../develop/docs/open-issues.md)、[本轮契约](../develop/docs/robustness-contract-20261103.md)。

## 当前架构与实现

- Control是产品状态真相，持有用户、独立Window/tab、设置及有限Endpoint引用。Client只持久化token，内存维护pending操作投影，通过WS快照及持久操作收据收敛。
- Endpoint是可分机部署的Native算力节点，Browser是其组件；目前每Tenant一个Browser进程、单Profile，保留多Profile余量。新增主动认证WSS管理连接；管理连接身份与Endpoint进程身份分开，短暂管理断链保留RTC及媒体对象。
- Client与Endpoint常规数据通过WebRTC：H264/Opus、输入、产品动作、文件数据。产品动作由Endpoint转交Control唯一提交器，持久operationId/generation/sequence负责去重与执行资格；超时unknown不冒充失败或成功，不自动重放变更。
- Viewer默认video，每个可见平面共享接收track，客户端内容bounds决定显示布局，atlas只决定裁剪。关闭原生controls、PiP与远程播放。每个元素独立验证布局/媒体身份；正常路径不运行MSTP/持续canvas绘制。能力或协议失败保留canvas回退，移动resize只允许一次有界旧ROI冻结并单独计数。
- 布局屏障覆盖Endpoint旧inflight编码结果；prepare/ACK按完整事务身份幂等。Client隐藏旧画面、撤销输入资格后ACK，新布局首个成功关键帧才放行。导航、focus及resize不要求销毁RTC/video。
- Client计算触摸惯性与pinch；Browser使用官方touch-action及逐touch canonical ACK仲裁，保留raw passthrough，不启动第二套Native fling。正式离屏Browser关闭会改变Client位移的第二次滚动重采样；source elapsed与Native非未来、非递减时间戳分开。terminal受理不等于处理完成。
- 移动编辑绑定文档/编辑owner，支持焦点反馈、composition及有界布局过渡队列；visualViewport变化保持内容位置。实体手机软键盘验收仍不可由桌面模拟替代。
- 新增Google/Bing/DuckDuckGo/百度搜索设置和明确的本地起始页。设置存Control，起始页不产生Native渲染需求；错误导航的实际文档提交与业务失败收据分开，避免遮蔽Chromium错误页。
- 文件经DC有界分块/并发与写入ACK传输，自定义选择和Worker拍照选帧保留。音频为Chromium播放target与独立Opus管线，整个Viewer统一保存左右声道选择。
- GPU资源依赖真实Fence与租约。NVENC超时进入有界隔离，不能在未知完成时复用。Viz BeginFrame修复仅识别明确已退役的frame ID，保持未知/重复完成断言与背压；没有以CPU发布位替代GPU完成。

## 本批验证

完整Control288项、类型检查、Chrome89目标生产构建和启动smoke通过；最后stop loading字段修正另有48项定向、类型检查、生产build/smoke与实际补验。Browser/SDK增量、触控probe、5个真实Mojo交付场景与13项atlas池CPU检查通过；Endpoint17套阶段CPU及受影响2套重新验证通过，真实WinHTTP管理连接检查通过；195项SDK运行依赖及公开header/import lib已核对导出hash，11补丁可逆重放检查通过。最终包另执行打包smoke、逐文件manifest和ZIP校验，不拿源码检查代替包校验。

已取得的真实证据：

- Browser加密cookie重启、Tenant cookie/剪贴板隔离、同Tenant共享剪贴板、pending popup退出与visible事务检查通过。
- 157收据丢失/重复与乱序快照、89首次网页、双Tenant带视频管理断链后RTC身份保持、DC Unicode/空文件/多文件/延迟读取/取消及fake-camera字节检查通过。
- 普通导航、前进后退、reload、beforeunload取消/接受通过；89/157实际错误文档可读且收据仍rejected，start首导航stop正确回start并隐藏Native。最后补验loading清零、刷新按钮恢复、无残留spinner；remote导航stop保留原URL，Client无旧workspace解包异常。
- 原split白屏已定位为重复prepare导致ACK饥饿；157/DPR2同场景修复后580ms恢复、两ROI正确且无prepare flood。
- 89/157各16项常规手势、延迟位移对照、terminal门禁、取消、2600ms暂停及同文档后续tap通过。新版真实运行未出现此前BeginFrame CHECK/GPU崩溃或Browser重启。

89/157均验证child已有触摸与滚动后销毁，旧owner明确失效、同文档新tap正常且无重连遮罩；旧invalidated回执不能清理新held owner。普通终止门禁、布局/文档失效及连续每move preventDefault零滚动通过。正常Stop排空修复后的自然退役组无atlas fatal、GPU CHECK或Browser重启。

最终89/DPR1与157/DPR2的split→1100→390→split全程默认video，超过旧watchdog期限仍正常；隐藏plane不再误触发全局canvas回退，返回双窗分别验证自身新帧及输入坐标，媒体身份保持，稳态MSTP/draw为0。89真实wheel/root与nested scrollbar、四搜索模板/刷新持久化、实际PCM声道与静音恢复通过；157文本/Enter/Backspace/换行/失焦、模拟composition跨文档取消及模拟keyboard有界freeze通过。真实about:blank popup保留opener和remote类型，关闭同步移除Control与Native对象。Sol已逐图检查桌面split、起始页、设置和390窄屏效果图；没有重跑历史性能矩阵。

运行报告：[Viewer](../develop/docs/robust-viewer-runtime-qa.md)、[Client手势](../develop/docs/client-gesture-runtime-qa.md)、[Browser隔离](../develop/docs/browser-profile-lifetime-fix-20261103.md)。报告保留失败尝试，后续通过不得覆盖旧故障事实。

## 已发布基线与历史性能

4de343c已提交、推送及上传，取件码354383，是本次重构前的输入修正版。其89/157连续wheel、nested/root scrollbar、跨窗、resize及reload后输入已真实通过；focus/导航/resize保持video/srcObject/RTC身份。[基线回归](../develop/docs/video-input-runtime-qa.md)与[默认video记录](../develop/docs/default-video-runtime-qa.md)不能代替本轮新增路径验收。

历史双Tenant45秒组实际canvas51.69/51.73FPS、Pixel marker p95 76/79ms，条件为1920×1080/DPR1、atlas1936×1088、RTT10ms、每peer48Mbps、UHD630/QSV。用户取消额外稳定尾跑和单租户重复组；本轮只做功能修改所需检查。Marker终点为canvas提交，不能挪作video物理显示帧率。[完整性能条件](streaming-experiments.zh-CN.md)。

## 明确保留的边界

每Session目前单Profile；完整IME replacement/span、原生popup widget合成/命中、目录上传、认证/证书、跨端剪贴板、PDF/打印及原生长按仍有缺口。POST reload缺少repost确认协议时明确拒绝，不能伪装GET成功。没有本机NVIDIA硬件、实体移动软键盘及真实摄像头效果验收；NVENC的CPU/编译证据、模拟viewport及fake-camera均须如实区分。capture-end→呈现延迟是带时钟置信度的估计，不是物理屏幕点亮。

## 发布要求

完成新增路径验证、整理文档并由root本地commit后，委派全新Sol按[打包](packaging.zh-CN.md)与[上传](upload/README.md)构建校验streaming包。包须包含最新Browser、SDK、Endpoint、Node及Control生产runtime，解压run.cmd；不带Profile、数据、凭据、日志或PDB。返回新取件码/链接、SHA256及Viewer效果图。本次上传优先、GitHub push尽力而为；不得把354383或744995当新发布。

[系统架构](architecture.zh-CN.md) · [Control](control-plane.zh-CN.md) · [协议](streaming-protocol.md) · [输入](client-gestures.zh-CN.md) · [导航](navigation-operations.zh-CN.md) · [GPU](gpu-output.zh-CN.md) · [音频与文件](audio-and-files.zh-CN.md)
