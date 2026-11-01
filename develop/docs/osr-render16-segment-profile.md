# 精准render16的分段诊断

## 结论

本组最大的可量化延迟段在接收端的“帧最后网络包到达→视频交给浏览器合成”，约76–101ms；进入rVFC后到Client canvas draw返回约1–2ms。不能把前者称为Client JS消费耗时，也无法从Chrome89现有字段继续拆成纯jitter、纯解码或GPU准备。

源端已经没有旧Present长阻塞。S3/S4完整CopyOutput request→SendResult p95约25ms，flush-batch GPU elapsed约1ms；renderer compositor接收BeginFrame到创建capture请求p95约11ms。Display没有等待整个62.5ms deadline。

本组开启诊断profile，marker p95为147–245ms，低于此前profile-off的311–379ms；不能据此改写正式基线或宣称优化收益。下一候选由主Agent选择，继续使用profile-off对照。

## 采集与关联范围

唯一case：`develop/tmp/osr-render16-segment-profile`。精准render16、四1080、snapshot、1Hz marker、每peer24Mbps/RTT10ms、d1/TU1/VBR；启用已有CopyOutput请求级profile、official startup trace和server/browser trace，没有改调度或新增ETL。

官方trace每Session约16秒，与该Session正式20秒客户端窗口取交集；Created与SendResult都落入交集的请求才计入下面的GPU分布。

| Session | 正式窗口与trace交集 | 完整CopyOutput请求 | 完整关联到同wire RTP的marker |
|---|---:|---:|---:|
| S1 | 4.685s | 75 | 4 |
| S2 | 6.163s | 98 | 5 |
| S3 | 7.731s | 124 | 7 |
| S4 | 9.656s | 155 | 9 |

S3单调时间交集为[9640370903.25,9648101861]us，S4为[9640369902.75,9650026294]us，都是各自正式窗口起点附近开始的部分稳态。不是完整20秒官方trace。

请求按PID+request指针+Created时间关联，SendResult终结生命周期。browser capture_counter再连接server frame、实际wire RTP、native rVFC及最终CRC marker。`same-rtp-overlap.json`保留7/9条端到端完整行；GPU表使用全部124/155条，Client与server端到端表使用同RTP的7/9条。

## 同请求源端阶段

单位ms，p50/p95；各段分位数不可相加。

| 阶段 | S3（124） | S4（155） |
|---|---:|---:|
| renderer compositor收到BF→提交CompositorFrame | 5.27/10.34 | 5.26/9.59 |
| renderer提交→GPU收到该surface | 0.27/0.69 | 0.33/0.73 |
| GPU收到surface→CopyCreated | 0.25/0.63 | 0.31/0.67 |
| renderer compositor收到BF→CopyCreated | 5.92/11.14 | 6.08/10.78 |
| CopyCreated→GPU dispatch | 2.02/4.45 | 1.96/3.73 |
| dispatch→flush | 0.27/0.68 | 0.29/0.63 |
| flush CPU调用 | 0.25/0.68 | 0.29/0.96 |
| flush返回→submitted callback | 0.34/1.11 | 0.32/0.99 |
| submitted→finished callback | 10.04/21.57 | 11.54/22.40 |
| GPU flush-batch elapsed | 0.77/1.05 | 0.75/1.04 |
| request→SendResult | 14.04/24.94 | 14.83/25.65 |

elapsed受硬件支持且为非零GPU flush batch，可能包含此前未flush工作，不称纯copy。submitted callback不是OS提交时刻；submitted→finished包含GPU排队、执行和完成检查，不能把减去elapsed的余量全称观察延迟。

S3的120/124、S4的151/155次finished发生在 `SkiaOutputSurfaceDependencyImpl::ScheduleDelayedGPUTaskFromGPUThread` 投递的任务中，trace显示请求delay2000us、FLEXIBLE_NO_SOONER。少数在CommandBufferStub/其他Skia上下文工作中完成。本组没有该任务独立的精确post→run字段，所以不再把其全部跨度归给定时迟到。

稳态GPU主线程最长完整任务scope为S3 6.49ms、S4 5.60ms，均是scheduler执行工作，无旧DXGI/NativeViewGLSurfaceEGL Present长任务。

## Display与一帧差的核对

通过Graphics.Pipeline的surface_frame_trace_id连接renderer RECEIVE_BEGIN_FRAME.frame_sequence、SUBMIT_COMPOSITOR_FRAME、GPU RECEIVE_COMPOSITOR_FRAME，以及root实际aggregation选中的child trace_id。

S1/S2/S3/S4的75/98/124/155条请求全部满足captured child sequence等于当前root Display sequence，lag均0。没有“root已画完才收到当前新surface、等下一BF”的证据。

例如S1 source_id0、sequence220（时间us）：renderer收到BF9642705823，submit9642707515，GPU收到9642708112，root draw9642708427，CopyCreated9642708738。新surface先到，随后root画并创建copy。

Display BeginFrame→OnBeginFrameDeadline的p50/p95：S1 2.00/3.10ms、S2 1.53/3.18ms、S3 5.86/11.03ms、S4 5.98/10.67ms；最大分别3.95/4.02/14.97/13.75ms，均不是等待整个62.5ms。

S1/S2像素marker导出的render→capture_begin约62.5ms差仍存在，但JS像素帧、renderer frame token与接收端实际marker之间缺少独立映射，本组不能把差值归因于root deadline。未启用full-pipeline flag，也未继续扩展该调查。

## 同RTP的server与Client阶段

单位ms，p50/p95；使用与官方trace交集完全关联的S3 7个/S4 9个marker。

| 阶段 | S3 | S4 |
|---|---:|---:|
| marker render→capture_begin | 6.08/9.56 | 5.50/7.70 |
| capture_begin→capture_end | 12.84/24.54 | 17.67/27.77 |
| capture_end→browser callback | 0.59/1.21 | 0.56/1.58 |
| callback→atlas publish | 0.38/0.61 | 0.44/0.95 |
| publish→Endpoint copy提交 | 0.80/2.24 | 0.98/2.30 |
| Endpoint私有copy到完成观察 | 8.92/17.99 | 4.08/9.96 |
| encoder worker排队 | 0.02/0.04 | 0.02/0.03 |
| VPP提交到完成观察 | 3.23/12.32 | 3.38/5.83 |
| MFX提交到硬件完成观察 | 5.55/7.93 | 5.67/12.68 |
| capture_end→编码返回 | 23.27/34.13 | 18.70/29.09 |
| 编码返回→native receiveTime | 9.30/61.13 | 9.15/12.67 |
| receiveTime→presentationTime | 87.38/101.22 | 76.15/99.31 |
| presentationTime→rVFC参数now | -0.36/-0.16 | -0.27/-0.15 |
| rVFC参数now→canvas draw返回 | 1.29/2.20 | 1.12/2.17 |
| canvas draw返回→marker读回完成 | 22.65/33.55 | 21.62/30.91 |

receiveTime来自该wire RTP的native rVFC metadata，是帧最后网络包到达时刻，不是DataChannel元数据到达。presentationTime是video交给合成的时刻；now是独立benchmark rVFC回调收到的参数。两种浏览器时间戳有约0.15–0.8ms小负差，不能据此解释为负耗时或亚毫秒严格顺序。

本组未保存transport实际callback entry，也没有真实GPU bitmap-ready时间；因此表中的now→draw不是独立测得的transport函数CPU耗时。当前实现没有createImageBitmap，snapshot为video→pending canvas的同步draw提交，再由viewport canvas draw提交。全20秒已有CPU调用统计显示videoSnapshot p95约0.95ms、viewportDraw约0.38ms，epoch授权等待p95约1.2ms；元数据普遍早于video约48–80ms，未见它造成100ms等待。

同RTP native processingDuration在S3/S4重叠样本的p50为2/1ms、p95为16/11ms。Chrome89本组RTC stats缺jitterBufferDelay等进一步细分字段，不能把receive→presentation的其余时间全部指定为jitter或解码；能确定其主要发生在native播放/视频呈现链，进入rVFC后的Client提交很短。全20秒S1/S2另有presentation→rVFC约47ms长尾，亦发生在Client draw之前。

marker读回排在本帧目标测量端点draw返回之后，不加到该帧render→draw指标，但它仍占共享GPU并影响后续帧。

## 典型完整帧与下一瓶颈

S3最慢的重叠marker：wire RTP1955593821、server frame175、capture_counter178、GPU PID7476/request2406706631072、source_id0/sequence182。

该帧request→SendResult20.59ms，其中submitted→finished17.43ms、batch elapsed0.708ms。端到端155ms由同一行闭合：render→capture_end28.79ms，capture_end→编码返回16.61ms，编码返回→receive7.29ms，receive→draw102.31ms。后者101.22ms在native receive→presentation，Client presentation→draw1.09ms；marker读回另外18.08ms。

最主要可操作候选应放在接收端播放/视频呈现预算的验证；现有数据不支持改root deadline、full-pipeline或把100ms归给JS snapshot调用。GPU完成检查仍有约20ms级跨度，但它不是本组最大的端到端段，也未与实际GPU队列等待分开。

主Agent已选定后续profile-off的RTP播放延迟0/0请求单组对照；这只是请求，不意味着消除全部jitter。分段诊断结果不充当该组的性能基线。

## 产物与收尾

`copy-profile.json`保存全请求及裁切统计，`framegraph.json`保存同sequence/surface证据，`deep.json`保存Display与GPU实际scope，`same-rtp-overlap.json`保存完整端到端关联。原始官方trace、server/browser日志和marker保持不变。

该case已清理，未改源码、策略或默认，也未新增实验矩阵。
