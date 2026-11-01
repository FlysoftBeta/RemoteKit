# 首版后独立审查

审查基线：`506c45e`，2026-11-02。首版已上传（取件码306577）后开始。以下行号均指该基线，不能套用到并行修复后的行号。只读源码和正式文档；未修改产品源码、未构建、未跑性能矩阵、未操作桌面。进行了一个直接调用现有QualityController的本地合成输入检查。

重点核对Control产品关系/租约/恢复、Endpoint命令循环与恢复导出、Browser导航和页面回调、Client反馈与帧身份、GPU共享租约退役。结论是6项确认问题值得修复；另有2项需补边界验证的风险。没有发现可据当前证据确认的GPU fence提前释放问题。未将单Profile、IME、popup widget、NVENC无硬件等保留目标当作本轮阻塞。

## 确认问题

### R1 / P1：多页恢复阻塞整个Endpoint命令队列

- 位置：`endpoint/src/service.cpp:320`、`:435–470`、`:1321–1345`；`control/server/endpoint.ts:47`。
- 触发：冷启动/Browser重启，多个持久页恢复失败或慢导航。Start逐页CreateView，CreateView同步RestoreNavigation，每页最多约1秒settle加11秒restore等待。
- 后果：不只是该Tenant延迟。Endpoint主JSONL循环同步执行Session::Command，A恢复期间B的snapshot/页面操作/信令都不能调度。三四个慢页足以超过Control统一20秒RPC超时；超时不会取消Endpoint工作，后续重试继续排队。
- 证据：`for(auto& [view,config]:desired)CreateView(config,true)`；RestoreNavigation在while内反复BrowserSnapshot和sleep；主循环没有每Tenant异步调度。Control timeout只删除pending项。
- 修复边界：ensure只建立进程/稳定WebView身份，导航恢复显式pending，由有界维护步推进完成/失败/fallback；不要简单调大超时，不要在背景线程无同步地调用同一Session状态。架构由root决定。
- 验证：离线HTTP恢复页+两Tenant功能组，断言ensure快速返回、B命令可执行、原WebView ID稳定、恢复pending与最后结果可观察，完成后旧输入仍拒绝。无需再跑吞吐性能组。

### R2 / P1：旧认证token注销误撤销同用户另一Viewer

- 位置：`control/server/http.ts:33,36`；`control/server/control.ts:19,190–209`。
- 触发：同用户两个有效token，B已接管Viewer，A旧页面退出或重新登录。
- 后果：HTTP只撤销A的token，随后却按tenant无条件logout当前B租约，B媒体被关闭并被要求重新登录；作用域不一致。
- 证据：Viewer仅存id/revoke、不存认证身份；logout(tenant)直接取当前Viewer；HTTP登录与注销都调用它。
- 修复边界：租约绑定token身份（可用hash），注销只撤销匹配身份租约；排队请求执行前重新校验身份仍有效，保留旧close不影响新lease的保护。
- 验证：两个token同tenant接管，A退出/换号不踢B；B自己退出立即停媒体；撤销后已排队请求不能写状态。
- 进展：负责修复的Sol已告知此项代码和22项相关测试完成；root仍需集成审阅。本报告没有把该通知当成自己复验结果。

### R3 / P2：恢复导出用document去重，遗漏同文档history与后续PageState

- 位置：`endpoint/src/service.cpp:473–490`；`browser/webview.cc:1591–1631`；`browser/navigation_state.cc:141–159`。重启缓存另见`service.cpp:654–680`。
- 触发：一个文档首次成功导出后发生pushState/replaceState/hash/同文档history变更，或renderer随后更新表单/滚动PageState；没有后续跨文档commit就Browser退出。
- 后果：Endpoint仍用第一次导出的history、选中项和PageState恢复。Control当前URL可能已更新，但成功导入旧文件会优先采用旧状态。此问题不属于“不能保存任意JS heap”的保留限制，而是已支持的NavigationController数据未刷新。
- 证据：CaptureNavigation只判断`recovery_documents[view]==document`；WebView明确排除IsSameDocument后才CommitDocument。NavigationState导出本可读取当前controller及PageState，但该路径被跳过。
- 同类失效：recovery_documents在Stop/Start未清理，Browser局部document代次重启后重复可能继续误判已保存。
- 修复边界：恢复快照有独立dirty/revision证据（导航条目/选中项/PageState变化），有界导出并在Browser incarnation变化时失效。不能每次snapshot无条件导出64MiB；不要把PageState搬入Control。
- 验证：同文档两次pushState、back、replaceState后保存并重启，核对URL/history选中项；renderer报告的新表单/滚动状态再保存；同一Session Browser重启后首次快照不受旧document缓存抑制。

### R4 / P2：产品可接受的viewport组合无法分配atlas

- 位置：`control/server/control.ts:243–245`；`control/server/quality.ts:37–40`；`endpoint/src/service.cpp:325–340`；`endpoint/include/remotekit/atlas_dimensions.hpp:10–21`。
- 触发与算例：单窗口8192×400被Control接受，Endpoint加padding后逻辑宽8200即拒绝；两个4096×600窗口逻辑宽8208同样拒绝，虽然源像素面积仅约4.9MP。高DPR细长窗口也可能面积合规但物理单轴越界。
- 后果：resize/多Window显示失败，Endpoint错误和旧/空输出；调低质量未必能恢复，因为atlas先检查逻辑单轴<=8192，且DesiredGeometry.scale从1起取max，DPR<1不会降低该分配比例。
- 证据：产品质量仅面积开平方，没有单轴、padding、对齐、组合规划；Endpoint统一横向相加而非选可行的二维布局。
- 修复边界：保留真实viewport DIP，统一计算可行atlas布局/物理采样范围，覆盖padding与alignment。不要靠硬夹viewport改变页面布局。对于DPR下限仍不可行的极端组合，应明确可观察的不可行状态，而非无限重试同样配置。
- 验证：上述算例、纵向窄长、多个不等高Window、DPR0.5/4、16对齐边界，断言真实DIP不变且分配/输入映射一致；无需GPU性能组。

### R5 / P2：时钟校准reset使质量反馈序号倒退并长时间失效

- 位置：`control/client/capture-latency.ts:12–19,30–34,51`；`control/server/quality.ts:15–18`。
- 触发：同一连接内客户端时钟跳变、校准offset异常或capture wall/monotonic差异触发CaptureLatency.reset。
- 后果：测量缓存正确丢弃，但sequence也归零；服务端QualityController仍记旧最大sequence。重校准后反馈从1开始被连续拒绝，直到追上旧值。以2秒窗口运行1小时再校时，可再等待约1小时才恢复分辨率自适应。
- 证据：reset同时清clock和sequence；校准/paint多个错误路径调用reset，而服务端仅attach/offer重置sequence。小型本地检查：服务端接受seq100；后续seq1和100均false；101才true。
- 修复边界：分开测量/时钟reset与新连接reset；同一反馈流保持单调sequence。若引入stream id，必须明确新流接受和旧流拒绝规则，不能遇到小序号就宽松放行。
- 验证：先输出多窗口反馈，再模拟本地时钟校正，重新校准后的第一个有效窗口可接受；重复旧反馈仍拒绝；真正新连接能重新开始。

### R6 / P2：Browser已关闭页墓碑无界累积，最终破坏snapshot/RPC

- 位置：`browser/harness.cc:94,123–130,532–534`；`endpoint/src/service.cpp:250–256,615–621,1193–1201`；`browser/sdk/remotekit_sdk.cc:299–304`。
- 触发：长驻Browser持续创建/关闭页面。每个关闭页都进入closed_views，没有删除或ACK路径。
- 后果：内存和每次snapshot体积随历史关闭总数增长；最终snapshot超过Endpoint固定1MiB回复buffer，SDK返回失败，Session::Rpc将control置0，下次Start会重启Browser。Endpoint的256个未确认事件限制不能限制已确认的Browser墓碑。
- 证据：closed_views全部引用只有插入、contains和snapshot遍历，无erase；Endpoint session.events.ack只清自己的durable_events，未通知Browser。与之相比adopted_popups在RemoveView已正确erase。
- 修复边界：Endpoint关闭事件持久化成功后确认Browser墓碑可回收，ACK可重试且幂等；响应丢失仍应能重放，不按任意TTL丢未持久化的关闭证据。显式关闭路径也需清理。
- 验证：小规模模型验证事件落盘先于ACK、ACK丢失可重试、Control尚未ACK也不丢Endpoint事件；重复关闭/ACK后Browser snapshot只保留当前与未交接记录。无需打开数千真实页面。

## 待验证风险

### V1：页面回复没有把Browser incarnation带到最终执行点

`control.ts:282–289,438–449`的dialogId包含browserPid，并在回复前刷新snapshot；但`service.cpp:1246–1251,1280–1290`对回复先Start，命令只携带view/instance/document/request。snapshot后Browser退出可能导致回复执行前启动新Browser，局部计数可以重复。`view.close.reply`更弱，只发requestId/accept，没有instance/document或限制beforeunload类型。

建议回复类命令不启动Browser，并核对不可复用的Browser incarnation；close pending身份也绑定原beforeunload请求。验证应在snapshot与回复之间注入Browser替换，断言拒绝旧请求且新请求未受影响。本次未运行该竞态，故不列为已重现bug。

### V2：pendingClose遇到离线空snapshot可能被当作已完成

`control.ts:360`在current缺失且pendingClose匹配时删除Tab；Endpoint `InactiveSnapshot():601–606`明确返回running:false和views:[]。在线reconcile先ensure后snapshot，仍存在Browser在两者之间退出的窗口。

需要验证未回答的beforeunload关闭请求在这个窗口内不会被当成用户已同意关闭。建议仅在明确running快照或durable closed事件证据下处理；进程离线是未知，不是close确认。本次未运行故障注入。

## 有价值的有界重构

1. 抽出恢复进度对象，统一begin/pending/complete/fallback/取消与Browser incarnation，消除Start、CaptureNavigation、snapshot里隐式串行状态；可随R1/R3实施，不建议为了拆文件另做大重写。
2. 抽出一个geometry plan：产品质量预算、padding、atlas布局、DPR、编码采样都使用可验证结果，避免Control和Endpoint各自计算不同约束。跨层契约由root确定。
3. 明确“测量状态”与“流身份”：CaptureLatency与QualityController的reset目前语义混杂，R5用小改动分开即可。

## 核对后未新增问题的范围

- Viewer detach已有旧lease检查，并在串行实际执行时再检查新Viewer，不会由旧WS close隐藏新Viewer；R2是独立的token作用域缺口。
- popup provisionalId使用UnguessableToken；收养先持久化产品收据，重试不随意view.ensure；没有发现可确认的provisional局部计数重用问题。
- 离线维护带requireRunning；snapshot不会主动启动Browser。V2关心的是消费者对离线snapshot的解释。
- 输入已有client/peer/Browser序号分层，FrameEpochGate绑定实际观察RTP与epoch，focus队列等待ACK；此次未确认新输入穿越代次bug。
- GPU retirement检查真实ready/done和租约；失败保留资源，未看到以CPU发布位代替完成的新增证据。本次没有硬件故障注入，不能把静态审查说成GPU实测。
- tools中develop引用主要是测试输出目录，未据此认定正式构建依赖过程源码。未发现足够证据确认legacy迁移质量档错误，不按线索自动报bug。

当前状态文档的“导航恢复保留history/PageState”“回复绑定Browser进程”“实际viewport与面积预算”是上述修复后的验收要求；在修复前应记录相应边界，不能只改文档宣称实现完成。

## 修复复核结果

以上保留506c45e的审查依据。root已组织对应修复：恢复状态机/revision/观察器时序、token作用域、几何规划与原子提交、反馈序号、闭页ACK、不可复用回复身份、离线关闭证据均完成。有界静态复核另发现viewport拒绝提示被吞，现已补齐。Control117项及原生9项CPU suites、真实恢复/ACK/几何定向检查通过，证据索引见open-issues.md；未新增性能矩阵。
