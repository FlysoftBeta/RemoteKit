# Client gesture 专项运行 QA

2026-11-03退役修复定向复验：**157/89 owned child销毁→精确terminal-invalidated→同document新tap均通过；普通terminal/cancel仍等canonical ACK、晚到旧结果不清新owner、两版doc/layout失效及连续8move消费均有真实证据。** 自然退役generation1→17没有atlas delivery fatal、CHECK、GPU崩溃或Browser重启。证据`develop/tmp/retirement-runtime-qa`共40个样本（含夹具准备/补证，不等于40独立通过），完整结果与夹具修正见[本次定向报告](touch-atlas-retirement-runtime-qa-20261103.md)。157 resize即时第一拍被布局门禁丢弃，稍后同doc tap成功，未掩盖此现象。以下“最终产物”段为前一轮历史，不覆盖本轮结论。

2026-11-03最终产物：**157与89的16项常规功能、延迟对照、terminal门禁/取消/有界暂停及暂停后恢复tap均有真实证据；157 child销毁产生明确输入拒绝并显示需重连遮罩，89 invalidation未完成。** 此次没有BeginFrame CHECK/GPU崩溃或Browser重启；89末段导航出现一次atlas `classification=fatal` delivery断开，已停止并释放GPU，不能宣称完整专项通过。没有实验feature覆盖或性能矩阵复测。

## 最终产物运行（2026-11-03）

证据目录`develop/tmp/client-gesture-runtime-final`：`service.json`记录完整out/dev Browser、Endpoint与生产Control clientDir；`metrics/client-metrics.jsonl`保存原包/ACK/DOM，`case-summary.json`为62个样本汇总，另有PNG与telemetry。Browser SHA256 `8801e1d7b138ce56c591ece979be9e2c98685c73ecd5011e412aea2637d67caf`，Viz `dadf6cf4a8ce625be23449c21695e63f1058a970669cfe03dc026a8b15472911`，content `e8fd8620983de98f7c4d6baabab4dbee2eab0c816e10ec93d9ccba56c69ac758`，SDK `c41fff82d4792410ed33095adced1d2d22cdc436e91e453e91f1dfc454e9e04f`，Endpoint `9d849f9439027696501800316fe0aada77b2bcaf983566d1b4277c19133057d0`均实际核对一致。运行无browser-disable-features覆盖。

通过host-managed Playwright隔离receiver157.0.8103.15后89.0.4389.90，同一临时账号先真实UI新建Window后地址栏导航。89首次另注册账号因注册口令要求失败，关闭该context后用本次既有临时账号登录；不是产品失败。全程Browser PID34284、instance1、incarnation `85339c1f6f48274d8bdc233a6821e3b8`，两receiver各有独立connection。实际布局`clientGestures:1`、trusted Viewer PointerEvents与client-v1包均已断言；组内peer/video/srcObject/track身份稳定。

| 范围 | 157 | 89 |
|---|---|---|
| tap/root/nested | click1；root510、Client约509.815；nested324/root0 | click1；root510；nested324/root0 |
| CSS主轴与off-axis | none/pinch-only平移0；pan-x X301/Y0、pan-y X0/Y301；两个off-axis全0 | 同样通过 |
| preventDefault | start实际消费，8move+end、零滚动、terminal processed；随后仅精确momentum code7拒绝；firstmove消费首包，后续custom307/root0 | start同样通过；firstmove custom306/root0 |
| pinch/none/pinch-only/第二指none | scale约3/1/2.333/1；第二指none零滚动 | 同样通过 |
| OOPIF | child301/root0，tested view至少2 renderer PID | 同样通过 |
| normal/middle70/lateUP100 | DOM509/508.75/510；direct220；momentum289.492/289.492/289.815；全部processed，差≤3DIP | DOM510/510/510；momentum289.831/289.831/289.815；全部processed |
| held terminal | 未释放ACK前第二down不发新seq、click仍1；释放后新seq、click2 | 同样通过 |
| 新down/cancel | 旧momentum cancel先于新touch start；真实CDP cancel→processed | 同样通过 |
| 2600ms rAF暂停 | 旧momentum停止，恢复momentumEnd因2秒无进展过期明确code7 `Momentum owner lost`；补证同doc新tap click1/processed，root391.25不再动 | 同样过期停止；后续同doctap click1/processed，root220不再动 |
| layout/doc失效 | epoch63旧cancel processed，新epoch66无旧end；document27→28后新doc零touch/scroll，Client未再发送旧terminal | 未执行 |
| child销毁 | 下述隔离通过但终止反馈阻塞，未计完整通过 | targetloss前被layout变更cancel，未删除child；未完成 |

暂停用例只将**超过2秒无进展、同旧sequence的owner lost**按root裁定分类为预期过期拒绝，不称正常momentumEnd完成；其他未知拒绝未放行。firstmove按真实157 baseline的每packet语义判断，未要求后续整个序列零滚动。start拒绝仍写diagnostics，截图没有可见banner，不宣称零reject。

157 child销毁：原`v157-targetloss`及补证`v157-targetloss-confirmed-before/after`。补证先实际看见child touchstart/touchmove与scroll30，再由页面command删除iframe；随后同document30/旧sequence的move和end明确code5 `Invalid touch contact transition`，自动cancel code5 `No touch sequence to cancel`。root零touch/零滚动，没有误投root；但实际查看截图出现“触控结束尚未确认，请重新连接以恢复输入”遮罩。**不把此函数返回当终止生命周期通过**；销毁失效分类与恢复体验交root审阅。此前不等待child上报的一条`targetloss-verified`准备样本不单独作为销毁证据。

89正常组最后`v89-raf-pause-recovery-tap`保存时间18:52:02.791Z。02:52:16.465（UTC+8）Browser log96出现ERROR `RemoteKitCaptureToAtlas invalidated generation=46 classification=fatal reason=external destination delivery disconnected before Done`，42ms后generation47 configured。无FATAL CHECK、GPU unusable、Browser重启，GPU进程37432 crash-count0。紧随targetloss导航的真实down被Client layout更新cancel，child有start/cancel但无move，夹具“child raw before deletion”断言停住；该组不计销毁验收。不把atlas错误误说成旧BeginFrame fatal，也不静默继续跨代运行。89 layout/doc销毁组尚未执行。

实际查看157 root/prevent-start/held-release/targetloss（含补证）、89 root/prevent-start/held-release/暂停恢复/targetloss PNG；前述通过组无恢复banner，157销毁遮罩如上。QA脚本新增`functionalCases({only:[...]})`便于分组检查，并将firstmove断言按已确认原生语义调整；没有改产品。fixture一度增加中途post后撤回（服务已缓存页面，未影响本次证据）。

结束已关闭所有自有contexts与默认host Browser，fixture `/shutdown` 200；自有fixture37760、Endpoint43960、Browser34284、GPU37432均已消失，未碰PID7816与其子进程，GPU已释放。未进行实体触屏、移动软键盘、持续每move preventDefault新增用例或任何性能/稳定性尾跑。当前专项QA评分3/5：常规行为证据齐全，销毁终止体验及89 invalidation仍阻止完整通过。

## attempt3当前证据与阻碍

2026-11-03后续一次有界BeginFrame诊断：有效目录`develop/tmp/client-gesture-beginframe-diagnostic-20261103-run2`，完整out/dev Browser SHA `8801e1d7b138ce56c591ece979be9e2c98685c73ecd5011e412aea2637d67caf`、Viz DLL SHA `7c25d45bc7cfff2eb49d7ebebfbd1424c7f519f8d3626597366ff5652545e107`匹配。只跑root→nested→none→导航/off-axis→prevent-start→lateUP100各一次，再静态观察；Stopwatch180.089秒无pending_ack/reporter fatal，Browser仅一次启动、6组均instance1。root与lateUP最终510、nested324/root0；消费仍以正常raw完成及被拒惯性记录。未跑89、完整专项或性能矩阵，也不宣称BeginFrame根因已解决。现有source诊断lastSourceAgeMs依次211.62/212.60/225.64/210.74/223.45/294.12，首包wrapper排队延迟.6/49.6/.2/69.4/66.3/67.3ms；原source elapsed、原始wire和lastDispatchWallMs保留在`diagnostic-summary.json`。未暴露逐事件native runtime timestamp，不能据没有reporter fatal推断所有运行时间戳已实测。180秒watchdog关闭fixture后才截`diagnostic-end.png`并关闭客户端，此时恢复banner/peerCount2属于主动停服务后的状态，不是运行期恢复。所有自有资源已关闭、GPU释放。初次无run2目录的启动因PowerShell JSON DateTime丢UTC解析导致watchdog提前退出，任何轨迹前停止，其“180秒”自动记录无效；该错误证据保留，不计一次产品诊断。

目录`develop/tmp/client-gesture-runtime-20261103-attempt3`，Browser SHA256 `5c458923835c6121e8c2967c6659a983bfc8cf87327c6eca1c8e7f1d96c6a773`，其他产物不变。默认root DOM510，Client220+289.8148，误差.1852DIP；tap click1、nested324/root0。none、pan-x/pan-y主轴仅对应轴滚、off-axis禁止、pinch-zoom禁止平移均有实际DOM。允许pinch scale3、none1、pinch-only2.33；第二指none保持scale1/零滚动。OOPIF child滚动301/root0且snapshot多renderer PID已断言。normal/middle70/lateUP100最终rootY510/509/510，累计值差在原容差内，terminal processed。这些样本均instance1/同connection、组内媒体身份稳定，但期间GPU进程恢复，不能称完整无运行异常验收。

start消费实际preventDefault:true、8touchmove+touchend、零滚动、terminal processed；随后momentum精确拒绝`Momentum was not allowed`并cancel。截图实际查看无可见banner，后续firstmove/pinch/OOPIF仍可输入；未单独做消费后tap，也未直接采集diagnostics.error（源码仍会写入）。firstmove只消费首move，后续滚custom306，原整序列零滚断言未改。root要求的纯static Chrome157同fixture同source对照，首move实际preventDefault:true后也继续滚custom274、8touchmove+touchend，证据`native157-firstmove.json/.png`；惯性不同，不用距离互判。消费判据由root据原生事实裁决。

GPU时间线统一UTC+8（metrics receivedAt为UTC）：02:07:15默认root、26tap、30root、34nested均早于首fatal；02:07:38.576首`external_begin_frame_source_mojo.cc:172 !pending_ack_`与none结束/下一导航边界重叠；02:09:58.235第二次在off-axis样本后、prevent-start前；02:11:37.213第三次紧随lateUP100（02:11:36）后。随后gmb pool shared_context_state连崩，02:11:39.436 Browser GPU unusable退出，40.026重启；42.411恢复renderer出现compositor_frame_reporter时间DCHECK。terminal-held-before样本02:11:57已经instance2/peerCount2/新connection，该样本及之后Missing plane不计此前instance1通过，也不计lifecycle通过。完整stack见`endpoint/sessions/1/browser.log`，每组汇总`case-summary.json`，已实际查看`v157-lifecycle-blocked.png`为正在恢复。

QA夹具修正：pan-x原用Y主轴却要求X滚是错误，改匹配主轴并新增off-axis禁止；同case导航等待新timeOrigin及无overlay；保存仅当前case telemetry并裁剪累计公共trace，保留当前原包，避免413。start消费仅允许精确匹配momentum包及该错误的拒绝，raw/terminal仍必须成功；firstmove原断言未放宽。custom contexts、默认host Browser、RemoteKit fixture及纯static对照服务均关闭，GPU已释放。lifecycle完整组、invalidation、89和实体触屏/软键盘仍未完成。以下为旧attempt历史，不覆盖本轮证据。

## direct→momentum尾差最小判因

证据`develop/tmp/client-gesture-runtime-20261103-no-resample`，沿用attempt2相同Browser/Endpoint/Control产物，仅fixture通过`--browser-disable-features=ResamplingScrollEvents`改变服务Browser的feature。normal和第4个move延迟70ms均使用原source时间0/20…160/170ms、8×-27.5DIP；实收source elapsed存在0.1ms量化，未手造DC输入。两组drag=-220、momentumEnd=-289.8148148，远端DOM最终均510，误差0.1851852DIP；pageScale1、DPR1、viewport1440×812。normal76包/76结果、middle70为78包/78结果，全部ok，terminal processed且媒体identity稳定。只执行这两条判因轨迹，自有context、默认host Browser及fixture随后全部关闭，未跑完整功能组。

生产ScrollPredictor CPU复现见`develop/tmp/scroll-handoff-predictor-before.log`：frame/source偏移-10/0/+10ms，drag输出199.375/213.125/226.875而应220，momentum均完整289.8148；源码在首Momentum时直接停用resampling，未flush direct预测尾差。该证据说明不能把固定38.8DIP加回，也不能恢复native fling。root批准正式离屏Browser关闭服务端第二次重采样，独立demo和Viewer策略保持默认；代码及边界见`docs/client-gestures.zh-CN.md`。此处最小判因通过不代表新正式构建全专项通过。

最新attempt2：`develop/tmp/client-gesture-runtime-20261103-attempt2/service.json`；Browser SHA256 `a677b3039439c30feb106082e790b57d5708a54eaeea18d9a06c79104c3e869c`，其他产物不变。首tap真实可信down/up、client-v1 start/end、远端恰一次click、terminal `ok:true,touchPending:false,touchState:processed`，无reject且媒体身份稳定；随后functionalCases中的tap也通过。root-scroll真实DOM最终rootY=471；Client drag累计220、momentumEnd累计289.8148148，预期509.8148148，少38.8148148DIP，失败于原≤3DIP断言。77包及77 input.result均ok、terminal processed，未崩溃、媒体身份稳定。最小时间线见`v157-root-scroll-minimal-timeline.json`及原metrics；`v157-root-scroll.png`已实际查看。后续各组与89均未执行，不得据此宣称无双fling/延迟距离一致。两个attempt证据互不覆盖；自有context、默认host browser与fixture均关闭释放GPU。

本次run为`develop/tmp/client-gesture-runtime-20261103`，产物路径/mtime/大小见`service.json`，三项SHA256与root给定一致。host-managed Playwright首次遇默认profile占用，前owner通过其browser.close释放后重试成功；没有kill未知进程。实际receiver为157.0.8103.15，空workspace通过真实UI新建窗口、地址栏导航fixture，再用CDP touch产生可信Viewer PointerEvents。

失败最小时间线：Viewer可信down/up各一次；原始start/end均`client-v1`，seq1/2，touch sequence `tg3oc3o9kkk:1`，document2/focus5/layout11/outputGeneration2。start返回`ok:true,touchPending:true`；canonical ACK进入`ClientGestureBridge::ForwardGestureEvent`后，`ui::CreateWebGestureEvent`于`blink_event_util.cc:323`触发`FATAL NOTREACHED: Unknown device type is not allowed`。end在约6.63秒后返回`stale_file_browser`，随后输入为`browser control unavailable`；远端DOM尚无touch/click记录。peer/video/stream/track身份在该样本保持，但这不代表功能成功。

证据：`metrics/client-metrics.jsonl`（原包、ACK、身份及DOM），`endpoint/sessions/1/browser.log:9`（fatal及完整stack），`v157-tap.png`（已实际查看：Browser已离线banner及等待恢复）。通过自有context.close、默认host browser.close及fixture `/shutdown`释放GPU，未执行89或后续组。没有实体触屏/软键盘验证。

## 准备结果与边界

- `tools/client-gesture-qa-server.mts`：单独 Control DB/租户/Endpoint Profile/metrics/telemetry，必须显式提供本批 Endpoint、Browser、生产 clientDir 和两项 grant；产物路径、mtime、大小写入 `service.json`。只通过 fixture `/shutdown` 关闭自己的服务。
- `tools/client-gesture-qa-page.html`：真实 DOM tap、根/nested 滚动、CSS action、start/firstmove preventDefault、自定义 raw touch、第二指 none、跨站 child。记录 DOM pointer/touch/cancel/click/scroll、source DOM timestamp、pageScale 与 rAF 位置轨迹；target loss 通过页面自己删除 iframe 产生。
- `tools/client-gesture-qa-browser.js`：只由 host-managed Playwright 加载；复用 `robust-viewer-qa-browser.js` 的隔离 Chrome89/157，真实 CDP `Input.dispatchTouchEvent` → Viewer PointerEvents → TouchInput/ClientGestures。不手造 touch/gesture DC 包；send wrapper 只记录并按序延迟原包。记录 trusted pointer、raw/候选、elapsed、累计 momentum、实际发送时间、匹配 terminal `input.result`、peer/video/srcObject/track 身份和截图。
- 已执行 Node JS parse、esbuild TypeScript transform、fixture inline JS parse；均通过。没有启动 Control、Endpoint、Browser 或浏览器 context，没有占用 GPU。
- 源码已核对：Browser snapshot `clientGestures:1`；Endpoint 绑定当前 Browser control 的 capability 后写入 layout；Viewer 只在 capability=1 开启新路径。脚本在 capability 缺失时立即停，不能把 legacy 数据算为成功。
- 真实 OOPIF 必须在测试 view snapshot 看见 `renderer_pids` 至少两项，并有 child 自报 origin/scroll。仅跨 origin 的 DOM 不足以证明 OOPIF；脚本已设置明确断言。

## 执行

以下为 root 获得 READY 与独占 grant **之后** 执行的入口，路径由本批构建提供，不默认引用旧包：

```powershell
$env:CLIENT_GESTURE_QA_READY='1'
$env:CLIENT_GESTURE_QA_GPU_GRANTED='1'
$env:CLIENT_GESTURE_QA_ENDPOINT='<本批 endpoint_service.exe 绝对路径>'
$env:CLIENT_GESTURE_QA_BROWSER='<本批 remotekit_browser.exe 绝对路径>'
$env:CLIENT_GESTURE_QA_CLIENT_DIR='<本批 control/dist/client 绝对路径>'
node control/node_modules/tsx/dist/cli.mjs tools/client-gesture-qa-server.mts develop/tmp/client-gesture-qa-20261103
```

默认端口 33581/33582。通过 host-managed `browser_run_code_unsafe` 的 `filename` 先加载 `tools/robust-viewer-qa-browser.js`，再加载 `tools/client-gesture-qa-browser.js`。两次仅安装函数，不会创建浏览器。随后：

```javascript
async host => host._clientGestureQA.launch({
  ready:true,gpuGranted:true,version:157, // 下一轮单独 89
  run:'C:/Users/Flysoft/Desktop/remotekit2/develop/tmp/client-gesture-qa-20261103',
  username:'gesture-v157',password:'<一次性测试密码>'
})
```

每次调用一个组，输出独立结果；不要与其他 GPU 测试或 CPU build 并行：

```javascript
async host => host._clientGestureQA.functionalCases()
async host => host._clientGestureQA.compareTiming()
async host => host._clientGestureQA.lifecycleCases()
async host => host._clientGestureQA.invalidationCases()
async host => host._clientGestureQA.close()
```

157 完成并关闭自有 context 后，同样加载/launch 89；隔离 receiver 现有入口为 `C:/src/tmp/chrome89-google/app/chrome.exe` 与 `C:/src/chromium/src/out/rel/chrome.exe`。不要下载/启动外部 browser runtime。Evidence 全部写上述独立 run 下的 `metrics/`、PNG、`telemetry.jsonl` 和自有 DB/Profile；不提交这些运行数据。

## 初始判定清单（历史准备状态，最终结果以上节为准）

| 组 | 必要证据/断言 | 当前状态 |
|---|---|---|
| ordinary tap | trusted Viewer down/up；client-v1 TapDown/Tap；远端恰一次 click；terminal final result | **attempt2 157通过：click1、terminal processed；89未跑。attempt1 fatal为旧证据** |
| scroll + Client momentum | 原始/candidate deltaX/deltaY；momentum/End elapsed 自 down、累计自 up；DOM 总距离与 drag+Client integral 差 ≤3DIP，不能 native 双运行 | **attempt2 157失败：DOM471 vs Client509.8148，短少38.8148DIP；89未跑** |
| touch-action | none、pan-x、pan-y、pinch-zoom；非允许轴不滚；pinch 正例及 none 反例 | 待运行 |
| custom raw | start/firstmove 真正 preventDefault；不默认滚；raw touchend 保留 | 待运行 |
| nested/OOPIF | 对应 child/nested 滚动、根不误滚；OOPIF 多 renderer PID 证据 | 待运行 |
| 第二指收紧 | 首指 auto、第二指 none；不能继续允许 pan/pinch | 待运行 |
| normal/middle70/lateUP100 | 同 CDP source offset 轨迹，分别只在第4个 move 暂停70ms、UP暂停100ms；累计drag、momentumEnd、DOM总位移/尾部一致 | 待运行 |
| terminal/momentum cancel | 暂存真实 input.result，未放行前不得发新seq；放行可恢复；新down前原momentum cancel | 待运行 |
| cancel/长rAF暂停 | 真正 CDP touchCancel；长2600ms暂停后 source曲线有界、不会无限跳或继续tick | 待运行 |
| document/layout/target loss | 真实导航、viewport变更、child删除；旧输入允许明确失败，但不能投给新document/target；须人工核对各身份及DOM | 待运行 |

`invalidationCases` 只自动断言新 document 无旧 touchstart/move，其余故障组的 expected rejection/身份与 target loss 仍需看证据再判定，不能将函数返回等同全部验收通过。任何失败先保存 evidence 并报告 root，不擅改产品或增加性能组。

## 停止条件与补充

无 client-v1 capability、实际触发 legacy、没有真实 trusted PointerEvents、产物版本不匹配、没有匹配的 final terminal result、OOPIF 无进程证据时停止对应组并记录阻碍。GPU grant 撤销后关闭自己的 context/fixture，不碰其他进程/RDP。每组样本只有功能轨迹，没有 FPS 基准或稳定性复测。

运行后用实际观察改写本文件各状态，并列出脚本异常、产品失败、未覆盖项与 artifact `service.json` 路径；语法检查、CPU probe、运行通过与硬件触屏验证分别报告。
