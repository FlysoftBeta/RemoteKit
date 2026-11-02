# 2026-11-03 root架构契约与集成记录

本轮由用户要求逐模块审查并不限改动范围。4de343c输入修正版已独立上传（354383）；不能把其验证算作下列新增实现验收。root负责架构、接口、集成和提交；实现与验证按文件归属由新代理承担。

## 用户模型

- Endpoint为Native算力节点，允许与Control分机。每Tenant目前一个Browser进程，Browser是Endpoint组件；单Profile是当前需求，多Profile接口余量保留。
- Client与Endpoint常规数据仅经WebRTC：音视频、输入、浏览器操作和文件数据。Control保存产品状态、鉴权与信令；Client与Control有即时操作反馈和最终一致同步。客户端不持久化产品状态。
- resize/focus/navigation不销毁RTC。布局屏障、输入资格、媒体对象生命期是分开的状态。
- Packing降编码及同步成本。当前多video共享track保留，不能用各video decoded计数相加推断重复解码；单video按客户端placement外接矩形合成是可选后端，不能未经证据改为强制或声称总GPU开销相同。
- 常见触摸默认手势在Client识别与计算；自定义/页面消费触点必须passthrough。必须有ownership和touch-action裁决，不能把所有touch无条件改wheel。软键盘由远端editable状态闭环驱动，composition绑定文档；键盘resize不能靠重连恢复。
- 新增搜索引擎设置与简易起始页，沿用MUI与独立Window。

## root已经确定的实现边界

1. Browser进程内服务clipboard不接宿主Windows全局clipboard；Profile cookie使用官方OSCryptAsync/DPAPI加密持久化。WebContents（包括pending popup）先于BrowserContext销毁。
2. SDK全局锁仅管理registry/lifecycle；不同channel并行，每channel请求串行。operation lease保证close取消和shutdown排空，不跨DLL改变ABI。
3. Endpoint关键DC消息用有界可靠outbox；layout/prepare按事务顺序重试，peer/代次替换丢旧事务。媒体统计允许合并，不能用丢控制消息后的永久黑屏或强放行兜底。
4. PageState导出分步、绑定Browser/view/navigation代次，全部完成才原子持久化。Snapshot不再同步导完整状态；输入RPC必须区分传输错误和可重试BUSY应用回复。
5. 晚metadata只能匹配同元素自己的最新rVFC观察，绑定同一个已确认屏障和track/attempt/文档。可恢复布局输入资格，但不能伪造当前RTP、compositor提交或Marker。迟到Promise不得影响新peer。focus失败撤销对应乐观状态，允许重试。
6. HTTP/WS服务主动关闭自己的连接、timer和listener并排空工作，再停Endpoint及数据库。取消上传为绑定身份的幂等终态，不能因HTTP abort先移除临时记录而失去取消原生chooser的能力。
7. 起始页用Control明确tab kind标识，不能根据about:blank覆盖真实popup。Viewer本地渲染起始页且不产生远程渲染需求；首次网页导航不插入伪造Browser历史。搜索默认Google，可选Bing/DuckDuckGo/百度，固定安全模板，设置只保存Control。

## 已实现并完成本批验收的跨层契约

Endpoint远端管理adapter、直接DC浏览器操作与Control持久操作收据/客户端pending投影、DC文件传输、Client↔Endpoint独立时钟校准已实现并完成生产构建和本批真实Viewer联调。客户端手势ownership、editable反馈与visualViewport resize事务已实现并按运行报告验证；实体设备缺口仍单列，不把模型检查写成硬件通过。

远端Endpoint主动连接Control的认证WSS管理通道，loopback开发允许HTTP升级；Control默认仍可启动stdio本地组件。管理链断线不销毁Session/RTC，不自动重放变更命令。产品动作通过DC进入Endpoint，再交Control唯一提交器；operationId、持久operationGeneration及Control分配的单调operationSequence分别承担去重、有限收据换代与Native执行高水位。accepted/applying/committed/rejected/unknown区分受理与业务终态；目标退役可解除未知操作的继续执行资格，但不能伪报成功。

Client完整惯性使用源时间解析累计位移；Browser只复用官方逐touch ACK的TouchDispositionGestureFilter和touch-action裁决。放行的fling候选只授权Client momentum，不启动Native FlingController。0010的canonical ACK和momentum期间有效touch-action保留必须有可逆补丁、编译及真实页面证据。raw terminal的派发受理不是ACK完成，Client-v1终止需要精确sequence状态确认。

移动resize冻结仅为一次、有界、无输入资格的旧ROI快照，不增加稳态canvas绘制。编辑事件可在相同文档/编辑owner的布局过渡中有界保序等待；新文档、真实失焦或peer替换立即作废，不把旧composition文本交给新目标。

## 已有真实证据与未完成验收

- 4de343c输入修正版已commit/push并上传，取件码354383，SHA256 `d51bb969ae359556e951b6bc951daa2ab6f48ff3cc1e2e1d1dcc4649e80b021c`。这是本轮审计重构之前的包。
- Browser/SDK第一阶段四目标增量及Profile/SDK生产路径CPU probe通过。实际加密cookie重启、两Tenant cookie/剪贴板隔离、同Tenant双Window剪贴板共享、混合visible事务拒绝/恢复、pending popup退出通过；证据`develop/tmp/browser-profile-lifetime/1793637288645388000`。早期cookie失败为QA SQLite句柄未关，修复夹具后通过，未用删除断言掩盖。
- 独立集成复审发现full-gather缺产品lease及unknown误标rejected，两项均已修，27项相关Control检查及真实DirectServices wire→Client语义回归通过。
- 完整Control288项及生产构建/smoke通过；最后loading字段修正另有48项定向/生产构建与实际补验，Browser/SDK增量、Endpoint17套CPU与195项runtime依赖导出hash通过。双Tenant带视频管理断链身份保持、DC文件字节与fake-camera、普通导航/beforeunload/stop已实际通过。搜索持久化、错误导航/stop修正、窄屏video、编辑模拟IME/键盘resize、实际PCM及最终效果图已按Viewer报告通过。
- 89/157各16项常规手势、延迟位移、terminal门禁/取消、2600ms暂停及后续tap已实际通过。child销毁的精确退役证明修复后，两版真实同文档新tap、旧回执隔离及布局/文档失效均通过。正常停止捕获的排队帧回调修复有真实Mojo CPU与自然导航证据；最新组无atlas fatal、此前BeginFrame CHECK或Browser自动重启。
- 当前详细证据以[current-state](../../docs/current-state.zh-CN.md)、[问题清单](open-issues.md)、[Viewer运行报告](robust-viewer-runtime-qa.md)与[手势运行报告](client-gesture-runtime-qa.md)为准。实体手机键盘与NVIDIA硬件不可用，模拟或CPU检查不替代硬件验证。

审计覆盖与原始证据分别在audit-control-sync、audit-viewer-media、audit-input-mobile、audit-endpoint-native、audit-browser-components、audit-files-audio-runtime六份日期报告。源码推导、CPU模型、编译和真实运行分开记录。每项修复后仍须独立运行验收；不重跑用户已取消的历史性能矩阵。
