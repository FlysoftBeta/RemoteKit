# Capture-to-atlas 真实运行

2026-11-01。D2完成20次同RTC导航、尺寸/DPR/多plane往返、Chrome89和普通关闭回归。唯一正式A→B中，候选开启后的真实canvas为 **46.92/46.99FPS、Pixel marker p95 85/89ms**；延迟通过，FPS仍未达到50。后续唯一授权fixed56组回退至43.37/47.73FPS、109/85ms，不能靠提高source预算达标。相同binary的关闭组为44.56/44.00FPS、106/123ms。GPU故障自动恢复、空tab旧ready和故障后退休仍有缺口，不能写成功能全部通过。

## Binary与实验条件

D2 patch7：`d51c5a3d588a9a4d9b379294fa7eddb0c05f8fe75ac90687e0fbcad6d53d172b`。Source整套原位out/dev组件使用相同版本，未复制旧DLL：

|产物|SHA256|
|---|---|
|Browser|D4B6C9AD9ADE3B171FC2DD7FA84A1841AA9C0014ABBC4E2E1EFC3C5544882824|
|Viz service|57BF94D54AB1A9B01CF5106B7948E9780813D7614B6F8A6527254B683B803CC5|
|viz_common|22DB93649D36E20CE12D391667FB0440D9F3D8051F88695DF9629236823CCBDB|
|Endpoint|7A708E4F1AFFC67B5C243845C9345CF4525B1A29204619E43B13C0B84A932E38|

正式case为`develop/tmp/capture-to-atlas-d2-A-fixed52-t2`及`capture-to-atlas-d2-B-fixed52-t2`，先A后B，各自全新干净启动。两租户、10秒暖机+45秒、原1920×1080/DPR1，实际atlas/编码1936×1088、mediaScale1、CRC1Hz；source固定52、adaptive off。A启用CaptureRoot+SinglePlaneDirect，B再启用CaptureToAtlas。Endpoint shared输入、QSV TU7/LPon/VBR/depth1、external/alignment16、36max44Mbps；每peer48Mbps、RTT10ms、RTP0/0。Receiver out/rel Chromium157.0.8103.15，官方fake60、MSTP immutable opaque snapshot/after-work。browser/media/server/official intrusive profile关闭，ResourceProfile开启。没有并发构建、降低分辨率或关闭CRC；刷新是模拟节拍，不是物理扫描输出。

## 唯一正式A/B

|模式/peer|source render|delivery均值|encode均值|RTC decode|真实canvas|marker p50/p95 ms|
|---|---:|---:|---:|---:|---:|---|
|A off/0|51.94|49.90|49.79|49.79|44.56|76/106|
|A off/1|51.98|49.72|49.60|49.55|44.00|80/123|
|B on/0|52.00|51.97|51.99|51.95|46.92|57/85|
|B on/1|52.00|51.91|51.93|51.95|46.99|56/89|

Delivery/encode采用47个秒级Endpoint报告的均值；RTC decode采用采样端点差值。异步Endpoint快照会出现一个采样间隔的滞后，完整差值也保留在summary，不能把这些时钟不同的量强行解释为逐帧相等。A正式paint2006/1981，B2112/2115，RTP+epoch重复全0、missingPaintSnapshot全0；各路CRC45、invalid0，epoch始终1。metrics loader已验证chunk长度与hash。

B read/close2330/2330、2335/2335，invalid/stale0，latest owner保留1，atlasSnapshotCopies0，pending replaced各218；A read/close2229/2229、2220/2220，pending replaced221/237。两组Endpoint private copies均0，lastGpuCopyMs始终null。B编码pendingReplaced/encodeDropped增量0/0、0/0，A5/5、8/8。

|15秒分段|A canvas0/1|B canvas0/1|A marker p95 0/1|B marker p95 0/1|Intel3D A/B %|
|---|---|---|---|---|---|
|0–15|43.27/42.73|47.07/47.07|106/125|66/58|91.47/71.72|
|15–30|44.33/43.80|46.87/47.00|105/109|89/92|89.57/76.90|
|30–45|46.13/45.53|46.87/46.93|75/68|62/64|82.05/69.63|

B各段source52，尾段paint没有继续塌陷，但所有段两路都不到50。每段15 CRC，分段p95按round((n−1)*.95)秩计算，完整45样本用于验收。正式窗口略超过45秒，多出尾帧不在三个15秒段中。初始配对之外，仅按主Agent授权追加下述fixed56组，没有58/60矩阵。

## 资源与实际参数

|资源|A off|B on|
|---|---:|---:|
|有效资源samples|43|45|
|Intel3D均值/p95 %|87.56/98.37|72.75/90.74|
|VideoDecode均值 %|63.42|53.16|
|VideoProcessing均值 %|15.82|14.61|
|整机CPU均值/p95 %|62.77/91.46|47.87/71.32|
|3D source GPU %|42.190|39.678|
|3D source Browser %|11.387|0|
|3D Endpoint %|0|0|
|3D receiver GPU %|33.985|33.071|
|unowned 3D观测贡献 %|0.002353|0.002624|

resource.err均空、gpuErrors均空，没有明显外部GPU负载。各独立引擎不相加；不同进程GPU归因是调度运行时间。B的source Browser角色归零符合browser不再复制整幅图像，但不是仅凭角色归零推导节省，完整整机和其它角色一起报告。本次顺序对照有更低GPU/CPU和延迟；它不改变旧shared最佳46.86/48.26FPS的历史证据，也不证明整体FPS目标已完成。

实际TU所有报告为7，LP requested/queried/initialized均16，QueryStatus5、Init/GetVideoParam0。B applied bitrate最大42.063/39.690Mbps，均未超过44Mbps。B held槽均1.13/1.04、p95 2/1；capture→ready秒级last-value p95 3.66/3.42ms、encode p95 10.57/9.85ms；A对应17.64/16.68ms、15.48/15.12ms。这些不是逐帧GPU timestamp。B draw p95 1.4/1.3ms、marker readback p95 24/26.7ms，A1.9/1.9及37.6/37ms。CRC读回不计入marker定义的呈现时刻。

正式B两路均记录专用池configured、atlas1936×1088、visible4,4 1920×1080、slots3，无真正GPU/interop失败；其中一条启动请求发生typed pre-GPU取消后自动继续。为保持低侵入，正式组未开browser cadence，零browser copy的逐事件证据来自下述同binary功能组，而非补造正式逐帧计数。

## 唯一追加B fixed56

主Agent在确认B52仍有GPU余量后批准`capture-to-atlas-d2-B-fixed56-t2`。仅source固定52改56，D2全部binary指纹一致，其余配置、10+45秒、尺寸/DPR/CRC/网络/码率和接收端保持相同，未并发构建。

|peer|source render|delivery/encode均值|decode|实际canvas|marker p50/p95 ms|
|---|---:|---|---:|---:|---|
|0|55.98|48.79/48.79|48.60|43.37|77/109|
|1|55.98|55.19/55.19|55.23|47.73|58/85|

正式paint1953/2149，CRC各45、invalid0、RTP+epoch重复0、missing0，epoch1。MSTP read/close2185/2185、2480/2480，invalid/stale0、authorized1954/2150、RAF admitted1954/2150，pending replaced231/330，ownerClosed2185/2480，最终latest1、pending0，atlasSnapshotCopies0。MSTP内建total2888/3076与discarded12/17是从processor创建累计，read等应用计数在暖机后reset，不能相减伪造测量窗丢帧数。

Endpoint pendingReplaced/encodeDropped增量均0；私有copy0、lastGpuCopyMs null，capture→ready秒级last-value p95 3.67/4.19ms，encode13.54/12.85ms，held均1.11、p95均2。实际TU7、LP16、external、atlas/编码1936×1088、mediaScale1保持。Viewport draw p95均1.6ms、CRC readback26.7/24.1ms。

|15秒段|source0/1|decode0/1|canvas0/1|marker p95 0/1|Intel3D %|
|---|---|---|---|---|---:|
|0–15|56/56|52.92/55.77|45.53/48.93|76/65|73.00|
|15–30|56/56|50.07/55.57|45.07/47.87|79/81|73.06|
|30–45|55.93/55.93|43.00/54.71|39.60/46.47|109/85|80.81|

44个有效资源samples，Intel3D均75.68%、p9589.48，VideoDecode54.85%、VideoProcessing14.89%，整机CPU均52.81%、p9596.55（44个host-load samples）。3D sourceGPU42.749%、sourceBrowser0、Endpoint0、receiverGPU32.918%，unowned观测贡献0.014508%；gpuErrors空、resource.err空。没有明显背景GPU争用。peer0的漏交出现在上游delivery/encode，随后解码和paint一起下降，source仍56；正式关闭逐帧profile，现有stats不足以把原因唯一归到capture调度或共享槽背压。peer1 decode55仍paint47.73，接收端pending替换仍存在。

B56不支持继续简单升帧率，保留B52为本轮正常运行候选。所有原始分段、逐阶段/MSTP计数、指纹和resource role保留，未追加58/60。自有case/browser和host browser已关闭，GPU释放并通知主Agent可构建。

## D2功能与视觉

`capture-to-atlas-d2-nav20`完成同RTC20次static/animation交替导航，每轮CRC后继续：5000–5020、invalid0、generation1–21。10个静态轮同RTP remount通过。捕到6次origin=same_source_replaced、gpu_work_started0，均typed request_cancelled_before_gpu后恢复，无ERROR；没有把GPU失败当取消。

`capture-to-atlas-d2-geometry`完成1920×1080→1280×720→原尺寸、DPR2→DPR1、双plane→single、RTC重连，CRC4001/4005–4011、invalid0。实际输出gen1/3/5/9/10为1936×1088 direct，gen2为1296×736 direct；gen4 DPR2为3856×2176 fallback（source-slot162、slot clears3）；gen7双plane为3856×1088 fallback（source-stage317、stage-slot178）。返回DPR1及single均新generation，direct各代三种copy全0；中途短命gen6/8各direct1。trace中slot id始终0–2，没有第4槽观测。三个独立token/fresh-slot snapshot未另行抓取，不能把generation编号本身当token证据。

`capture-to-atlas-d2-video89`使用Chrome89.0.4389.90默认video/snapshot、无fake刷新，首帧/鼠标/IME commit与重连CRC3001/3002、invalid0，实际1936×1088、H26442e02a。Sol查看Chrome89初次UI、现代receiver返回single的UI及初轮完整1920×1080 decoded图，marker、输入框、文字、色块和画面边界正常；fixture原有诊断文字覆盖仍在。未操作用户桌面键鼠。

## 生命周期和故障缺口

`capture-to-atlas-d2-lifecycle`普通关闭全部tab→新建tab，同RTC恢复CRC6001，generation1→3。空tab800ms快照仍保留旧layout、displayReady=true；主Agent已单列修复，不能写完整输入失效门通过。

仅对本case进程树做故障。source22780/GPU16720停止后，Chromium记录GPU exit−1并在72ms重新初始化；媒体不恢复，显式RTC重连gen4、CRC6002成功。第二次source23752的GPU故障，15秒前后RTP2762636887、canvas5667完全不变，connection不变、ready仍true；显式重连gen2、CRC6005恢复。故障记录在metrics中的gpu-fault-automatic/15s及lifecycle-stage，首轮PID/时刻在gpu-fault.json，GPU日志在sessions/sessions/3/browser.log。

Browser退出第一次停止22780，4秒时进程/页面已恢复但Viewer仍loading，随后显式重连CRC6003成功；第二次停止5104，等待上限25秒内Viewer自动更换RTC并CRC6004成功（新source23752）。因此Browser自动恢复存在，不能用第一次4秒快照称为失败。

故障case有多条atlas terminal retirement incomplete/resources retained，未充分观察旧state最终清空。未见提前Done/旧代覆盖证据，该退休缺口交主Agent源码审计。另有一次脚本尝试跨tool用globalThis保留对象失败，产生的自有receiver6436已按准确profile/PID整树关闭，未残留到正式组。

干净`capture-to-atlas-d2-retire4`完成animation→static→4次close/reconnect，CRC4001/4002/7001–7004、invalid0、generation1–6，无pool close/unfinished。各代borrow/refs0/retire数量187/9/11/10/10/9，最终consumed提交prefix189/9/11/10/10/10，逐一等于Browser最终published；最后代9次borrow而published10、prefix10，覆盖末尾未借帧退休。Close成功还经过本地done等待，再Open均成功，无旧代上限耗尽。Browser cadence在Stop时写出，末lease Done可能随后发生，不能以文件done=publish−1断言未退役。

尚未单独完成慢消费者故障注入、完整四角输入逐点验收和独立token/fresh-slot snapshot；startup三槽背压、跨代与真实GPU lease退休已有运行记录。主Agent明确允许以全新case测正常性能，保留上述功能缺口。

## 先前失败与产物

原`capture-to-atlas-functional-v1`首次driver错误使用旧artifact token，CRC4001已过而上传拒绝；修正临时driver后初次/static CRC4001/4002成功，但gen3导航失败，零direct。D1只加诊断，`diagnostic-v1/v2`各三阶段成功，没有当作已修复；之后`capture-to-atlas-nav20`在第8次导航gen9复现：unsatisfied request析构→error1 unknown/empty，format/destination正确，result0×0、expected1920×1080、age0.569ms、captured/current content7→8、target同(0,1)，没有Skia失败。原日志缺少取消origin，不能唯一断言当时调用点；D2真实运行已捕到same_source_replaced的typed安全取消并完成20轮。

每case保留config/run/fingerprints、原始metrics、source与server/browser trace或resource。正式两组有summary/details、presentation-raw、segments、resource-summary/compact/segments，loader已验chunk。最终所有自有receiver/context/browser、case服务和host browser_close已关闭，3001/3013无监听、无remotekit_browser残留，GPU释放。未修改产品源码、构建或提交；.playwright-mcp未纳入改动。

## 新transport loss映射：同RTC源GPU恢复

`source-gpu-autorecovery`使用patch7 `123f00fe254e66fa27223a6783798a9c023ab2a559922f89ddb3db2f07e57144`，Host33214F2D…、ServiceE58BC7C0…，Endpoint1607…、ControlF86A…；不改写前述D2性能。只对本case源GPU做一次kill。browser.log明确reason0、classification=reconfigure，GPU重建后generation1→2，RTC始终`75818bfb-82b6-4ac0-9e9e-24802c4c4162`，CRC8201恢复。正常close后readyfalse、owners0，2.5秒内无新增configured/复活。配置后有一次typed pre-GPU取消正常重试。

本case没有人为制造service fatal2或未知reason；其拒绝映射仍只有CPU/源码证据，未冒充硬件fatal注入通过。原始日志、PID、逐阶段CRC在对应case目录；全部自有进程与host browser已清理。
