# Endpoint shared BGRA 输入实验

2026-11-01。已实现并验证直接租用 browser 三个共享 BGRA 槽，省去 Endpoint shared→private 的整幅 CopyResource，保留现有 SDK/lease 语义。两租户固定52同负载对照实际canvas **46.86/48.26FPS、Pixel marker p95 83/94ms**，相比copy的40.20/40.51、128/126有明显收益，尚差FPS。adaptive组38.67/43.93、112/121受到不同上游负载影响，不能孤立判断省copy收益。默认仍为 `--atlas-input=copy`；`shared` 只允许 QSV、external VPP、async depth 1，不更改共享 ABI、SDK ABI、槽数或 Fence 协议，不增加逐帧跨进程通信。

## 所有权与 GPU 退役

每 generation 独立账本按实际导入的 ready 值排序，允许有洞。CPU 先确认 producer ready 已完成才交付共享纹理；shared 路径不向 immediate context 排 future-ready Wait。原有 latest、SDK TextureBuffer、worker 和 TailRefreshLease 保留全部 retain/release，纹理直到最后真实 lease 结束前 immutable。安全前缀可以覆盖从未借用的旧 publication：遇到首个仍 held 的记录 V，最大前缀是 V-1；全释放时到 last_observed。只提交大于 retired_prefix 的新值，Commit 只删除实际 value≤prefix 的已释放记录。Fence 的比较语义不要求 ack 值本身对应一个真实 publication。

Worker Enqueue 独立 retain，Convert、busy 重试、hardware completion/cancellation 全程保留。converter 未确认 GPU 完成的失败会保留 job lease。因此零引用可证明不会再有未来读取；此前读取已提交到 pool/converter 共用的 immediate context。Release 回调只修改引用，不进入 D3D。单 owner Poll/Open/ReapRetired/Close 从最老记录收集安全前缀，在 context 上 Signal(consumed,prefix)，随后 Signal 本地 done 和 Flush。GPU 队列保证源放行排在已提交的真实读取之后。

任何 Signal 失败都不提交账本并置 untracked_read，停止当前输出并保留资源；consumed 成功而 done 失败同样不重试或回滚。旧 generation 等全部 refs 归零且 done 完成才回收；device removed 可结束 GPU 等待。Close 先检查 lease，再提交退役并等待本地 GPU barrier，不能用关闭强制归还仍可读取的帧。

## 统计

`atlasCopies`/`atlasCopyFps` 继续表示真实 private copy，shared 时为 0，`lastGpuCopyMs` 为 null。`atlasDeliveredFrames`/`atlasDeliveredFps` 独立统计交付；`atlasSharedBorrows` 为累计借槽，`atlasSharedHeldSlots` 是当前 generation 仍有 refs 的槽数，`atlasSharedRetiredPrefix` 是当前 generation 已成功提交的 consumed 前缀。最后一个值代表提交，不冒充 GPU 完成观测。

## 第一轮功能发现

`develop/tmp/shared-atlas-functional-trace`：原 1920×1080/DPR1、实际 1936×1088，MSTP immutable snapshot、receiver 157 官方 fake60 刷新，source CaptureRoot+SinglePlaneDirect，TU7/LPon/VBR/depth1/36max44Mbps、external/alignment16、48Mbps/RTT10ms、RTP0/0，CRC 保留。

共享纹理真实 CreateVideoProcessorInputView 和 VideoProcessorBlt 成功，两次 `vpp_complete`，H264 首帧和一次尾 IDR 成功。但初始只交付 source frame3/fence3，之后不再有新帧，输入 CRC 一直 stimulus0。trace 显示 latest 保留最后一个 ref，直到 close 才归零并退役 fence3。根因是 Endpoint Open 前 browser 三槽已填满，Endpoint 只观察最新3，未借用的1/2也未 ack；latest3等待新帧替换而 browser 等待空槽，形成互等。

此失败后停止性能阶段。主 Agent 批准上述 skipped 安全区间推进，启动时先借3、下一 Poll Signal2、保留3的 immutable lease，于是 browser 可产生4。`shared-atlas-functional-v2` trace 实际确认该顺序，后续各 generation prefix 严格单调。

## 修正后功能验证

`shared-atlas-functional-v2` 完成初次、静态、恢复动画、重连，CRC4001/4002/4003/4004，invalid0。静态同RTP重挂载继续显示并授权输入，重连前接收端owners清0，source generation1→2。516次shared borrow、514次VPP和hardware completion；关闭时516条真实lease记录全部退役。

`shared-atlas-resize` 完成 1936×1088→1296×736→1936×1088，对应 viewport1920×1080→1280×720→1920×1080，DPR1、generation1→2→3。CRC4001/4005/4006、invalid0；520次borrow、514次VPP/hardware completion，关闭时520条lease全部退役。两个case均没有private copy事件。截图检查marker、文字、色块与边缘正常。恢复指导航后继续animation及尺寸恢复；没有做破坏性GPU恢复。

## 两租户 adaptive 正式组

案例 `shared-atlas-adaptive-t2`，10秒暖机+45秒。原1920×1080/DPR1，实际atlas/编码1936×1088、mediaScale1、CRC1Hz；source CaptureRoot+SinglePlaneDirect，receiver157.0.8103.15官方fake60刷新，MSTP immutable snapshot/after-work；TU7/LPon/VBR/depth1/36max44Mbps、external/alignment16、每peer48Mbps/RTT10ms、RTP0/0。browser/media/server/official profiling关闭，ResourceProfile开启；计时没有CPU构建重叠。非物理扫描输出验收。

|组/peer|source render|实际delivery|private copy|encode|RTC decode|真实canvas|marker p50/p95 ms|
|---|---:|---:|---:|---:|---:|---:|---|
|copy immutable adaptive/0|43.12|42.97|42.97|41.91|41.77|39.24|76/108|
|copy immutable adaptive/1|47.29|46.19|46.19|45.04|45.86|42.68|73/105|
|shared adaptive/0|48.35|42.70|0|42.65|42.59|38.67|88/112|
|shared adaptive/1|59.96|50.89|0|50.63|50.52|43.93|87/121|

两路正式窗口成功paint1741/1978帧，RTP+epoch重复0，missingPaint0，CRC各45、invalid0。`atlasCopies`始终0，`lastGpuCopyMs`始终null，真实delivery独立记录。MSTP read/close1902/1902、2260/2260，invalid/stale0，应用层atlasSnapshotCopies0；秒级统计含reset前已有owner，因此ownerClosed与read不需要从0一一相减。QSV实际TU7、LP requested/queried/initialized16，queryStatus5、init/get0。

peer0相对首个stats的目标：0s44→2s46→7s36(pipeline_pressure)→9s38→11s40→12s42→14s44→15s46→18s48→20s50→24s52，此后52；peer1全窗target/applied60、healthy_recovery。各47个秒级samples，held槽均值1.15/1.32、p95均2，pendingReplaced增量1/13，低于copy旧49/52。capture→ready秒级last-value p95为26.33/23.44ms，encode p95为18.50/19.96ms；不把这些值当逐帧GPU timestamp。

44个有效资源样本，Intel3D均值95.11%、p95约100.06%（PDH窗口可能轻微超过100），VideoDecode66.31%、VideoProcessing16.32%，整机CPU均67.37%。Intel3D角色拆分：sourceGPU47.503%、sourceBrowser12.213%、Endpoint0%、receiverGPU35.392%、unowned0.00375%。resource.err空、gpuErrors0，无明显外部GPU争用。共享资源的调度归因和更高上游帧率同时变化，Endpoint角色变0不等于整机GPU节省了旧12.80%。与copy adaptive相比source48.35/59.96也高于43.12/47.29，不能将两组视为同输入负载实验。

正式loader验证metrics chunk长度/hash，analyze兼容旧记录并增加delivery/borrow。case保存summary/details、每peer target时间线、raw presentation、resource、config/run/fingerprints及source trace。自有receiver/context/browser关闭、case stop、host browser_close完成，3001/3013无监听且无remotekit_browser残留。

## 固定52同负载对照

主 Agent 根据adaptive不同输入负载批准追加一组fixed52，与旧copy fixed52配对。使用最终atomic修复binary，先在`shared-atlas-final-smoke`完成首帧/输入CRC4001 invalid0，再跑`shared-atlas-fixed52-t2`。仅adaptive off、source固定52，余下尺寸、码率、网络、CRC、刷新、MSTP immutable snapshot、10秒暖机+45秒保持相同。

|模式/peer|source render|delivery|private copy|encode complete|decode|canvas|marker p50/p95 ms|
|---|---:|---:|---:|---:|---:|---:|---|
|copy fixed52/0|52.00|51.85|51.85|42.49|42.49|40.20|100/128|
|copy fixed52/1|52.00|51.92|51.92|42.76|42.72|40.51|103/126|
|shared fixed52/0|52.00|约51.60|0|约51.58|51.51|46.86|64/83|
|shared fixed52/1|52.00|约51.54|0|约51.52|51.49|48.26|82/94|

delivery/encode此处shared为47个秒级report的均值；精确sample端点差值与原始数据保存在summary/details。正式paint2110/2173帧、RTP+epoch重复0、missingPaint0，各CRC45且invalid0。MSTP read/close2318/2318、2316/2316，invalid/stale0，atlasSnapshotCopies0。端点pendingReplaced/encodeDropped均0/0（旧copy为421/411）；held均值1.15/1.17、p95均2。capture→ready秒级last-value p95 13.00/13.60ms，encode p95 13.97/13.47ms。viewportDraw p95均1.5ms、markerReadback p95 18/15ms。

|15秒分段|copy canvas peer0/1|shared canvas peer0/1|shared marker p95 peer0/1|Intel3D copy/shared %|
|---|---|---|---|---|
|0–15s|40.67 / 40.93|46.73 / 47.87|78 / 93|97.57 / 84.03|
|15–30s|39.20 / 39.87|47.07 / 48.47|67 / 94|97.97 / 86.05|
|30–45s|40.80 / 40.73|46.80 / 48.47|73 / 88|97.78 / 84.63|

各分段source52.00，marker各15次。分段p95按分析工具`round((n-1)*.95)`秩计算；少量样本的分段p95不能替代完整45样本的验收p95。45秒之外多出的约27ms可多计1帧，所以三个15秒paint count相加与全窗差1不代表重复。分段源/交付/编码/解码/paint/marker及资源归因保存于`segments.json`和`resource-segments.json`。

44个有效资源样本，shared Intel3D84.92%、p9596.45（copy均97.78），VideoDecode60.83%、VideoProcessing15.07%，CPU50.71%。3D角色sourceGPU39.199%、sourceBrowser11.507%、Endpoint0%、receiver34.216%、unowned0.000762%；source GPU接近copy39.88%，receiver由30.88升至34.22与更高decode/paint负载一致。各角色细项按段保存，不把独立引擎占用相加。resource.err空，gpuErrors0。所有case与host browser已关闭，CPU/GPU窗口释放。主 Agent 在该结果后批准追加唯一fixed56组，验证提高源预算是否能补足接收端相位损失。

## 固定56追加组

`shared-atlas-fixed56-t2`只将source目标52改56，其他条件、binary及10+45秒相同，未改代码或并发构建。实际source55.96/55.98、delivery约51.11/50.47、encode约51.07/50.37、decode51.16/50.54，真实canvas **45.27/44.67FPS、marker p95 121/109ms**，比fixed52回退。各CRC45、invalid0，paint2038/2011帧。private copy0，pendingReplaced/encodeDropped4/5，held p95均2；capture→ready秒级last-value p95 22.56/21.42ms，encode p95 18.05/19.52ms。

|15秒分段|source peer0/1|canvas peer0/1|marker p95 peer0/1|Intel3D %|
|---|---|---|---|---:|
|0–15s|56.00 / 56.00|44.13 / 44.93|117 / 97|96.25|
|15–30s|55.93 / 55.93|46.33 / 44.87|123 / 98|96.25|
|30–45s|55.93 / 56.00|45.40 / 44.27|97 / 109|95.23|

45个资源样本，Intel3D95.91%、p9599.46，VideoDecode69.34%、VideoProcessing17.17%，CPU66.86%。3D角色sourceGPU45.935%、sourceBrowser12.793%、Endpoint0%、receiver37.177%、unowned0.00104%；没有明显背景争用，resource.err空、gpuErrors0。真实delivery/decode仍约51而上游增载推高GPU占用，结果不支持继续简单加source FPS。source/encode/decode/paint/CRC的完整分段与资源归因同样保存在case的segments与resource-segments。

本轮最佳保留shared fixed52：两租户延迟已在100ms内，canvas仍为46.86/48.26，整体目标未完成；是否调整接收端相位/呈现路径或继续其它优化由主 Agent 接手。没有继续升帧率或降低分辨率、关闭CRC。自有case及host browser全部关闭，3001/3013无监听、无remotekit_browser残留，CPU/GPU窗口已释放。

## 已完成检查

Endpoint verify-media 增量编译及6项 CTest通过，package 增量构建通过。adaptive组后将跨Stats/Open读取的shared_input改为atomic，再次verify-media6项与package通过；该同步修正未改变渲染逻辑，没有重跑adaptive。新增纯 retirement policy 回归覆盖启动3→skip2→继续4、乱序 release、最老多 owner、连续fence holes、partial prefix、generation隔离、失败不commit、无新prefix不Signal、关闭前 refs 屏障及回归值拒绝；硬件 Signal 失败没有做故障注入。

fixed52/56使用atomic修复后的同一binary，实际指纹分别保留在各case。最后修正仅server trace字段：retirement事件的`completed_fence`改读实际consumed完成值，排队的本地done ticket放`cookie`，避免误读为实际GPU完成；该改动在GPU全部关闭后再次verify-media6项通过，正式组server trace关闭。未修改Browser/Chromium、SDK ABI或Control，未commit，由主 Agent 统一处理。

最终trace字段修正后的Endpoint SHA256为`1BB936B74FBBF42A59171E31041C1C7A2E494B6D54051A1A95DFBBDC7F7D8B29`。fixed56正式paint2038/2011、RTP+epoch重复0、missingPaint0；秒级诊断canvas2040/2013包括正式startedAt之前已发生的2次paint，不用于改写正式FPS。
