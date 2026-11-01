# Immutable VideoFrame 直接绘制 plane 实播

2026-11-01。已完成 Control 的 opt-in MSTP 路径改动及功能验证。接收端不再逐帧复制整张 atlas 到 Canvas；所有 plane 同步读取同一个 immutable VideoFrame。两租户 adaptive 组实际 paint **39.24/42.68FPS、Pixel marker p95 108/105ms**，未达标。主 Agent 随后批准一个固定52FPS组，实际 paint **40.20/40.51FPS、p95 128/126ms**；GPU 3D 达97.78%，编码背压显著增加。结果支持保留省去整 atlas copy 的实现和 adaptive，不能靠固定52消除当前性能缺口。本次不再扩矩阵。

## 实现与所有权

范围只有 `control/client/transport.ts` 和 `control/test/track-processor.test.ts`，无 Endpoint、Browser、SDK/ABI、fixture 或正式 harness 改动。`frameSource=track-processor` 继续显式选择，呈现模式仍叫 snapshot，语义是所有 plane 使用同一不可变帧；没有启用客户端 single-plane-direct。默认 video 和 Chrome89 路径保留。

read 原帧仍在 finally close；独立 clone 作为至多一个 pending owner，替换即 close。只有 wire RTP metadata、当前 epoch 和实际视频尺寸匹配时才排 RAF，RAF 再校验最新候选并准入一个。选中帧直接裁剪绘制全部合格 plane，随后保留为 latest owner，以便静止同 epoch 重挂载或迟挂载。旧 latest 在绘制提交之后 finally close；Canvas 内部保有 GPU 读取所需引用。metadata 未到不会撤销已经画好的旧 plane 的输入资格；布局 epoch/generation/尺寸/plane geometry 真正改变时释放 pending/latest，旧像素不再授权输入。disconnect/source replacement 同样回收两者。

MSTP 的 `PresentedPlaneSource` 现在指向实际已显示 plane canvas，sourceRect 从0,0起；pixelsPerDip 仍为 DPR×mediaScale，输入继续根据该 canvas 的客户区矩形映射 DIP，letterbox 不算内容。marker/截图读取该 plane，不读活动 VideoFrame，也没有逐帧按需 bitmap。drawImage 失败只记 `draw-failed`、该 plane 不算成功 paint且不授权输入，latest owner 保留以供重挂载重试。同 RTP 重复 read 会 finally close 原帧，不 clone、不覆盖有效 pending、不再排 RAF；RAF 也有重复准入保护。

诊断明确 `drawing=immutable-frame-planes`、`atlasSnapshotCopies=0`、pending/displayed/retiring/total owners。正常异步时最多 pending1+latest1；同步提交时旧 latest 的 retiring owner 计入真实持有总量，close后0。read、RAF、授权和真正成功 plane paint分别计数。`processorSnapshot` samples 为空、routing.snapshotFrames 为0，表示已删除这一应用层整 atlas copy，不声称 Canvas/驱动内部零拷贝。

## 检查及功能运行

最终 **65 tests**、TypeScript、Vite、server bundle、production startup smoke、git diff check通过。新增/调整的有意义回归覆盖：pending/latest替换与释放、迟metadata不撤销旧输入、真geometry epoch变化、取消和迟read、同RTP重复read、静态重挂载、带偏移与DPR×mediaScale的双plane同源、draw失败后重试、运行时切换不支持的mode。

`develop/tmp/immutable-frame-functional` 完成原1920×1080/DPR1、实际1936×1088的初次、静止后输入、恢复animation、重连，各CRC stimulus4001/4002/4003/4004、invalid0。静止重挂载前后同RTP1118524276、同latest owner、成功新帧计数133不变、sourceRect0,0,1920,1080且输入ready。重连前旧source/pending/latest清空、displayReady=false、read=closed=ownerClosed345、ownersHeld0。修好最终重复保护后又在 `immutable-frame-final-functional` 复跑同四阶段及静态重挂载，全通过。

`develop/tmp/immutable-frame-dual` 实跑两页各960×540 DIP、DPR2，实际atlas2778×792；每plane1377×775，atlas位置为6,6和1395,6，mediaScale0.7173913、pixelsPerDip1.4347826。通过真实 Viewer canvas 鼠标点击和 compositionstart/update/end，两页marker5101/5102、invalid0；截图均显示pointer400,30。实际同RTP1626178882，两个暴露sourceRect均0,0,1377,775，证明atlas偏移没有泄漏进marker坐标。首次测试脚本用Playwright dispatchEvent生成普通Event，data缺失导致IME文本未发送；改成真正CompositionEvent后通过，未改产品代码。Sol检查重连和双plane截图，marker、文字、色块和边界正常；fixture原有能力诊断覆盖文字继续存在。

`develop/tmp/immutable-frame-video89` 用Chrome89.0.4389.90、默认video/snapshot、无fake刷新flag，初次与重连均实际1936×1088/H264 42e02a，鼠标/IME和CRC3001/3002通过、invalid0。此回归在运行时不需VideoFrame构造器。

## 正式组配置与结果

两组均为2租户，10秒暖机+45秒，同组同时测实际成功canvas paint和Pixel marker。原1920×1080/DPR1，实际atlas/编码1936×1088、mediaScale1、CRC1Hz；source RemoteKitCaptureRoot+RemoteKitSinglePlaneDirect，客户端MSTP/snapshot/after-work；TU7/LPon/VBR/depth1/36max44Mbps、external/alignment16、每peer48Mbps/RTT10ms、RTP playout0/0。receiver157.0.8103.15、官方fake60刷新、连续rVFC feature off；无物理显示器扫描验收。browser/media/server/official profiling关闭，ResourceProfile开。CPU构建与GPU采样错开，host-managed Playwright隔离browser，未操作用户桌面。

|组|peer|source render|atlas|encode complete|RTC decode|实际canvas|marker p50/p95 ms|
|---|---:|---:|---:|---:|---:|---:|---|
|旧MSTP Canvas snapshot adaptive|0|42.83|42.70|42.08|42.01|39.07|78/103|
|旧MSTP Canvas snapshot adaptive|1|45.41|45.25|44.30|44.28|41.47|80/107|
|immutable adaptive|0|43.12|42.97|41.91|41.77|39.24|76/108|
|immutable adaptive|1|47.29|46.19|45.04|45.86|42.68|73/105|
|immutable fixed52/off|0|52.00|51.85|42.49|42.49|40.20|100/128|
|immutable fixed52/off|1|52.00|51.92|42.76|42.72|40.51|103/126|

案例为 `immutable-frame-adaptive-t2`、`immutable-frame-fixed52-t2`。正式loader验证metrics chunk长度/hash并重组，analyze使用plane-source-v3成功paint，分别1766/1921及1813/1824帧，每peer45个有效CRC、invalid0、missingPaintSnapshot0。正式paint RTP+epoch重复0，原始paint与match记录重复也均0，epoch始终1。reset略早于startedAt，peer1诊断canvas分别1922/1825，比正式窗口多1；真实FPS使用窗口内paintedFrames，不据诊断总数改写。MSTP read/close全部相等，invalid/stale0，wrongEpoch/missingRtp/missed0，rawVideoFrames/rVFC0；秒级样本ownersHeld仅1或2。QSV actual TU全程7，LP requested/queried/initialized/GetVideoParam均16，queryStatus5、init/get0。

adaptive组最终processor read1877/2065，RAF准入1766/1922，pending replaced111/142，ownerClosed1877/2064；owner计数reset时已有一帧，close数不必从0与read相等。固定52组 read1905/1919，RAF准入1813/1825，pending replaced92/95，ownerClosed1905/1920。两组atlasSnapshotCopies和routing.snapshotFrames均0、processorSnapshot samples0。

adaptive组viewportDraw p95=1.5/1.5ms（旧snapshot裁Canvas为0.2ms），markerReadback p95=19.8/19.6ms。直接VideoFrame绘制的每plane成本更高，省掉一次整atlas copy并不等于消除所有GPU开销。

## adaptive时间线与GPU/背压

每秒完整target/actual/reason、encoded FPS、copy/encode last-value/pending保存在各case `adaptive-timeline-0.json`、`adaptive-timeline-1.json`，统计在 `details.json`；资源归因在 `resource-summary.json`。adaptive peer0实际目标范围36–52：约3s从52降41，9s到36，21s再到36，32s降38，其余以healthy_recovery逐步回升。peer1范围38–56：约9s从52降41，21s从51降40，38s从56降44。下降reason均pipeline_pressure，恢复段是healthy_recovery。固定组disabled且实际目标始终52，源render也真实达到52。

|GPU/CPU 同窗统计|旧MSTP snapshot adaptive|immutable adaptive|immutable fixed52/off|
|---|---:|---:|---:|
|Intel3D均值 / p95 %|88.34 / 97.61|81.62 / 98.32|97.78 / 98.84|
|source GPU3D %|31.96|31.51|39.88|
|source browser3D %|9.66|9.32|11.81|
|Endpoint3D %|13.63|12.80|15.21|
|receiver GPU3D %|33.09|27.98|30.88|
|Intel VideoDecode均值 %|51.12|48.01|56.89|
|Intel VideoProcessing均值 %|13.79|13.00|15.49|
|整机CPU均值 %|46.60|45.86|约58.5|

资源样本旧/新adaptive各44，fixed45，GPU errors0、resource.err空。保留驱动引擎名，不把VideoDecode等独立引擎相加。当前两组non-owned 3D贡献分别约0.00069%/0.00096%，旧MSTP snapshot约0.00124%，均接近0；没有停止或操控非实验进程。receiver3D从33.09降27.98与省整atlas copy相符，但这是顺序实验，不能把全部差值当确定因果收益。

|Endpoint秒级last-value分布|adaptive peer0/1|fixed52 peer0/1|
|---|---|---|
|capture→ready p95 ms|21.70 / 13.67|28.88 / 26.86|
|GPU copy p95 ms|17.79 / 10.63|22.57 / 24.17|
|encode p95 ms|16.90 / 13.52|21.42 / 19.87|
|encodePending均值|0.149 / 0.064|0.468 / 0.511|
|pendingReplaced增量|49 / 52|421 / 411|
|encodeDropped FPS|1.09 / 1.16|9.35 / 9.13|

以上延迟是47个秒级last-value样本的分布，不是逐帧trace。fixed52把源FPS升上去了，但3D几乎持续满、Endpoint copy/encode拉长、背压丢帧增加约8倍，最终canvas约40且marker变慢。当前证据不支持把问题归为adaptive单纯保守，继续放宽策略阈值无法替代降低真实GPU处理成本。

## 构建版本、产物与清理

adaptive正式组在最终去重复保护前测量，bundle `index-CTO-71KR.js` SHA256 `FDC493C605AD62515012CEA67BDFDB2917216C967CFB53F58E54D46755F42DD7`。之后主审补回同RTP保护及mode切换释放检查，65tests/build通过，最终单租户功能复跑；fixed52用最终bundle `index-Dqwv3IsH.js` SHA256 `AC1BA000B5228FE1E92DD089BDF1AF9C6E5B743D321AB6FE81305A07105F09C6`。两正式组原始准入/paint都没有重复RTP，mode全程snapshot。主要配置变化只有adaptive与固定52，代码保护差异在本次组内没有重复准入触发证据。

fixture SHA256保持 `4CB517D8BD239E64C79C6D26D66E8FA0E374062046B43EF9813089A2874585F1`。每case有config/run/fingerprints、原metrics、source trace，正式组另有resource/summary/details/target时间线，功能组有UI PNG与decoded artifact。没有降低正式分辨率或关闭CRC，也没有重建Chromium/Endpoint。

各自有case正式close+disconnect后stop，3001/3013无监听、remotekit_browser无残留，host browser_close完成；CPU/GPU窗口已释放。未commit，交主Agent统一审阅提交。尚未覆盖破坏性GPU恢复；本次功能包含单/双plane、真实DPR与缩放、静态重挂载、输入和重连。
