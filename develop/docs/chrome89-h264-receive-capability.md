# Chrome 89 H.264 接收能力证据

2026-11-01；客户端实物为 `C:/src/tmp/chrome89-google/app/chrome.exe`，89.0.4389.90。以下区分默认 SDP、实现和本机实测；不把默认 level 当作硬件上限，也不把一次解码当作1080p60吞吐验证。

## 官方代码事实

以下文件均从 Chromium 官方 tag `89.0.4389.90` 下载，副本在 `develop/tmp/media-probe/chrome89_*`。

- [RTCVideoDecoderFactory](https://chromium.googlesource.com/chromium/src/+/89.0.4389.90/third_party/blink/renderer/platform/peerconnection/rtc_video_decoder_factory.cc#29) 使用固定30fps、640×480临时配置；注释说明尺寸将由 decoder 覆盖。GetSupportedFormats 在约218行用这组配置探测 GPU 支持，约95行按临时尺寸/fps生成H264 profile-level。它没有查询本机硬件最大分辨率/吞吐作为 SDP 上限。
- [RTCVideoDecoderAdapter](https://chromium.googlesource.com/chromium/src/+/89.0.4389.90/third_party/blink/renderer/platform/peerconnection/rtc_video_decoder_adapter.cc#74) 的 H264 路径将格式映射为 BASELINE profile；约191行仍有按level预测尺寸的TODO。InitDecode 约275行不按 fmtp level 作最大分辨率校验，实际帧交给底层decoder。这解释了默认 SDP 较低而真实硬件可接受更高level的可能性；不能由此直接推断帧率。
- [MediaCapabilities](https://chromium.googlesource.com/chromium/src/+/89.0.4389.90/third_party/blink/renderer/modules/media_capabilities/media_capabilities.cc) 的 file 解码能力检查/历史平滑预测可作为补证，但不能替代 WebRTC实际完整帧吞吐。
- [RFC6184 §8.2.2](https://www.rfc-editor.org/rfc/rfc6184.html#section-8.2.2) 定义level协商与非对称方向；本地answer的高level不能单独证明远端接收能力。当前 Chromium 157 `media/base/sdp_video_format_utils.cc:164` 在双方 asymmetry=1 时采用 local level，SDK不能只依赖这一值声称远端支持。

## 已有本机事实

- 首流 `develop/tmp/first-stream/attempt2`：Chrome89 offer含 constrained-baseline `42e01f` /packetization1，endpoint answer `42e033`，QSV GetVideoParam报告level40。
- 实际视频尺寸 **1288×728**（1280×720 viewport加atlas padding），Chrome89解出27帧，并从真实视频marker读到frame29/stimulus0及DataChannel输入后frame43/stimulus42。rVFC确有 `rtpTimestamp` 字段。
- 上述是短功能联调；没有据此报告FPS/端到端达标。该轮尚无SPS字节快照，新SDK已打印首SPS的真实profile-level-id，后续应与driver/SDP一起保存。
- `attempt4` 明确选择4.2实验接收档：原始offer与effective offer分别保存；实际1928×1088视频经rVFC/layout epoch匹配后呈现，marker13 CRC有效，首SPS为 **42402a**（constrained baseline level4.2）。仅解出3帧后QSV码率Reset -14冻结，说明本机能接受该级别的真实帧，尚未完成持续1080p60验证。
- 同轮Chrome89 `MediaCapabilities.decodingInfo` 对file/mp4 `avc1.42E02A`、1920×1080、60fps、24Mbps返回supported/smooth/powerEfficient均为true；`type:'webrtc'` 返回该版本enum不支持的TypeError。原始结果在 `attempt4/report.json` 的 `metrics.receiveCapabilities`。

## 有界确认方案（供主Agent决定）

1. 记录同一Chrome89进程的 `RTCRtpReceiver.getCapabilities('video')` 原始值，以及 `MediaCapabilities.decodingInfo` 对 `video/mp4; codecs="avc1.42E02A"`、1920×1080、60fps、24Mbps的supported/smooth/powerEfficient与exception。另试webrtc类型并如实保留旧版不支持时的错误。
2. 用已知4.2 SPS、实际1920×1080或明确记录padding后的尺寸做受控解码诊断，保留实际接收完整帧、rVFC尺寸/计数、codec stats、SPS、缺帧/错误和CPU/GPU情况。只有完整视频解码及目标速率均成立才把本机4.2档记为已验证。
3. 主Agent已选择增加显式Chrome89实验4.2档，保留原始/effective SDP，普通自动档仍使用原始capability。后续持续验证通过后才能报告该实验档的目标吞吐；能力发现失败应回到默认范围，不能自动冒充已验证。

SDK已将 `EncodedImageCallback::Result.frame_id`（包含WebRTC sender随机offset的实际wire RTP）经C ABI返回endpoint；layout epoch关联应使用该输出，不能用encoder输入timestamp猜offset。
