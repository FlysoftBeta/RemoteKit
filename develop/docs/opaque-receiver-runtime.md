# 不透明接收端 Canvas 实播

2026-11-01。本轮将实际视频 plane 的 Canvas 2D context 设置为 `alpha:false`，实测设置已生效，现代接收端和 Chrome89 默认 video 路径功能正常。唯一两租户 fixed52 组实际 paint **45.67/46.88FPS、Pixel marker p95 104/97ms**，没有超过旧透明 plane 的 46.86/48.26FPS、83/94ms。当前证据不支持把该属性改动称为性能收益，目标仍未达成；没有继续扩矩阵或调整 RAF。

## 审计与改动

代码只改 `control/client/transport.ts` 的 `paintPlane`：`node.getContext('2d', { alpha: false })`。`main.tsx` 创建实际 canvas，但没有提前取得 context；实际 plane 的首次 2D context 获取统一经过此处，包含 MSTP immutable frame、默认 video snapshot、direct 与静态重挂载。原有 pending/authorized atlas 已按 `alpha:false` 创建，marker 的独立读回 canvas 保持原行为。H264 视频输出没有 alpha，此处明确表示实际 plane 完全不透明。

不改候选帧选择、时序、计数、所有权、丢帧策略、坐标、布局、fixture、尺寸、DPR、码率或 CRC；同一 VideoFrame 同步绘制所有 plane 的行为保留。65 tests、TypeScript、Vite、server bundle、production startup smoke、git diff check 全部通过，没有为属性选项增加镜像测试。主 Agent 保留这一明确不透明语义的简单属性，不将它列为已证实的性能优化。

## 功能验证与视觉

使用 browser-use skill 的 host-managed Playwright，未操作用户桌面。`opaque-receiver-functional` 通过 Chromium157、shared Endpoint、1920×1080/DPR1，实际 atlas/编码1936×1088，初次/静止/恢复animation/重连四阶段的鼠标与 IME commit，CRC stimulus4001/4002/4003/4004，invalid全0。各阶段实际 plane `getContextAttributes().alpha === false`。

静态重挂载新 canvas 同样 alpha=false，前后 RTP591459489、latest owner 相同，成功新帧计数135不变，sourceRect0,0,1920,1080且输入ready。重连前 source/pending/latest 全清空，displayReady=false，read=closed=ownerClosed345，ownersHeld0。运行中 read/close 相等、invalid/stale0，pending1+latest1上限保留；没有新增整 atlas copy。

`opaque-receiver-video89` 补齐之前只在 copy 模式跑过的 shared 回归：Chrome89.0.4389.90、默认 video/snapshot、无fake刷新参数，首帧/鼠标/IME commit/重连，CRC3001/3002、invalid0，实际1936×1088、H264 42e02a。两阶段 getContextAttributes 均返回 alpha=false、desynchronized=false。Sol检查上述两组初次及重连截图，marker、文字、输入框、色块及画面边界正常；fixture原有能力诊断覆盖文字仍在。图片和完整记录在各case中。

## 唯一正式组

`develop/tmp/opaque-receiver-fixed52-t2`：2租户，10秒暖机+45秒测量，原1920×1080/DPR1、实际1936×1088、mediaScale1、CRC1Hz。source RemoteKitCaptureRoot+RemoteKitSinglePlaneDirect、固定52/adaptive off；接收端 MSTP/snapshot/after-work。QSV TU7/LPon/VBR/depth1、external/alignment16、目标36最大44Mbps；每peer48Mbps、单向5ms即RTT10ms、RTP playout0/0。receiver out/rel Chromium157.0.8103.15，官方fake60，continuous rVFC关；browser/media/server/official profiling关、ResourceProfile开。与旧透明shared fixed52为顺序配对，没有并发CPU构建或其它实验。

|模式/peer|source render|delivery|private copy|encode complete|decode|实际canvas|marker p50/p95 ms|
|---|---:|---:|---:|---:|---:|---:|---|
|旧透明 shared fixed52/0|52.00|约51.60|0|约51.58|51.51|46.86|64/83|
|旧透明 shared fixed52/1|52.00|约51.54|0|约51.52|51.49|48.26|82/94|
|opaque shared fixed52/0|52.00|51.23|0|51.23|51.23|45.67|72/104|
|opaque shared fixed52/1|52.00|51.01|0|50.97|50.97|46.88|77/97|

新组delivery/encode为RTC采样端点差值率；旧表中的约数是秒级report均值，完整差值与原始记录各自保存在summary/details。正式成功paint2056/2114、RTP+epoch重复0、missingPaintSnapshot0，各CRC45、invalid0，epoch始终1。peer0诊断canvas2057包含startedAt之前1帧，正式FPS依据窗口内2056，不用计数差异改写收益。实际播放窗口45.019/45.091秒。

MSTP read/close2298/2298、2287/2287，invalid/stale0，ownerClosed2298/2287；reset前已有owner使该close数不应被误读为无latest owner。秒级ownersHeld仅1或2，末样本各latest1/pending0。pending replaced241/173；atlasSnapshotCopies0，routing.snapshotFrames0，processorSnapshot samples0。成功paint与准入计数未被伪造。Viewport draw p95 1.6/1.5ms（旧均1.5）；marker readback p95 27.1/31.7ms（旧18/15），本次未更改读回方法。

|15秒分段|source peer0/1|canvas peer0/1|marker p95 peer0/1|Intel3D %|
|---|---|---|---|---:|
|0–15s|52.00 / 52.00|44.87 / 45.47|104 / 103|90.65|
|15–30s|52.07 / 52.00|45.47 / 47.53|94 / 88|87.03|
|30–45s|52.00 / 52.00|46.67 / 47.73|83 / 83|83.97|

每段各15 CRC，分段p95秩计算同原工具；完整45样本才是验收数。正式窗口超过45秒的少量尾帧不在三个15秒段内，不能相加替代完整窗口。source52稳定，后段GPU占用下降、canvas有所恢复，但仍没有一段两路都达到50FPS。没有明显收益，不追加56或其它矩阵。

## 资源、实际参数与剩余成本

45个有效资源样本，Intel3D均87.22%、p9597.61（旧84.92%/96.45%），VideoDecode63.57%、VideoProcessing15.77%；整机CPU均55.04%、p9582.22（44个source host-load样本，旧均50.71%）。Intel3D角色sourceGPU41.276%、sourceBrowser11.357%、receiverGPU34.578%、Endpoint0%、unowned0.003812%；旧sourceGPU39.199/sourceBrowser11.507/receiver34.216/Endpoint0。GPU errors空、resource.err空，无明显外部GPU负载。各15秒资源及角色归因保存在resource-segments.json。不同引擎占用没有相加。

47个秒级Endpoint样本：实际applied TU全7，LP requested/queried/initialized全16，queryStatus5、init/GetVideoParam0。实际applied bitrate范围35.045–40.713 / 33.617–42.062Mbps，未超过44Mbps最大值；这是编码目标，不等于实际wire吞吐。private copy全0、lastGpuCopyMs全null；pendingReplaced和encodeDropped增量1/3、held槽均1.11/1.21且p95均2。capture→ready秒级last-value p95 14.00/12.71ms，encode p95 16.22/15.60ms。这些统计不是逐帧GPU timestamp。

decode仍约51而成功paint低于47，应用层pending替换存在；CRC同步读回p95本组较高，但它不计入marker呈现时间定义。两组source/receiver GPU与readback都变化，单次顺序组不足以将回退确定归因于alpha:false。更深接收端调度/绘制/读回成本交主 Agent 选择后续任务，本轮未扩大实现范围。

## 指纹、产物与清理

所有case保存config/run/fingerprints；正式组有summary/details、每peer时间线、原始presentation、源trace、resource-summary/segments。metrics loader验证chunk长度和hash。最终Endpoint为 `1BB936B74FBBF42A59171E31041C1C7A2E494B6D54051A1A95DFBBDC7F7D8B29`，包含最终trace字段修正；正式server trace关闭。未重建Endpoint/Browser/Chromium。

- Control bundle `index-yYeYj6Tn.js`：`B6114D469DFA769C26FA0A42FC4E5F571B0C90E4A61C9A5735CB664FE063C16C`
- receiver chrome.exe：`F833F59831E7D428E1527BF1E12C0D4A2B338A0CBD4239A050F280C1C62EA62A`
- receiver chrome.dll：`20C0F298D2012B6841BA8ACB7AF7F62DC6DF23A40F899073C9D74DD0FC034FCC`
- fixture保持 `4CB517D8BD239E64C79C6D26D66E8FA0E374062046B43EF9813089A2874585F1`

所有自有RTC close+disconnect、context/browser close、case stop及host browser_close完成，3001/3013无监听、无remotekit_browser残留，CPU/GPU窗口已释放。仓库根已有未跟踪 `.playwright-mcp/`（创建于此前18:27–18:39），未删除或纳入修改。
