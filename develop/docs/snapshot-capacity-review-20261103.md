# Snapshot组合容量审阅（2026-11-03）

结论：存在合法但较极端产品状态超过1MiB的缺口；不能准确描述为“正常连续导航自然累积128项后永久满账本”。更早的Browser响应上限会关闭控制通道，在线Control随后可能重启Browser，表现为终态无法确认、unknown及反复恢复。没有运行Browser/GPU或构建；以下为当前源码核对及一次Node纯JSON字节计算，不是运行复现。

## 导航：字段、保护和真实故障路径

- `browser/navigation_operations.h:22-31`限制identity各128字节、序号非零、每view 128项；没有总字节预算。`Ack`只删终态（82-87行）。`payload`和handles不进入snapshot。
- `browser/webview.cc:460-474`实际输出operationId、operationGeneration、operationSequence、state及可选navigationId/url/error。URL在499、586、2021行来自GURL/navigation，没有本项目输出长度限制；error来自固定短码或`net::ErrorToShortString`（2026-2030行），没有网页任意错误文本入口。error不是主要膨胀源。
- `browser/harness.cc:621-634`还输出每view的导航数组、完整已提交URL和完整title；title到Control才截120字符（`control/server/control.ts:618`），晚于传输预算检查。`NavigationOperations`不是唯一可变大字段。
- Browser Mojo先在`browser/control_server.cc:63-68`对完整JSON响应检查1MiB，超限直接Close；SDK同为1MiB（`browser/sdk/remotekit_sdk.cc:110,366`；Endpoint buffer为`endpoint/include/remotekit/control_reliability.hpp:17`）。Endpoint再把所有view加上pageRequests/Stats等组装为一个management回复（`endpoint/src/service.cpp:860-899`）。WinHTTP `TrySend`也限1MiB、队列4MiB（`endpoint/src/control_transport.cpp:21,217-231`）；Control WS maxPayload同1MiB（`control/server/endpoint-node.ts:17`）。没有分页/分块或超限小回复。
- ACK依赖Control成功获得整个snapshot，保存终态后发`view.navigation.ack`（`control/server/control.ts:600-611`），经Endpoint incarnation检查及Browser终态检查（`endpoint/src/service.cpp:1987-1992`；`browser/webview.cc:451-458`）。ACK失败被吞并在以后snapshot重试，没有独立终态拉取/ACK队列。
- 但产品操作按tenant串行（`control/server/control.ts:402-418`），每次apply结束会reconcile（509行），后续新导航也会supersede旧pending；常态已终结项及时ACK，不应把128项全满当作正常必然。CPU构造128项、各8192 ASCII URL时JSON数组1,081,985字节，只证明计数上限不蕴含字节安全，未证明该累积可由无故障UI流程自然达到。
- Browser超限关闭后`OnControlClosed`关闭输出并取消page requests（`browser/harness.cc:317-330`）；Endpoint RPC失败置control=0（`endpoint/src/service.cpp:361-365`），Snapshot可返回inactive（891-899行），下一次在线reconcile的`session.ensure`（`control/server/control.ts:573`）由Start执行Stop/Start（`endpoint/src/service.cpp:385-388`）。因此不是不可恢复的同一账本永久满；长状态重建仍可反复撞预算，原操作终态也可能只按target-retired标未知。

## 合法产品边界，不需要128项

当前普通产品上限已是32 tabs/8 windows（`control/server/control.ts:433,437,773`）；旧兼容路径182行才是16。不能用16作为全产品总预算证明。

`control/server/navigation.ts:12-22,35`只限制输入8192 UTF-16 code units，规范化/搜索编码后的URL未再检查字节。纯helper用同一Node URL语义计算：8192 code units的HTTP(S) Unicode路径规范化后73,560 ASCII字节，15个这种URL字符串的JSON数组已1,103,446字节，未计view字段。仅14个view的已提交URL加一个同长度未ACK导航URL便已有15份；16 tabs内已经可达，32更不安全。此为允许输入与序列化的确定容量缺口；长URL站点是否接受请求不影响Browser起始导航记录持有其URL。没有实测该整条运行路径，也不把这种长度当普通使用的典型值。

网页自身导航/redirect/history和title也没有走上述8192输入约束。Chromium跨进程URL硬限为2MiB（`C:/src/chromium/src/url/url_constants.h:71`），不能代替本项目1MiB envelope预算。

## DC文件authorize / snapshot

- authorize只传64项id+binding，不含accept/origin或文件数据（`control/server/control.ts:711-716`）。id为SHA256；binding由32字节Browser incarnation及数字view/instance/document/request组成。按各数字20位、connection/id/tenant UUID计算完整64项management请求17,669字节，正常生成字段远小于1MiB。Endpoint再次限64及token128（`endpoint/src/service.cpp:1838-1847`）。未发现此authorize组合的超限活锁。
- 文件pageRequests是另一条预算：每view最多64 pending/events（`browser/page_requests.cc:37,148-154`），每字符串截16KiB（38-43行），每chooser最多64 accept项（359-364行）。没有该数组/整个page.requests JSON字节预算。64项各16KiB的accept_types JSON本身1,048,786字节，尚未加request其它字段，理论允许上界已超Browser响应。较多view的普通大小请求也需按management组合计算，不能靠每view或每字符串计数推导安全。
- `PageRequests::Snapshot`完整复制pending并排空events（248-265行），Endpoint逐view获取后合入session snapshot（`endpoint/src/service.cpp:878-882`）。因此单个page.requests可先撞Browser上限，多个各自合格的响应又可在management层合计超限。极大的accept声明属于源码允许但罕见页面边界，尚未验证Blink对所有极端字符串的实际输入过滤；此处不声称典型上传即可触发。Control端slice(0,64)在收到后才执行（`control/server/control.ts:728`），不能保护前面运输。
- DC文件数据另有61440字节begin envelope、24576其它消息及16KiB chunk保护（`endpoint/include/remotekit/dc_file_services.hpp:12-47`）；这些限制不覆盖management snapshot。此次不扩展审查上传实现。

## 给root的有限取舍

1. 近期有限修复：对产品规范化后的URL、Browser输出URL/title、chooser accept数组及session总payload设可证明的字节预算；终态身份/状态必须保留，超限可选信息显式标记。URL是产品导航真相，不能悄悄截成另一个URL；需root决定拒绝/单独传输/超限状态契约。
2. 更完整修复：小型一致性snapshot保留终态identity/state，长字段和pageRequests走有界分页/分块；页游标绑定Browser incarnation及snapshot revision，Control在完整持久化后ACK。额外复杂度需要契约和恢复测试。
3. 若先只处理导航账本：提供独立有界终态batch与ACK，避免账本依赖大snapshot；仍必须同时给基本view/文件snapshot设置总预算，否则不能解决本文长URL/chooser组合故障。单纯增大1MiB或减少128项都不是完整修复。

本审阅仅新增本文档，未改功能文件、未commit。
