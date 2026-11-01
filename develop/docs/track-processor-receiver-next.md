# MediaStreamTrackProcessor接收端可行性

2026-11-01，只读本地Chromium157源码及当前Control；未构建、启动GPU或浏览器，未改客户端默认或实现。主Agent决定是否安排独立实验。

## 结论

**本地157可以用MediaStreamTrackProcessor读取带精确实际RTP timestamp的decoded VideoFrame，因此没有“缺字段所以不能采用”的接口阻碍。** API实际叫`frame.metadata().rtpTimestamp`，不是`getMetadata()`。该字段feature在本地157为stable。WebRTC远端track明确从收到的`webrtc::VideoFrame::rtp_timestamp()`写入media frame，再由MSTP包装同一frame，字段不是从微秒presentation timestamp估算。

`canvas.drawImage(frame, ...)`同步接收指定frame的绘制后可立即`frame.close()`，Chromium内部维护GPU copy的release同步及必要引用。同步的是读取哪一帧和记录绘制操作，GPU执行和物理显示仍异步。该路线能避开DOM video/rVFC回调选择；WebRTC播放延迟、解码、跨线程task、GPU copy、canvas合成仍然存在，不能据接口推断600个媒体帧会全部变成600次JS读取或最终呈现。

`receiveTime/captureTime/processingDuration`没有暴露在本地VideoFrame metadata dictionary里，虽然底层frame存在其中部分信息。不能为了补诊断把VideoFrame.timestamp当RTP或网络接收时间。

## 精确RTP的源码链

以下Chromium路径均相对`C:/src/chromium/src/`，本地基线157.0.8103.15；所列文件没有当前工作区diff。

| 环节 | 具体源码证据 |
|---|---|
| WebRTC远端解码帧 | `third_party/blink/renderer/modules/peerconnection/media_stream_remote_video_source.cc:196–237`，RemoteVideoSourceDelegate::OnFrame取native adapter的media frame或转换软件frame |
| RTP原值写入 | 同文件约280行：`video_frame->metadata().rtp_timestamp = static_cast<double>(incoming_frame.rtp_timestamp());`。uint32的全域可被double精确表示 |
| 时间诊断不是RTP | 同文件约268–310行另写reference_time、decode_end_time、processing_time、capture_begin_time和最后包arrival receive_time。media frame timestamp是render elapsed时间，和RTP是两件事 |
| track投递 | 同文件约319–337行把同`scoped_refptr<media::VideoFrame>`传到video IO线程的frame_callback，没有经DOM video |
| track适配 | `third_party/blink/renderer/modules/mediastream/video_track_adapter.cc:572–586`：软件scale时MergeMetadataFrom；通常crop/natural-size适配用WrapVideoFrame。`media/base/video_frame.cc:942`的WrapVideoFrame同样MergeMetadataFrom |
| MSTP取frame | `third_party/blink/renderer/modules/breakout_box/media_stream_video_track_underlying_source.cc:112–136`的OnFrameFromTrack直接QueueFrame(std::move(media_frame))，ConnectToTrack使用视频frame sink |
| 包装JS VideoFrame | `third_party/blink/renderer/modules/breakout_box/frame_queue_underlying_source.cc:563–602`的MakeBlinkFrame把同media frame移入Blink VideoFrame；可能调整JS timestamp精度/来源，不改rtp_timestamp |
| JS取元数据 | `third_party/blink/renderer/modules/webcodecs/video_frame.idl:53–54`定义`VideoFrameMetadata metadata()`；`video_frame_metadata.idl:12–13`定义unsigned long rtpTimestamp |
| 实际getter | `third_party/blink/renderer/modules/webcodecs/video_frame.cc:1227–1255`检查frame未close、feature开启及底层optional存在，uint32范围校验后setRtpTimestamp。缺失时不设字段；RTP=0仍然有效 |

授权最小要求仍然是：读取当前VideoFrame的metadata().rtpTimestamp、整数/uint32校验、把它与DataChannel发来的同wire RTP的layoutEpoch逐项匹配，才允许发布快照和输入。metadata尚未到达时可以保留这一frame的canvas快照等待；不能把更新的VideoFrame像素配给旧RTP。字段缺失、接口抛错或closed frame不能猜timestamp继续画。

## Feature、Window/Worker、环境

| 项目 | 本地157状态 |
|---|---|
| MSTP构造 | `modules/breakout_box/media_stream_track_processor.idl:7–14`是`Exposed=Window`，没有RuntimeEnabled或SecureContext属性；构造器支持`new MediaStreamTrackProcessor({track,maxBufferSize})`，也保留旧位置参数形式 |
| VideoFrame | `modules/webcodecs/video_frame.idl:9–12`是Exposed=(Window,DedicatedWorker)、Serializable；本接口没有SecureContext属性 |
| RTP metadata | `platform/runtime_enabled_features.json5:7009`，VideoFrameMetadataRtpTimestamp status=stable；无需为157开启experimental web platform flag。实际运行仍按能力检测，不能对所有现代浏览器一概假定 |
| MSTP计数 | 同json5约4385行MediaStreamTrackProcessorStats也是stable，公开totalFrames/discardedFrames可记录本地drop |
| Worker使用 | 本地157不能直接在DedicatedWorker里new MSTP；可Window构造后transfer readable。`media_stream_video_track_underlying_source.cc:82–109`和`frame_queue_transferring_optimizer.cc:44–90`将queue/source接到目标realm的InternalMediaRealTime任务runner；源码读取COI只是计算timestamp精度，没有要求COI为true |
| 安全上下文 | 这些目标接口本身没有SecureContext IDL gate，代码也未另查IsSecureContext。不能把ConnectToTrack的`IsSecure::kNo`理解成HTTP/HTTPS检查，那是media sink属性。本项目WebRTC、鉴权和部署仍按现有HTTPS/localhost环境；本调查没有验证远程明文站点实际可用性 |

Chrome89继续原rVFC路径；不要只根据UA版本启用新路径，至少检查MSTP构造器、VideoFrame metadata方法以及实际track frame的rtpTimestamp。`metadata()`名字与常见RTC encoded transform的`getMetadata()`不同，不能混用二者。

## ReadableStream队列和背压

`media_stream_track_processor.cc:92–98`建立ReadableStream时count策略highWaterMark=0；约161–167行视频默认max buffer=1，音频10。传入maxBufferSize来自unsigned short字典（EnforceRange），不是无限队列；`frame_queue.h:21–45`至少保留容量1，满时TakeFirst丢最旧，再push最新。

两层容量不能混为一谈：HWM=0控制JS stream拉取，内部仍有默认1帧native queue；JS已经read出来却不close的frame不计入这个1帧上限。不要提前堆大量read Promise或在metadata等待队列无限保留GPU VideoFrame。远端WebRTC device不属于camera/screen/window监控类别，`media_stream_video_track_underlying_source.cc:145–192`对此返回空device id、pool size0；因此这里没有额外camera frame监控上限替应用回收这些JS frame。

`frame_queue_underlying_source.cc:257–350`在帧到达时照常push，只有存在pending pull才安排投递；读取慢会丢旧帧，不会通过ReadableStream反压阻止网络解码。约427–468行另外PostTask EnqueueBlinkFrame，源码明确用于避免JS读取循环饿死其他task。MSTP没有RAF节拍门，但仍有媒体线程到目标realm的任务排队。

`reader.cancel()`会走底层Cancel→Close→DisconnectFromTrack并清队列；track ended也有UnderlyingSourceCloser。应用自己的读循环仍须按peer/attempt失效、关闭已经取出的frame、取消reader并releaseLock，不能在旧连接resolve后继续绘制。Worker transfer是可选扩展，本轮没有必要为可行性调查引入它。

## drawImage之后close的GPU生命周期

`modules/canvas/canvas2d/canvas_2d_recorder_context.cc:2263–2277`验证VideoFrame有效，约2192–2204行取得`scoped_refptr<media::VideoFrame>`并传给DrawVideoFrameIntoCanvas。`platform/graphics/video_frame_image_util.cc:298–328`通过PaintCanvasVideoRenderer绘制该指定frame。`VideoFrame.close()`只Invalidate自己的handle（`webcodecs/video_frame.cc:1524`），不会撤销已提交canvas绘制。

GPU安全证据在`media/gfx/paint_canvas_video_renderer.cc:1685–1737`：GPU SharedImage frame拷入renderer自己的texture backing；software frame则由VideoImageGenerator持scoped_refptr，避免记录尚未执行时被回收。约1758–1789行CopyVideoFrameToSharedImage在实际GPU source读之后调用SynchronizeVideoFrameRead；约205–237行更新VideoFrame release SyncToken，read_lock_fences_enabled时还让GPU completion query回调持有源frame。因而drawImage返回后close原JS frame是正确用法，不需要应用猜GPU已结束或额外CPU等待。

**这条Canvas2D路线不是零copy。** VideoFrame绘制使用栈上PaintCanvasVideoRenderer，GPU frame通常要CopySharedImage到缓存背板；draw到pending canvas、再画各plane仍保留现有snapshot成本，颜色转换/缩放也仍存在。绕开DOM媒体呈现调度有潜力，但GPU满载时新增/不同的copy行为必须实测。`drawImage`结束不代表GPU完成、显示器扫描或用户已看见。

对于迟到layout metadata，最小安全动作是同步drawImage当前frame到pending canvas、保存同frame的RTP、finally close；授权后交换canvas，沿现有paintPlane/marker取实际绘制plane。若选择暂存VideoFrame本身代替快照，必须限制数量并在替换/关闭时close；这是主Agent后续局部设计选择。

## 当前Control的最小接入位置

无需改Endpoint、共享atlas或DataChannel帧消息。边界集中在`C:/Users/Flysoft/Desktop/remotekit2/control/client/transport.ts`：

- `peer.ontrack`约178–184行当前把track附给video并startFramePump；这是能力选择与processor绑定track的入口。避免同时让两个pump修改同一个FrameEpochGate。是否仍绑定DOM video以保留质量计数，需单独考虑其额外呈现代价。
- `startFramePump`约212–246行当前从rVFC拿RTP、drawImage(video)到pending canvas；processor读循环可提供明确VideoFrame、实际RTP和displayWidth/Height，沿用后续快照授权。
- `authorizeFrame`约248–255行、`FrameEpochGate`及DataChannel frame消息处理约340行可以保留精确匹配语义；pending像素与RTP必须来自同一VideoFrame。新路径无需模仿`tryDirectFrame`中再次读活动video的行为。
- `closeLocal`约435–452行需要cancel reader和失效旧循环，保持现有peer/attempt检查；Chrome89 fallback继续取消rVFC。
- diagnostics需要把MSTP delivery与rVFC分开命名，不能伪造`presentedFrames`等DOM metadata；不能因VideoFrame.metadata缺receiveTime就用估算值补出同名诊断。`videoPresentedFrames`与media feedback计数需明确实际代表的环节。

当前transport的authorizeFrame直接dispatchPaint到注册canvas，没有为新视频frame再等待requestAnimationFrame；transport里的RAF是media feedback采样使用。MarkerMeasurement在正式工具中订阅实际plane paint（`control/client/marker-tools.tsx`），可继续保留真实marker读回，不应退回对DOM video抽样冒充processor画面。旧“双重调度”中的具体RAF等待发生位置应以trace确认，不能仅因改成MSTP就说应用所有RAF等待都已去掉。

## 主Agent下一步可据此限定的问题

API与精确RTP可行性已确定；下一项若实施，最小对照需单独验证：实际读出的每个VideoFrame均有RTP；与既有wire-RTP→epoch消息一一关联；迟metadata、尺寸变化、stale、新旧连接隔离、静态tail和输入gate正确；close之后快照像素稳定；同窗记录processor total/discarded/read/authorized/canvas及marker p95。不应同时开启私有Blink连续rVFC feature和processor路径，以免无法归因。

本调查没有运行证据说明该路径改善50FPS/100ms目标，也没有把上游WebRTC jitter/playout调度说成已绕过。当前结论足够支持一个独立、默认关闭、精确RTP授权的客户端局部实验，由主Agent决定实施范围。
