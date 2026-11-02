# Chrome 89：同一远端 track 的多 video 解码边界

日期：2026-11-03。范围：官方源码只读核对；没有构建、启动浏览器、GPU 测试或性能矩阵。没有改 Chromium 工作树或产品代码。

## 结论

**Chromium 89.0.4389.90 已有解码后 VideoFrame 扇出。** 对同一个远端接收 `MediaStreamTrack`，将其放入多个 `new MediaStream([sameTrack])` 并分别赋给多个 video，会复用原 track/component，增加各 video 的呈现 sink，不会仅因新增这些 video 就各自建立一条 WebRTC 编码帧解码管线。

这是指定版本的源码结论，补齐了 Chrome 89 的依据；不是将 Chromium 157 的实现或历史双 video 实验泛化到 89。它也**不等于多个 video 的总 GPU/CPU 开销与一个 video 相同**：89 已有每个 player 各自的 compositor、帧队列，以及按条件启用的 GPU memory buffer 转换路径。

## 版本锁定与取证方式

- 官方 [89.0.4389.90 tag](https://chromium.googlesource.com/chromium/src/+/refs/tags/89.0.4389.90) 的 Gitiles JSON 返回 commit `0f7fcb5c6a3f7204b0c466c4e6b10e921f58bb8d`，提交说明为该版本发布 DEPS。
- 该版本 [DEPS 第 1511–1512 行](https://chromium.googlesource.com/chromium/src/+/refs/tags/89.0.4389.90/DEPS#1511) 固定 `third_party/webrtc` 为 `e7d9f74b256605556726c64dacd518a105ba872f`。下述 WebRTC 文件全部使用此 revision。
- 浏览工具访问 Gitiles 返回 Internal Error；随后通过 HTTPS 读取官方 Gitiles `?format=TEXT`（base64 解码）及 `?format=JSON` 实际内容。未使用搜索摘要、第三方镜像或本机新版源码替代旧版。

## 证据链

### 1. 新 MediaStream 容器保留原 track 和 component

[media_stream.cc：MediaStream::Create(context, tracks)，第 80 行起；构造函数第 197 行起](https://chromium.googlesource.com/chromium/src/+/refs/tags/89.0.4389.90/third_party/blink/renderer/modules/mediastream/media_stream.cc#80)：`ProcessTrack` 把传入的原 track 指针加入向量；构造函数把每个 track 的 `Component()` 放入新的 descriptor，并保留同一组 track。这里没有调用 track clone 或创建新的远端 receiver。

因此 `new MediaStream([sameTrack])` 的 stream descriptor 可以不同，但其中的 track/component 相同。本结论限定同一个传入 track；不把不同 PeerConnection/receiver 的视频当作共享解码。

### 2. WebRTC 的解码输出先到接收流 renderer

对应 revision 的 [generic_decoder.cc：VCMDecodedFrameCallback::Decoded，第 81、189 行；RegisterDecodeCompleteCallback，第 296 行](https://webrtc.googlesource.com/src/+/e7d9f74b256605556726c64dacd518a105ba872f/modules/video_coding/generic_decoder.cc#81)：decoder 注册完成回调，解码完成后调用接收回调的 `FrameToRender`。

[video_stream_decoder.cc：VideoStreamDecoder::FrameToRender，第 44–50 行](https://webrtc.googlesource.com/src/+/e7d9f74b256605556726c64dacd518a105ba872f/video/video_stream_decoder.cc#44) 记录 decoded-frame 统计，并将 `VideoFrame` 交给 incoming stream。接收流启动时将 renderer（可经平滑队列）传给 VideoStreamDecoder；[video_receive_stream.cc：Start，第 330–387 行；OnFrame，第 512–529 行](https://webrtc.googlesource.com/src/+/e7d9f74b256605556726c64dacd518a105ba872f/video/video_receive_stream.cc#330) 最终调用 `config_.renderer->OnFrame(video_frame)`。

### 3. 接收流输出接到远端 track 的 broadcaster

[webrtc_video_engine.cc：WebRtcVideoReceiveStream 构造，第 2768 行；OnFrame，第 2998–3014 行；SetSink，第 3043 行](https://webrtc.googlesource.com/src/+/e7d9f74b256605556726c64dacd518a105ba872f/media/engine/webrtc_video_engine.cc#2998) 把自身作为接收流 renderer，然后把已输出的 frame 交给所设 sink。

[video_rtp_receiver.cc：RestartMediaChannel，第 159 行；SetSink，第 178 行](https://webrtc.googlesource.com/src/+/e7d9f74b256605556726c64dacd518a105ba872f/pc/video_rtp_receiver.cc#159) 将该 sink 设为 `source_->sink()`；[video_rtp_track_source.cc：source()/sink()，第 25–29 行](https://webrtc.googlesource.com/src/+/e7d9f74b256605556726c64dacd518a105ba872f/pc/video_rtp_track_source.cc#25) 均返回同一 broadcaster。[video_track.cc：VideoTrack::AddOrUpdateSink，第 43–49 行](https://webrtc.googlesource.com/src/+/e7d9f74b256605556726c64dacd518a105ba872f/pc/video_track.cc#43) 向 source 注册 sink；[video_broadcaster.cc：OnFrame，第 58–90 行](https://webrtc.googlesource.com/src/+/e7d9f74b256605556726c64dacd518a105ba872f/media/base/video_broadcaster.cc#58) 遍历 sink，交付 VideoFrame（启用状态等特殊条件可换黑帧或调整元数据）。这是解码输出后的广播。

### 4. Blink 接收 decoded VideoFrame，再向 video sink 扇出

[media_stream_remote_video_source.cc：StartSourceImpl，第 424–434 行；RemoteVideoSourceDelegate::OnFrame，第 174 行起；DoRenderFrameOnIOThread，第 365–369 行](https://chromium.googlesource.com/chromium/src/+/refs/tags/89.0.4389.90/third_party/blink/renderer/modules/peerconnection/media_stream_remote_video_source.cc#424) 向上述 WebRTC video track 注册 delegate；delegate 接收 `webrtc::VideoFrame`，包装/取得 `media::VideoFrame`，再执行 frame callback。Native buffer 分支直接取得适配器中的 MediaVideoFrame；这里不是每个 HTML video 接收编码数据再解码。

[media_stream_video_source.cc：AddTrack，第 55–82 行、完成注册第 432 行](https://chromium.googlesource.com/chromium/src/+/refs/tags/89.0.4389.90/third_party/blink/renderer/modules/mediastream/media_stream_video_source.cc#55) 将 source callback 接到 VideoTrackAdapter；[video_track_adapter.cc：DeliverFrameOnIO，第 765–789 行；DoDeliverFrame，第 392–402 行](https://chromium.googlesource.com/chromium/src/+/refs/tags/89.0.4389.90/third_party/blink/renderer/modules/mediastream/video_track_adapter.cc#765) 将 VideoFrame 送到 track callback。

[media_stream_video_track.cc：FrameDeliverer::DeliverFrameOnIO，第 324–343 行；AddSink，第 536–541 行](https://chromium.googlesource.com/chromium/src/+/refs/tags/89.0.4389.90/third_party/blink/renderer/modules/mediastream/media_stream_video_track.cc#324) 明确保存 sink callback 列表，并把同一 `scoped_refptr<media::VideoFrame>` 依次交给 callbacks。新增 sink 注册在此列表中。

### 5. 每个 video 的 player 增加呈现 sink，仍有独立后处理

[media_stream_renderer_factory.cc：GetVideoRenderer，第 55–75 行](https://chromium.googlesource.com/chromium/src/+/refs/tags/89.0.4389.90/third_party/blink/renderer/modules/mediastream/media_stream_renderer_factory.cc#55) 用 stream 的第一个 video component 创建 MediaStreamVideoRendererSink；[media_stream_video_renderer_sink.cc：Start，第 148–168 行](https://chromium.googlesource.com/chromium/src/+/refs/tags/89.0.4389.90/third_party/blink/renderer/modules/mediastream/media_stream_video_renderer_sink.cc#148) 用该 component 连接 track。[media_stream_video_sink.cc：ConnectToTrack，第 19–25 行](https://chromium.googlesource.com/chromium/src/+/refs/tags/89.0.4389.90/third_party/blink/renderer/modules/mediastream/media_stream_video_sink.cc#19) 走 AddSinkToMediaStreamTrack。

[webmediaplayer_ms.cc：Load，第 425–453 行；FrameDeliverer 第 149–230 行](https://chromium.googlesource.com/chromium/src/+/refs/tags/89.0.4389.90/third_party/blink/renderer/modules/mediastream/webmediaplayer_ms.cc#425) 为 player 创建 compositor、frame deliverer 与 video renderer；frame deliverer 可以创建自己的 GpuMemoryBufferVideoFramePool，并按条件调用 MaybeCreateHardwareFrame。因此额外 video 的合成、缩放、裁剪、队列、帧持有和潜在转换成本不能由“共享解码”排除，也不能据源码给出实际 GPU 增幅。

## 统计口径与不能断言的事项

- **不能把多个 video 的 `webkitDecodedFrameCount` 相加当解码器吞吐。** 89 的 [HTMLVideoElement::webkitDecodedFrameCount，第 561–565 行](https://chromium.googlesource.com/chromium/src/+/refs/tags/89.0.4389.90/third_party/blink/renderer/core/html/media/html_video_element.cc#561) 调 player 的 DecodedFrameCount；[WebMediaPlayerMS::DecodedFrameCount，第 985–987 行](https://chromium.googlesource.com/chromium/src/+/refs/tags/89.0.4389.90/third_party/blink/renderer/modules/mediastream/webmediaplayer_ms.cc#985) 返回自身 compositor 的 total_frame_count；[WebMediaPlayerMSCompositor::EnqueueFrame，第 348–356 行](https://chromium.googlesource.com/chromium/src/+/refs/tags/89.0.4389.90/third_party/blink/renderer/modules/mediastream/webmediaplayer_ms_compositor.cc#348) 每次入队递增。多个 player 可以分别对同一批源帧计数。
- 可以断言：此版本正常同远端 track 多呈现 sink 的分叉在解码之后；仅新建 MediaStream 容器与 video 不会按 video 数复制该接收解码管线。
- 不能断言：一定使用硬件解码、底层解码器对象永远只有一个（协商/codec切换/恢复可改变实例）、完全零拷贝、总 GPU/CPU 成本不变、多 video 帧率/延迟相同，或 Chrome 89 的实际硬件表现已通过本次验证。
- 本次没有运行 Chrome 89。既有产品功能组与新版历史性能组保持各自版本和条件，不因本源码核对升级为 Chrome 89 性能证据。
