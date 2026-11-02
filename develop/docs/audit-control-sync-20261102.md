# Control / Client 产品同步审阅（2026-11-02 批次，2026-11-03 执行）

本文件保留审阅当时的发现与建议。后续实现和验收以[当前状态](../../docs/current-state.zh-CN.md)、[本轮契约](robustness-contract-20261103.md)及[当前问题](open-issues.md)为准，不能把下文历史缺陷自动视为仍未修复。

基线：4de343c。只读源码审阅；未构建、未运行 GPU / 性能组、未修改产品源码。以下“已证实”指控制流可从源码直接推出，不表示完成真实故障注入。未发现可据此认定的 P0。

## 覆盖

完整读取：AGENTS.md，docs/current-state.zh-CN.md，docs/architecture.zh-CN.md，docs/control-plane.zh-CN.md；control/shared/product.ts；control/server/store.ts、http.ts、main.ts、endpoint.ts。逐段检查 control/server/control.ts 产品状态、serial、viewerRequest、attach/detach/logout、productAction、close、reconcileProduct、observeOffline、consumeClosedEvents、observePopups；诊断旧 action 路径阅读但不作为新模型实现依据。control/client/control-connection.ts 完整读取，main.tsx 检查连接生命周期、snapshot reducer、action、viewport 和持久化清理。辅助读取 endpoint/src/service.cpp:1741–1802 核对导航/关闭返回，transport.ts 时钟调用；阅读 reconnect.test.ts，以及 product-control、reply-lifecycle、recovery-observation、transport-control-rpc 测试相关断言。没有覆盖全部 transport 输入/媒体实现，也未代替对应模块审阅。

## 已证实的架构差距（由 root 定契约）

### A1 / P1：部署入口只能启动同机 Endpoint

main.ts:14 无条件 new EndpointProcess；endpoint.ts:7–58 唯一生产 adapter 通过 spawn/stdio JSONL，请求绑定同一个 child。没有 Endpoint 节点标识、连接 epoch、租户分配/重新连接地址或远端 adapter 配置。Endpoint 接口的 request 抽象虽可扩展，但入口不可配置成远端节点。因此“独立算力节点、不可假设与 Control 同机”的最新部署模型无法实际使用；这不是现有单机包故障。

建议 root 先定节点发现、认证、Session 所属与重连代次契约，再实现网络 adapter；保留本地 adapter 作开发方式。回归必须让 Control 与 Endpoint 在不同主机/网络命名空间，经历管理通道断线和 Endpoint 重启，验证租户不串与产品保留。

### A2 / P1：常规浏览器操作仍走 Control，且没有客户端即时操作层

shared/product.ts ProductAction/SocketMethods、main.tsx:203–213、control.ts:330–398：所有 tab.create/activate/close/navigate/command 都通过 WS action 到 Control，再经 Endpoint request。transport.ts 的 ControlRpc 类型只有 RTC、clock、feedback；当前没有 Client→Endpoint 常规浏览器操作及其最终同步契约。main.tsx 也只等待结果再 setState，没有 optimistic projection、pending operation list、rebase/rollback。慢 Endpoint 时 create 的 SQLite 保存可提前 push，但 activate/navigation/关闭没有一致的即时反馈模型；导航尤其先等待 Endpoint。

这与最新“Client↔Endpoint 仅 WebRTC，常规事件包括标签管理经此通道；Client↔Control 即时反馈和最终双端一致”存在直接边界差距。不能简单把现有 ProductAction 搬进 DataChannel：须由 root 定 operationId、lease/session epoch、产品意图和执行结果的合并/仲裁权、操作确认/拒绝/未知状态、断线后查询方式。客户端只能持有易失 pending projection，持久真相继续属于 Control。

## 已证实的实现缺陷

### F1 / P1：请求断线或超时后没有操作身份，重试会重复创建

control-connection.ts request 的 id 是连接对象内自增字符串；20 秒超时只删除 pending，rejectPending 在连接关闭时直接拒绝全部请求。http.ts:86–95 的 pending 集只拒绝“尚未完成的同 id”；finally 后即删除，没有已完成收据。Control.productAction:336/340/347 每次随机创建 tab/window，Store 没有 operation receipt。

触发：window.create 已提交 SQLite，结果/状态在网络断开前未被客户端收到；客户端显示失败，用户按错误提示重试。原请求不撤销，重试新 id 会再创建一个 Window/tab。即使同一连接在 20 秒后重试也如此。不能把“请求失败”解释为“操作未执行”，当前协议却无法查询原操作状态。浏览器返回/前进等非幂等命令同样不能安全重放。

建议：持久 operationId+意图 hash+终态收据，重复返回同结果；断线显示 unknown 并在完整 snapshot/operation 查询后决定重试。不能持久化客户端产品状态，operationId 可在本次页面生命周期内暂存，刷新后由服务端快照解决。回归：完成提交后丢 result/state，再重连及重复同 operationId，断言仅一个新对象、返回原 id；相同 operationId 不同意图拒绝。

### F2 / P1：导航意图不是先持久化，Endpoint 故障窗口丢用户地址

control.ts:350 先 await view.navigate，再写 t.url/t.pendingUrl，直到 :388 才 saveProduct。Endpoint service.cpp:1789–1796 已执行 Browser RPC、清除旧恢复文件、更新并 Save desired，再返回。若 Endpoint 已执行，但管理回复丢失/Control退出，Control 保留旧地址且没有待处理操作。若 Endpoint 本来不可用，导航直接失败，根本不保存用户意图；这与 control-plane 文档“先保存产品意图，再调用 Endpoint”不符。

已证实的是先后顺序与缺少 durable operation；真实故障后的最终地址依赖 Endpoint 恢复数据，不能断言一定导航回旧页。建议持久 pending navigation（含 operationId/状态），由 Endpoint 幂等执行并观察匹配导航代次后确认；beforeunload 取消必须有拒绝终态，不能靠后续任意 loading=false 推断。回归分别注入执行前断线、执行后回复丢失、beforeunload 取消、Control 重启，验证意图/实际状态与 UI 明确。

### F3 / P2：整个租户串行队列包含慢 RPC，时钟和反馈被管理操作阻塞

control.ts:55–58 serial 覆盖 reconcile 的逐页 Endpoint 往返；viewerRequest:291–309 将 clock.ping/feedback 放同队列。offer:175–211 也在该队列中等待 SDP，只有 ICE 专门绕过。EndpointProcess:54 允许单 RPC 等待20秒。故任何一个挂起配置/恢复/offer可阻塞所有标签操作、viewport 和时钟；多个积压操作又可在客户端已经超时后执行。transport.ts:1087–1088 会把这段排队耗时纳入校准 RTT，令时钟置信度失效或质量反馈延后。未证明此情况会错误降低分辨率；当前有效性过滤可能拒绝样本。

建议 root 定可并发观察/时钟快路径及产品意图受理边界，避免单租户长 RPC 吞掉全部交互。操作执行仍须保序，超时不能无条件取消已提交动作。回归：gate 一个 reconcile RPC，同时发 clock、viewport、create，验证 clock及时返回、受理反馈及时、最终顺序保持、超时操作能查询。

### F4 / P2：HTTP server 关闭遗漏 rtc.signal listener

http.ts:73–74 注册 control.on('rtc.signal', signal)，:100 的 server close 只 off('state',push)，没有 off('rtc.signal',signal)。同一 Control 上反复创建/关闭服务时，闭包和 peers map 被保留，导致监听器增长及重复遍历。正常单次启动不受此触发；测试/嵌入式重启会遇到。

修复应对称注销 listener。回归在同一 Control 上重复 start/close，断言两个事件 listenerCount 都回原值。

## 待实验 / 待新契约确认（不冒充已证实缺陷）

- snapshot 版本只有 workspace.revision。Control.push 的 pageDialogs/fileRequests、quality、Endpoint error/generation、viewer 状态不一定增加该 revision（control.ts:239–242）；main.tsx:148/207 接受等 revision，control-connection.ts 忽略 SocketMessage.revision。当前单 WS 有序、租户大部分串行，不能据此断言已经发生旧快照覆盖；但新双通道与乐观 rebase 不能只沿用 workspace revision。建议 server session epoch + monotonic snapshot sequence，独立于持久 workspace revision。需用同 revision 的 runtime snapshot 乱序注入验证。
- control.ts:481 允许 current.loading===false 清除任何 pendingUrl 并覆盖 URL，没有导航 operation/revision 对应关系。待证明 Browser 接受 navigate 后第一份 snapshot 是否可能仍返回旧 URL/loading=false；若可以，刚保存意图会立刻被抹掉。延迟导航启动/取消/连续 A→B→C 的受控假 Endpoint和真实 Browser 回归都应覆盖。
- pendingClose 在 :413 仅因离线/incarnation/document变化作废；请求突然消失但实例/文档不变时不处理 cancelled 状态。正常 Client cancel 路径会直接清理；只有 Endpoint 已取消但回复丢失等情形需验证会否出现不可关闭的残留确认。需明确 close terminal result 的可查询收据。
- attachViewer 在队列外立即替换 viewer，已进入队列的操作只在入口 assertViewer。被接管前已受理动作可能在新 lease 后完成。这是否允许应由 root 定“受理线性化点”，不能笼统视为越权或直接增加 await 后断言（后者无法撤回已执行副作用）。

## 已核实的正确边界

- 客户端没有产品配置 localStorage 数据库；main.tsx:412 是删除历史 receive-profile。普通登录 token 为 HttpOnly cookie（http.ts:12）。断线不自动重放产品操作；因此 F1 是手动重试/不确定终态问题，并非现有自动重放 bug。
- serial 的前次 reject 不会永久堵塞队列；完成后会清理队列 map。租约在产品操作实际入队执行点复检，旧 detach 不关闭新 viewer（:255–264）。
- Store.saveWorkspace 校验 Window/Tab/active关系，事务写入并在内容变化时递增 revision。注册口令异步 hash 后事务内复检策略，首注管理员与普通 token 身份独立。
- 自然关闭先 saveProduct 再 ACK Endpoint（:596–608），不会因 ACK失败把已删除 tab 重建。缺页本身不当作 close 证据。popup 先事务持久产品关联和收据再 adopt，重试不降级成 URL ensure。
- close/reply 的 Browser incarnation、instance、document、request哈希绑定明确，已有 stale/offline/replacement模型测试；上述待实验项不否定这些保护。

本报告仅建议审阅范围与可选契约，核心架构决策、优先级取舍及修复分工由 root 决定；当前上传不应被只读审阅阻塞。
