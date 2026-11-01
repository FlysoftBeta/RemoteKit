# TrackProcessor 有界实播

2026-11-01。MSTP 接收路径完成首次实播、输入门修复与功能回归；两租户真实 canvas **39.07/41.47FPS、Pixel marker p95 103/107ms**，各45个有效CRC、invalid0，尚未达到每peer≥50FPS且p95≤100ms。按主Agent给定停止条件，不追加固定52或重复组。默认关闭，Chrome89/default video继续保留。

## 发现与修复

首轮 `develop/tmp/processor-functional` 连续两次初次输入失败：MSTP read循环先 frameGate.observe(newRtp)，随后只保留clone等RAF绘制；接收新帧让 displayReady/canInput 立即失效，当前已绘制同epoch plane也在此等待窗口被拒绝输入。第二次trace显示700,500点击成功，200ms后的400,30 down/up及再200ms后的IME被 unmatched-or-unpainted-frame 拒绝；CRC有效但stimulus仍0。证据为 input-block.json、metrics/client-metrics.jsonl和initial-ui.png。

经主Agent确定边界后，transport read仅更新独立pending owner/RTP；RAF仍快照选中的immutable VideoFrame，metadata未知时保存快照但不变更当前授权。下一RAF的准入先用非变更epochFor(candidate)和真实尺寸校验，匹配当前layout epoch后才同步observe、交换snapshot并paint。未知/迟metadata不撤销当前画面资格，真正layout/geometry epoch改变仍立即拒绝旧输入；没有用未画帧授权输入、取消epoch检查或把read算paint。video路径不变，未新增gate接口。

新增回归覆盖read推进但RAF未执行、未知/错误epoch metadata、正确metadata下一RAF准入、geometry epoch立即拒绝、disconnect释放owner。原取消source/迟帧/无RTP/尺寸错误/close测试保留；61 tests、TypeScript、Vite build、server bundle和production startup smoke全部通过。只重建Control，未重建Endpoint/Chromium。

## 功能运行证据

`develop/tmp/processor-fixed-functional` 使用receiver157.0.8103.15精准fake60、continuous feature off；原1920×1080/DPR1，actual atlas/视频1936×1088，source root capture及source SinglePlaneDirect；MSTP/snapshot/after-work、adaptive on、TU7/LPon/VBR/depth1/36max44Mbps、external/alignment16、48Mbps/RTT10ms、RTP0/0，profiling全关。以下均从实际同RTP plane读CRC：

|阶段|CRC stimulus|epoch/generation|结果|
|---|---:|---|---|
|初次|4001|1/1|鼠标400,30及IME成功|
|static导航并等待静止|4002|3/1|静止后输入使画面恢复并读回|
|恢复animation|4003|6/1|动态画面恢复|
|重连|4004|7/2|新connectionId、输入与CRC成功|

各阶段invalid0；MSTP的DOM video未绑定、videoWidth/Height均0，真实processor/RTC为1936×1088。重连close后旧source与pending均清空、displayReady=false、read=closed=ownerClosed=344，无遗留owner。新peer正确恢复。

另在 `gap.js` 专门等到真实 pendingProcessorFrame 存在、尚未RAF绘制时发两次点击和IME。三次pending RTP分别3958767064/3958786504/3958805764，当前实际displayed为3958763914/3958783444/3958802974，全部ready=true、输入发送成功、blocked0，并实际读回CRC4101/invalid0。完整结果在gap-result.json。

`develop/tmp/processor-default-video89` 用真实Chrome89.0.4389.90、原receive profile、默认video/snapshot、无fake刷新flag。初次和重连均1936×1088/H264 42e02a，实际CRC3001/3002、invalid0，鼠标400,30/IME通过。Sol核查修后MSTP重连、Chrome89重连UI及实际解码图：marker、输入框、文字、色块与边界正常，pointer400,30；左下诊断文字覆盖为原fixture现象。

## 唯一正式两租户组

case `develop/tmp/processor-root-adaptive-t2`，10秒暖机+45秒测量。除MSTP与本次输入门修复外延续root snapshot配置：原fixture、1920×1080/DPR1、actual1936×1088/mediaScale1、CRC1Hz；source RemoteKitCaptureRoot及SinglePlaneDirect；client MSTP snapshot/after-work；adaptive on、TU7/LPon/VBR/depth1/36max44Mbps、external/alignment16；每peer48Mbps/RTT10ms、RTP0/0；receiver157.0.8103.15精准fake60、continuous feature off。browser/media/server/official profiling全关，ResourceProfile开。CPU构建与采样未重叠，使用host-managed Playwright，未操作用户桌面。

|路径|peer|source render|atlas|encode|RTC decode|真实canvas|marker p50/p95 ms|
|---|---:|---:|---:|---:|---:|---:|---|
|原root video/snapshot|0|42.35|—|—|41.09|37.50|70/104|
|原root video/snapshot|1|37.70|—|—|37.23|34.89|72/108|
|MSTP snapshot|0|42.83|42.70|42.08|42.01|39.07|78/103|
|MSTP snapshot|1|45.41|45.25|44.30|44.28|41.47|80/107|

完整metrics经正式loader验证chunk长度/hash并重组，analyze/matrix均使用成功plane paint字段。正式窗口paintedFrames1759/1867、重复RTP+epoch0、epoch始终1；各45CRC、invalid0。所有RTC采样displayReady=true，rawVideoFrames和rVFC均0，processor invalid/stale0，wrongEpoch/missingRtp/missed0。实际source snapshot确认offscreen_root/pixel_preserving_root、root1920×1080；TU实际全程7，LP requested/queried/initialized/GetVideoParam均16，queryStatus5、init/get0。

Processor最终诊断为read1891/1986、closed1891/1986、rafAdmitted1764/1869、replaced128/117、ownerClosed1892/1986、canvas1761/1869。native total2392/2431、discarded3/10为processor生命周期计数，秒级采样窗增量total1891/1993、discarded1/8；JS计数在暖机后reset，ownerClosed可包含reset前已持有的1个owner。诊断reset早于正式startedAt，故canvas诊断比正式paintedFrames多2，不据此替换正式FPS；这些计数不可混作display。

MarkerReadback p50/p95为12.3/19.4ms、9.7/22.5ms；processorSnapshot p95各1.5ms，viewportDraw各0.2ms。秒级Endpoint last-value分布capture→ready p95=16.00/18.33ms、GPU copy13.17/16.63ms、encode13.12/14.54ms；encodePending均值0.106/0.149、p95各1，pendingReplaced增加29/43。adaptive实际上限36–48/36–50，源及编码均未到50，不只是客户端损失。上述Endpoint分布不是全帧trace。

## GPU比较及归因限制

正式窗口44个资源样本，GPU errors0，resource.err为空。整机Intel3D均值88.34%、p9597.61%，VideoDecode51.12%、VideoProcessing13.79%；source GPU3D31.96%、source browser9.66%、Endpoint13.63%、receiver GPU33.09%。Endpoint VideoDecode38.50%、receiver VideoDecode12.62%，保留驱动引擎原名，不相加。collector平均0.392核、collection475.3ms；整机CPU均值46.60%。

旧root snapshot整机3D88.15%、sourceGPU28.69%、receiverGPU30.16%；其非实验dwm6.54%及WUDFHost2.68%，本组44个unowned样本的非实验贡献几乎0。没有停止或操控非实验进程，但桌面/背景负载与旧组自行变化，所以39/41相对37/35的差不能全部归因MSTP。本组仍未达到目标，因此不值得按接近50的条件扩矩阵；没有把一次顺序比较写成确定收益。

## 正式工具与产物

prepare新增 -FrameSource video|track-processor（默认video），拒绝客户端single-plane-direct组合；source SinglePlaneDirect可保留。config/report明确记录，connect前设置transport.frameSource。首帧ready使用真实媒体diagnostics、displayReady、layout和成功plane paint；MSTP不要求videoWidth、readyState或rVFC。RTC decode与plane paint分开，未补造receiveTime/captureTime。

streaming_metrics.measured_paint_fields统一analyze/matrix已知paint stage/version：viewport-paint-v2、viewport-canvas-paint配event-driven-v2、plane-source-v3。未知版本明确缺测，不回退decode。历史真实v2 backing-fixed-1080-t1-marker0与v3 root-capture-adaptive-t2验证保留字段；future-v99被拒绝。PowerShell解析、node --check、Python compile、git diff check通过。root原组用正式loader重组后，matrix已恢复原paint37.50/34.89。

每case保留config/run/fingerprints/原metrics、功能PNG/decoded artifact或性能resource/summary/details。source browser SHA256为1295D21477A609F270F0A922C8C2A0FBEF80626F336AB7BEA5ACD74159AE5C7C，Viz DLL为B3FB7021D3251BB955BE3345258F0100A52AC0D5268676D3F722DA514B161F8A，Endpoint为BFFE36417FBCF2445F73CA5BC0A0330F51F15FD87F0007346D9ABA48645A9CF4。最终client bundle index-CaZRxgFY.js SHA256为4A1D007282E21FC1FC4A2AF8716208108C976D3E8D19CAEA149C58643E780103；fixture SHA256保持4CB517D8BD239E64C79C6D26D66E8FA0E374062046B43EF9813089A2874585F1。

全部自有Control/source/Endpoint/receiver已正式close+disconnect并stop case，3001/3013无监听、无remotekit_browser残留，host browser_close完成。CPU/GPU窗口释放；未commit，由主Agent统一审阅收尾。尚未运行本路径的多plane/HiDPI实播或破坏性GPU恢复；既有单元测试与原生命周期机制保留。
