# Touch与Atlas退役定向运行QA

2026-11-03。**本批157/89定向退役功能通过。** 已owned的child销毁后收到精确`terminal-invalidated`，同document新tap恢复且没有重连遮罩；普通terminal/cancel继续等待自己的canonical ACK。两版布局/文档失效、连续每move preventDefault均有真实证据。自然导航/resize退役未再出现atlas delivery fatal、BeginFrame CHECK、GPU崩溃或Browser重启。此结果仅覆盖本专项，不代替其它Viewer任务或实体触屏验收。专项评分4/5：本轮范围通过，布局转换期第一拍仍可能被正常输入门禁丢弃，详见下文。

## 产物与证据

运行目录`develop/tmp/retirement-runtime-qa`，`service.json`记录服务路径、mtime/大小和无feature覆盖；`metrics/client-metrics.jsonl`保存完整当前case原始包、结果、DOM及媒体身份；`case-summary.json`为40个样本的轻量索引。样本数包含夹具前提检查失败、held前后及补证，不能当作40个独立通过用例。全部通过host-managed Playwright创建隔离receiver，实际版本157.0.8103.15与89.0.4389.90。实际触摸为CDP可信PointerEvents→Viewer→生产DC，未伪造产品输入包。

使用完整`C:/src/chromium/src/out/dev`，不是只复制exe。已实际核对以下六项SHA256与`develop/tmp/native-retirement-build-manifest.json`一致：Browser `b041558a0ed0d90a3da8563a504d1bfda0081ac04fa0fe8df5c199ef65794bb5`；VizHost `1ab30e48ebdf046f8da268a1b8cc820058b8c75746d4f8832b883b473fdd09c8`；VizService `dadf6cf4a8ce625be23449c21695e63f1058a970669cfe03dc026a8b15472911`；content `e8fd8620983de98f7c4d6baabab4dbee2eab0c816e10ec93d9ccba56c69ac758`；SDK `c41fff82d4792410ed33095adced1d2d22cdc436e91e453e91f1dfc454e9e04f`；Endpoint `e144eb970b8dff7a3654842fbbe9362a41a0321158b6e09bcf61798feef09dad`。Control为最新279项测试后的生产clientDir，manifest为`develop/tmp/touch-retirement-control-build-manifest.json`。

空workspace实际UI新建Window；89复用本次临时账号登录，未输出或提交凭据。全程同Browser PID44992、instance1、incarnation`8dc261864b1c4541900575a04521bbbf`；换receiver产生新的Viewer连接属于主动切换，不跨Browser重启拼接通过。每组内部RTC/video/srcObject/track身份稳定。运行未用实验feature、性能矩阵或稳定性尾跑。

## 结果

| 范围 | 157 | 89 |
|---|---|---|
| child确实已owned后销毁 | `v157-retired-target-1793646354190`与补充旧ACK组`1793646440943`，先有child raw start/move及实际scroll≥30，再删除iframe；旧move/end code7、ok:false、精确旧sequence的terminal-invalidated | `v89-retired-target-1793646479181`，child scroll45后删除；旧move即明确invalidated，Client先清owner，因此随后物理UP未发送已退役owner的END |
| 销毁后的隔离与恢复 | 旧sequence期间root零touch/scroll；同document新tap恰1click、新sequence terminal processed，无重连遮罩 | 同样通过；不把没有旧END当缺失canonical ACK，旧move已携带明确退役证明 |
| 晚到旧结果不清新owner | `old-replay-delivered-blocked/release`：新tap的真实结果暂扣，实际重放旧invalidated到生产listener，第三次down仍不发新sequence；只释放新owner自己的ACK后才可新tap | 同名证据同样通过；重放为原始结果消息，不新造输入 |
| ordinary held terminal | `retired-held`，第一tap click1，暂扣结果后的新down不发seq且仍click1；释放自身ACK后新seq、click2、processed | 同样通过 |
| 普通cancel | `retired-cancel`，真实touchCancel到Browser并processed；暂扣ACK期间新down仍被挡；释放后同doc新tap click1 | 同样通过 |
| layout失效 | 旧epoch touchcancel processed，无新epoch旧end；即时恢复tap被布局转换门禁吞掉，稍后同doc补证tap click1/processed，媒体身份不变 | `retired-layout-1793646520975`，旧cancel processed；回稳600ms后新tap click1/processed，媒体身份不变 |
| document失效 | `retired-doc`，导航后新doc零旧touchstart/move、rootY0；随后新tap click1/processed | `retired-doc-1793646526834`同样通过，document16→17 |
| 连续每move消费 | `retired-everymove-1793646411404`，8次touchmove各真实preventDefault=true，custom/root滚动0，raw touchend及terminal processed | `retired-everymove-1793646532336`，同样8次消费、零滚动、processed |

连续消费两版随后Client候选momentum分别有2/1条明确`Momentum was not allowed`拒绝，并cancel；不是raw生命周期失败，也不称零reject。原始候选、拒绝及terminal均保留。未把首move消费的原生语义改成整序列消费，本用例显式在每次move调用preventDefault。

Browser日志自然配置generation1→17；期间有正常`request_cancelled_before_gpu`，明确`gpu_work_started=0`，没有`classification=fatal`、`external destination delivery disconnected before Done`、FATAL或CHECK。运行结束前Browser44992/GPU38392仍为原进程。Endpoint输出只有一次Browser启动；有Hyper-V候选地址STUN发送10051和QSV低码率Reset status5记录，实际连接及组内媒体仍保持；不把这些日志说成完全无任何ERROR。本次没有逐帧instrument drainer排空，因此“真实自然退役未复现旧故障”和五项CPU生命周期probe分开表述，不声称硬件直接观测每个Done/Fence。

## 夹具修正与视觉检查

新增`tools/client-gesture-retirement-qa-browser.js`只安装专项方法，不创建服务或浏览器。原gesture导航仅增加`live`参数；fixture的live模式在实际事件dispatch后30ms上报DOM，避免等待2.7秒idle后才看到已owned证据。child URL继承live；不改变touch-action、gesture或页面消费行为。连续消费由`block=everymove`显式启用。

最初157两条准备轨迹在删除child之前停止：分别只发1/2次move，遥测只看到0/15滚动；未达到预设owned证据，未删除child，不计产品失败。改成3次真实move，使删除前已看见≥30滚动，旧轨迹随后正常物理UP结束。89首次已成功在move收到invalidated，但旧通用断言要求必须有END而停住；检查原包确认Client因明确退役不再发送END，随后在同document继续补证新tap与旧ACK隔离。专项断言修正为必须有精确退役证明，不放行未知拒绝或timeout。

最初旧ACK重放也被夹具hold拦截，因此`late-old-blocked/released`不能单独算生产listener已收到旧ACK。真正有效样本为两版`old-replay-delivered-blocked/release`：仅同步派发旧原包时临时关闭hold，再立即恢复hold，故新owner自身结果仍暂扣。保留前次记录，不以它代替有效补证。

157 resize时第一次回稳后立即tap没有发touch包，远端未click；相同document稍后tap成功（`recovery-after-settle`），无重连。89夹具在恢复原viewport后额外等600ms以避开仍在转换的布局。该现象记录为布局门禁期间可能丢失第一拍，未改产品，也不据补证宣称任意resize瞬间输入都受理。

Sol实际打开检查了157 target恢复、真实旧ACK补证、everymove，以及89 target恢复/旧ACK补证、layout恢复、doc恢复、everymove PNG；画面可见正确fixture/已删除child，无输入恢复或Browser重连遮罩。未操作用户鼠标、键盘或窗口。

全部自有contexts已关闭，默认host `browser.close`已执行；fixture `/shutdown`返回200，原fixture44572、Endpoint34868、Browser44992、GPU38392随后均不存在。未触碰PID7816及其子进程。GPU及host browser已交还root；未commit/push。
