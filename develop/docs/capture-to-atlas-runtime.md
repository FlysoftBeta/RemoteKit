# Capture-to-atlas 真实运行

2026-11-01。首轮真实 GPU 验证证明候选能够直接输出可解码的正确像素，browser 的 capture→stage、capture→slot、stage→slot 和 direct slot clear 均为0。同尺寸导航的第三代输出失败，因此停止性能阶段，没有正式 A/B 结果。

## 首轮功能与阻碍

案例 `develop/tmp/capture-to-atlas-functional-v1` 使用整套 source out/dev component 产物，Endpoint 7A708E4F1AFFC67B5C243845C9345CF4525B1A29204619E43B13C0B84A932E38，receiver out/rel157 官方 fake60。RemoteKitCaptureRoot + RemoteKitCaptureToAtlas + SinglePlaneDirect，1920×1080/DPR1、实际1936×1088，shared输入、TU7/LPon/VBR/depth1、external/alignment16、36max44Mbps、每peer48Mbps/RTT10、RTP0/0、MSTP immutable opaque snapshot/after-work。功能阶段 browser/server trace 开启，未做性能判断。

第一次启动脚本错误沿用了旧case的artifact token，CRC4001已成功但artifact上传被拒；失败保留。修正临时driver的配置替换后重新打开独立tenant，未改产品源码或binary。

第二次运行初次animation CRC4001、静态导航CRC4002均通过，invalid0。decoded artifact为真实1920×1080、pixelsPerDip1；鼠标focus与IME commit生效。Sol查看初次UI和完整decoded图，marker、输入框、滚动文字、色块及画面边缘正常；fixture原有诊断文字覆盖仍在。静态同RTP remount代码已走过，随后进入resume阶段；因最终报告在失败前尚未提交，保留截图与decoded artifact，不冒充完整逐阶段报告。

|browser/generation|direct publish|callback|copy三项|slot id|trace中的consumed Done|
|---|---:|---:|---|---|---:|
|12448/1（上传失败次）|169|170|0/0/0|0,1,2|166|
|22960/1（animation）|200|201|0/0/0|0,1,2|199|
|22960/2（static）|10|11|0/0/0|0,1,2|9|
|22960/3（resume）|0|1|0/0/0|无|0|

这些为关闭时browser cadence文件中的观测，不能用Done计数差直接判断提前释放或最终退休；完整跨代lease证据尚未分析。源页resume仍以约52FPS运行，末marker stimulus0，接收端却继续显示上一页4002。Endpoint报告 `atlas producer failed status=4 expected_generation=3 publication_generation=3 frame=0`。Browser日志：20:53:32.832配置generation3，20:53:32.844报 `external destination copy failed`；没有GPU进程崩溃日志。

失败来自 `FrameSinkVideoCapturerImpl::DidCopyFrame` 的合并校验，可能是empty、format、destination或size之一；当前日志没有区分这些条件，因此不能断言DXGI interop失效。generation1/2持续direct发布、成功解码和CRC已说明实际硬件路径能够工作。具体ProduceSkia、三个固定token及active snapshot还需后续补充捕获，现有trace只明确slot id为0/1/2。

建议经主Agent审定后，先补该校验的result四项及expected content几何诊断，再视结果补CopyOutputRGBA early-return原因；不靠静默fallback继续性能。

## 尚未覆盖与清理

未完成resume/重连、Pause/Close完整退休、resize、DPR2/multiview往返、慢消费者、GPU子进程故障、Browser退出恢复、Chrome89回归及正式两租户A/B。原先目标仍未达成，未降低分辨率、关闭CRC或改变控制变量。

全部自有receiver/context/browser在driver finally关闭，case stop与host browser_close完成；3001/3013无监听，无remotekit_browser残留。GPU窗口已释放。未改代码、未重编、未commit。

## 诊断版两次导航复现

主Agent批准只加失败诊断后，整套out/dev已增量更新，Endpoint不变。`capture-to-atlas-diagnostic-v1`与`capture-to-atlas-diagnostic-v2`严格重复initial animation→static→animation，各一次；两次均成功，CRC4001/4002/4003、invalid0、opaque alpha=false，尺寸和DPR保持原值。每case RTC connectionId保持不变，layout generation1→2→3，未重启WebContents；static同RTP remount前后RTP、owner及成功canvas计数相同，输入ready保持true。

|case/generation|direct publish|三种copy|出现的slot|
|---|---:|---|---|
|diagnostic-v1/1|186|0/0/0|0,1,2|
|diagnostic-v1/2|10|0/0/0|0,1|
|diagnostic-v1/3|142|0/0/0|0,1,2|
|diagnostic-v2/1|190|0/0/0|0,1,2|
|diagnostic-v2/2|9|0/0/0|0,1|
|diagnostic-v2/3|142|0/0/0|0,1,2|

两次browser.log都只有三次configured，无failed、unsatisfied、Skia或GPU错误；因未复现失败，没有得到empty/error枚举、format/destination和result size/expected失败值。原失败仍成立，不能把两次成功当作修复证据，也没有改变失败策略或继续正式A/B。完整逐阶段记录已写各case的metrics/client-metrics.jsonl；第二case另有diagnostic-summary.json与stages-summary.json。

实际components_viz_service.dll SHA256=`6630C67BC4494030EDEEE9B21557222E5E854152164EB365042D8561E26441AA`，viz_common.dll=`E0E041AF6F692F786988B23E28B151D98105B2C97003F34397D0375EC6066A37`；各case补全相关component指纹。两case自有receiver/context/browser、case服务和host browser全部关闭，3001/3013无监听、无remotekit_browser残留，CPU/GPU窗口释放。未修改产品代码或构建。

## D1压力复现：第8次导航失败

`capture-to-atlas-nav20`计划在同一RTC交替static/animation导航20次，每轮先输入并确认CRC才继续。实际初次及前7次导航成功：CRC5000–5007、invalid0，generation1–8，同一connectionId `da2cc59c-4848-487d-a4ea-b937df404f05`。静态轮均保留同RTP remount校验。第8次导航（static→animation、generation9）失败后立即停止，没有跑余下12次或正式性能。

D1捕获的具体失败：

- CopyOutputRequest析构未满足请求，随后SendError，error_code=1。
- result empty=1、error=unknown、error_code=1；format=0及destination=1与expected一致。
- result rect/size为0×0，expected result1920×1080；expected content为4,4 1920×1080，coded1936×1088、visible4,4 1920×1080、natural1920×1080。
- capture_frame3、oracle_frame3；captured_content_version7、current_content_version8；captured/current target version相同；requested/resolved FrameSinkId均(0,1)。
- started1、pool_invalidated0、context_provider1、reserved2、request_age_ms0.569。
- 同一日志没有Skia early-return或GPU错误。generation9只完成bootstrap callback1，没有direct publish；Endpoint最终status4/frame0，接收端继续旧CRC5007。

证据表明本次是未满足CopyOutput请求析构产生的空结果，并非format/destination不匹配；未满足请求来自哪个拥有者仍需定位，不能直接归因DXGI导入失败。原始日志在 `develop/tmp/capture-to-atlas-nav20/sessions/sessions/1/browser.log`，每个成功轮单独写入metrics/client-metrics.jsonl，保留所有trace和截图。没有修改源码或失败策略。

失败后receiver/context/browser finally关闭，case stop与host browser_close完成，3001/3013无监听、无remotekit_browser残留，GPU已释放。其余生命周期、故障恢复、Chrome89与正式A/B仍待修复后继续。
