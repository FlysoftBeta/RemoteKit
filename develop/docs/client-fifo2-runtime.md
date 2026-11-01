# FIFO2真实运行

2026-11-01。FIFO2把两租户实际canvas从46.476/46.122FPS提高到49.632/49.988FPS，marker p95从91/89ms变为94/103ms。**没有在同组满足两路FPS≥50且p95≤100ms**，因此按主Agent给定分支停止，没有120秒稳定组或单租户组；49.988没有四舍五入为达标。

## 版本、条件与有效策略

本轮两组使用完全相同的binary及bundle，fingerprints逐键一致：Endpoint `1607E34B1EBD08F489B89F1DB978BD6DC95CA360E1D413366939426B9ADCE14C`；Control `index-BI4yf---.js`，SHA256 `F86A2BA691C5C54A07EFF0D08E362ECB34B5D040EDADFFBC0B05C15DB3F38CD1`；Browser/SDK仍D2整套out/dev。旧CaptureToAtlas A/B性能使用不同Endpoint/Control，保留历史，不直接合并为本次单变量对照。

case：`develop/tmp/client-latest1-fixed52-t2`→`client-fifo2-fixed52-t2`，每组全新干净启动，两租户、暖机10秒+测量45秒。唯一变量processorScheduler latest1→fifo2。两组ProcessorProfile=false，实际diagnostics均为scheduling=requestAnimationFrame、callbackRegistration=not-applicable；MSTP不把配置中的after-work当控制变量。

其余均沿用D2 B52：CaptureToAtlas+CaptureRoot+SinglePlaneDirect、shared，原1920×1080/DPR1、实际atlas/编码1936×1088、mediaScale1、CRC1Hz；source固定52/adaptive off；TU7/LPon/VBR36max44Mbps/depth1/external/alignment16；每peer48Mbps/RTT10ms、RTP0/0；receiver157.0.8103.15官方fake60、MSTP immutable opaque snapshot。browser/media/server/official intrusive profile关闭，ResourceProfile开，无并发构建。未改分辨率、fixture、码率或sourceFPS。

## 功能门

`client-fifo2-functional`通过initial/static/resume/reconnect，鼠标和IME commit的CRC4001/4002/4003/4004、invalid0。实际scheduler=fifo2、rAF、profilefalse。静态重挂载前后RTP1836859790、owner和canvas154不变，fresh plane alpha=false、输入readytrue，CRC4002正确。重连关闭时read/close330/330、ownerClosed330，source/pending/latest清空，ownersHeld/pending/displayed/retiring全0、displayReadyfalse。

Sol检查静态UI：marker、输入框、文字、色块、边界正常，fixture原有诊断覆盖文字仍在。没有桌面键鼠操作。新Endpoint故障退休回归另见endpoint-retirement-runtime.md追加章节。

## 正式逐阶段结果

|模式/peer|source|delivery均值|encode均值|decode|真实canvas|marker p50/p95 ms|
|---|---:|---:|---:|---:|---:|---|
|latest1/0|51.98|51.86|51.86|51.84|46.476|57/91|
|latest1/1|52.00|51.93|51.93|51.90|46.122|58/89|
|fifo2/0|52.00|51.13|51.11|51.08|49.632|77/94|
|fifo2/1|52.00|51.42|51.44|51.37|49.988|78/103|

Delivery/encode为47个秒级report均值，decode为RTC采样端点差值。latest1成功paint2092/2076，fifo2为2234/2250；各路45 CRC、invalid0、RTP+epoch重复0、missingPaintSnapshot0，epoch均1，chunk长度/hash验证通过。fifo2第二路测量45.0111秒，所以2250帧的真实率仍小于50。

|15秒段|latest1 canvas0/1|fifo2 canvas0/1|fifo2 marker p95 0/1|Intel3D latest1/fifo2 %|
|---|---|---|---|---|
|0–15|45.73/45.87|51.27/51.40|79/82|66.89/71.37|
|15–30|46.73/45.80|49.67/50.00|88/95|76.24/78.27|
|30–45|47.00/46.73|48.00/48.60|94/103|71.43/87.67|

fifo2前15秒两路都超过50，但后续回退，不能用前段覆盖完整验收。末段source仍52，decode两路约50.50；各段15 CRC，完整45样本作为验收p95。完整segments保留source/delivery/encode/decode/paint，分段p95按round((n−1)*.95)秩计算。

## 所有权、队列和丢弃

|模式/peer|read/close|queue满替换|authorized|诊断canvas|正式paint|末pending/latest|
|---|---|---:|---:|---:|---:|---|
|latest1/0|2325/2325|233|2093|2093|2092|0/1|
|latest1/1|2332/2332|255|2076|2076|2076|1/1|
|fifo2/0|2281/2281|46|2235|2235|2234|1/1|
|fifo2/1|2292/2292|42|2251|2251|2250|0/1|

两组invalid/stale全0、atlasSnapshotCopies0。47个秒级快照中latest1 pending最大1/held最大2，fifo2 pending最大2/held最大3，retiring最大0；符合队列容量加独立latest owner。诊断canvas有一帧在正式窗口之前，正式FPS始终依据窗口内paint，未使用较高诊断数改写结果。

replaced计数在源码中只对满队列淘汰递增，对应latest-replaced与fifo-overflow-oldest；正式profile关闭，没有逐事件原因数组。fifo2显著减少此类替换，但没有消除上游漏交和后段调度成本。MSTP内建total/discarded从processor创建累计，应用read等计数在暖机后reset；fifo2累计total2981/2874、discarded19/24不能直接与测量窗read相减。ownerClosed2281/2293包含reset前已保留owner的关闭，不把它当double-close。

Endpoint pendingReplaced/encodeDropped增量latest1均0/0，fifo2为2/2、1/1；private copy0、lastGpuCopyMs null。实际TU7、LP requested/queried/initialized16、external、1936×1088/mediaScale1均保持。fifo2 capture→ready秒级last-value p95 5.65/3.95ms、encode14.36/16.51ms，latest1为3.49/3.08、9.65/11.62ms；不是逐帧GPU timestamp。

## 资源和代价

|资源|latest1|fifo2|
|---|---:|---:|
|有效Resource samples|45|43|
|Intel3D均值 %|71.52|79.09|
|VideoDecode均值 %|52.13|56.71|
|VideoProcessing均值 %|14.42|15.29|
|整机CPU均值/p95 %|45.14/74.41|59.02/96.01|
|3D sourceGPU %|39.411|41.969|
|3D sourceBrowser/Endpoint %|0/0|0/0|
|3D receiverGPU %|32.109|37.115|
|unowned3D观测贡献 %|0.001831|0.001979|

resource.err、gpuErrors均空，无明显外部GPU负载；不同引擎不相加，所有进程角色和unowned条目在resource-summary。fifo2更多paint伴随receiverGPU/CPU增加；本次顺序组的后段整机负载也上升，不能只用队列变化解释全部差值。fifo2 draw p95 1.8/1.7ms、marker readback41.7/36.1ms，latest1为1.4/1.3和23.7/31.3ms；marker呈现定义仍取draw提交时刻，读回成本单独记录。

产物包括config/run/fingerprints、summary/details、AB-summary、queue-summary、原始presentation、segments、resource-summary/compact/segments。未启动定点ProcessorProfile或额外矩阵。全部自有case、receiver/context/browser、host browser_close已关闭，3001/3013无监听、无source残留，GPU释放。未改源码、构建或提交。
