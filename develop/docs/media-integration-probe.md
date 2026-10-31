# 媒体依赖与本地 WebRTC 接口探测

2026-11-01，范围为当前开发机和固定 Chromium 157 基线。未操作桌面。

## 硬件和实际探测

- Win32_VideoController 只有 Intel UHD Graphics 630，PCI VEN_8086 / DEV_9BC5，驱动 30.0.100.9805，状态 OK。
- 没有 NVIDIA GPU、nvidia-smi 或 System32/nvEncodeAPI64.dll。NVENC 代码能接入并编译，但这台机器不能产生 NVENC 硬件实验结果。
- System32/libmfxhw64.dll 版本 11.21.6.23，另有 mfxplugin64_hw.dll。属于 Media SDK legacy runtime。
- 下载并编译官方 Intel libvpl **v2.17.0** dispatcher 后，实际调用 `MFXLoad → MFXCreateSession(index=0)` 成功，`MFXQueryVersion` 返回 **1.35**；index=1 返回 -9（NOT_FOUND）。这证明当前 oneVPL dispatcher 可以创建 legacy session，尚未验证 D3D11 SetHandle、H264 Query/Init 和真实异步编码。

探测材料位于 `develop/tmp/media-probe`，属于临时材料，正式构建不能依赖这里。未使用 ffmpeg 替代硬件 API。

## 可复现依赖

官方源包：<https://github.com/intel/libvpl/archive/refs/tags/v2.17.0.zip>

本次下载 SHA256：`980d9f3f1dbecc7cbc28b0ff0c0647f925cbaf72844c85515b69b89e9603c35d`。

本机探测使用 VS18 2026 CMake，命令如下（正式 endpoint 仍按 CMake/Ninja，替换 generator 即可）：

```
cmake -S libvpl-2.17.0 -B vpl-build -G "Visual Studio 18 2026" -A x64 -DBUILD_TESTS=OFF -DBUILD_EXAMPLES=OFF -DBUILD_EXPERIMENTAL=OFF
cmake --build vpl-build --config Release --parallel
```

结果为 `vpl.lib` import lib + `libvpl.dll`。外部编码器 include `vpl/mfxdispatcher.h`、`vpl/mfxvideo.h`，链接 dispatcher，运行时由 dispatcher 发现驱动 runtime；不要直接链接或重新分发开发机的 Intel 驱动 DLL。可选 static dispatcher，但仍动态发现硬件 runtime。本机 API=1.35，因此 D3D11 外部分配器 + `mfxFrameSurface1::Data.MemId` 是可用范围；不要把仅 VPL 2.x 的新 surface import API 当作 UHD630 的必备接法。官方说明：[Session / legacy runtime](https://intel.github.io/libvpl/latest/programming_guide/VPL_prg_session.html)。

NVENC 官方 API 文档为 <https://docs.nvidia.com/video-technologies/video-codec-sdk/13.1/nvenc-video-encoder-api-prog-guide/index.html>。x64 动态加载 `nvEncodeAPI64.dll`、`NvEncodeAPICreateInstance`；使用官方 SDK 的 `nvEncodeAPI.h`。D3D11 不依赖 CUDA；`NvEncOpenEncodeSessionEx` deviceType=DIRECTX，device 为 D3D11 device IUnknown。正式依赖应固定 SDK/headers 版本和 hash，按 SDK 许可保留 notices，运行库来自 NVIDIA 驱动。

## Chromium 本地 API 核对

- `third_party/webrtc/api/BUILD.gn:81`：`create_peerconnection_factory` 位于 `if (!build_with_chromium)`，Chromium build 不能直接依赖此独立 WebRTC 示例入口。
- `api:create_modular_peer_connection_factory` + `api:enable_media` 可用。Chromium component build 应消费 `//third_party/webrtc_overrides:webrtc_component`，由其 public_deps 导出这些接口，避免在 SDK DLL 再静态嵌一份 WebRTC。
- 当前 `webrtc.gni` 将 rtc_library 的 public visibility 收回至 WebRTC tree；`webrtc_component` 是正常访问边界。原 timeutils 专用 patch 已用正式工具精确撤回，当前 manifest 为空，Chromium tracked diff 为空，4项patchset测试通过。
- `PeerConnectionFactoryDependencies` 使用 network_thread + signaling_thread，worker_thread 已弃用，且不支持单独 worker thread。network thread 应 `CreateWithSocketServer()`。
- `VideoEncoderFactory::Create(const Environment&, const SdpVideoFormat&)`；`VideoEncoder` 实现 InitEncode、RegisterEncodeCompleteCallback、Encode、SetRates、Release、GetEncoderInfo，异步调用 OnEncodedImage。
- `VideoFrameBuffer::kNative` 官方用于纹理，`supports_native_handle=true` 才能保持 GPU 输入。自定义 native buffer 保留纹理引用和真正表面 lease。ToI420 失败返回 nullptr，不隐式回读。
- `EnableMedia` 即使没有 audio track 也构造 voice engine；音频 codec factory 不能为 null，ADM 也必须存在。SDK 使用空 codec factory 和无设备 dummy ADM，不接音频采集/播放。
- 新 API 的 ICE 类型是 `webrtc::IceCandidate`，`IceCandidate::Create(mid,mline,sdp)`；local/remote description observer 使用 SetLocalDescriptionObserverInterface / SetRemoteDescriptionObserverInterface。

## 编码和纹理生命周期建议

建议 endpoint 持有每租户编码器和 GPU pool；SDK C ABI 注入外部 H264 encoder factory。SDK 只负责 WebRTC、SDP/ICE/DataChannel 与 native VideoFrame，避免把驱动、oneVPL 和端点设备池塞进 Chromium GN。

oneVPL：BGRA atlas 在 endpoint 自有 device 上转换为 NV12 encoder pool；`MFXVideoCORE_SetHandle(D3D11_DEVICE)`，外部分配器 GetHDL 返回纹理/array index 的 mfxHDLPair，`IOPattern=IN_VIDEO_MEMORY`。编码使用 `MFXVideoENCODE_EncodeFrameAsync`，完成线程 `MFXVideoCORE_SyncOperation`。处理 DEVICE_BUSY / MORE_DATA / NOT_ENOUGH_BUFFER 等真实状态；等待完成前不能覆盖输入纹理，Data.Locked 也必须遵守。先以 AsyncDepth=1、GopRefDist=1、无B帧/前瞻开始，再实测深度2/4对吞吐和延迟的影响。

NVENC：预注册输入纹理、map resource、提交 encode；Windows WDDM 使用异步 completion event，输出线程等 event 后锁 bitstream，复制完整 Annex B AU，解锁，再 unmap/归还输入池。不要每帧 register/unregister。GPU转换/复制完成和编码器读取完成是两种独立的完成条件。

browser shared slot 的 consumed fence 只需覆盖 endpoint 把它复制进自有 cache 的 GPU 读；编码应从稳定的 endpoint 表面 lease 读取。SDK submit 成功转交一个初始 lease，NativeBuffer 析构 release；endpoint 异步 encode 必须先 retain，再在硬件完成或取消后 release。COM AddRef 只保护对象寿命，不能防止池槽位被覆盖。

SDK completion 使用永不复用的 encoder ID，registry 弱引用状态、callback mutex 及 Release 屏障拒绝晚到 completion。endpoint destroy 必须排空或取消自己持有的编码任务；peer close 结束后才能释放回调 context 或卸载 DLL。

## 实现与实际验证

已新增独立 C ABI 头 `sdk/include/remotekit_rtc.h`、GN SDK RTC实现、无设备dummy ADM和独立消费端 `sdk/rtc-tests`。支持SDP offer/answer、trickle ICE、ICE_COMPLETE携完整本地SDP、DTLS-SRTP/SCTP、可靠有序remotekit DataChannel、D3D11 native texture/QPC/lease输入、endpoint外部异步H264编码回调。编码器/peer handle永不复用，SDK shutdown拒绝存活peer，close等待事件和native frame release回调结束。

Chromium WebRTC 会为sendonly仍构造recv channel；空decoder格式触发断言，builtin decoder又会把send SDP level降到3.1。SDK使用匹配H264 send能力的非空decoder capability，不提供接收video track/decoder实现，从而保持sendonly范围且正确广告5.1。

已在导出的 `sdk/dist/dev` 上用独立MSVC19.51 CMake消费端通过3/3 CTest：完整gathered SDP非trickle、trickle及跨线程生命周期模式，跑真实Peer ICE/DTLS/SCTP二进制DataChannel；验证42e033/packetization1 SDP、incoming recvonly offer正确得到绑定atlas track的sendonly answer、D3D11 native纹理初始lease转移/关闭回收、clock采样、关闭后API/晚到completion拒绝、无后续event回调、存活peer拒绝SDK shutdown。原有Mojo SDK独立消费端1/1 CTest也通过。这些测试不声称验证实际编码或媒体呈现。

`endpoint/src/media/nvenc_encoder.cpp` 已实现D3D11异步编码event、NV12纹理注册复用、受async_depth约束的Submit/Poll、Annex B输出、IDR/SPS/PPS、CBR低延迟与动态码率、EOS drain和销毁。已与QSV/converter一起CMake编译通过。本机运行NVENC smoke明确返回unavailable（没有驱动DLL），不提供NVENC吞吐/延迟结果。

## 协商和实验边界

H264 使用 constrained baseline、packetization-mode=1、level-asymmetry-allowed=1。1080p60 不能声明 level3.1；SDK 广告 `42e033`（level5.1），创建 encoder 时将协商 level idc 传给 endpoint，SPS 与实际编码必须遵守该限制。Chrome89 的实际 SDP/硬件解码和 pixel-marker 端到端表现需要目标客户端实验，现代本地 WebRTC 编译不能替代该结果。

单/四租户、动态50fps+、10ms RTT / 24–48Mbps、pixel marker<100ms 都仍需真实链路测量。先保存 capture-QPC、GPU复制完成、encoder提交/完成、RTP及客户端requestVideoFrameCallback/像素marker结果，再按队列增长定位瓶颈；不把 encoder API 返回成功视为呈现完成。

## 接续待办

- 已解决：SDK拥有的Chromium ThreadPool Start/Shutdown固定到SDK自有IO线程，Shutdown后完整join；跨线程initialize/shutdown独立消费端smoke通过。
- 核对Chrome89原始offer、最终encoder configure、驱动GetVideoParam及实际SPS的H264 level；level-asymmetry answer采用local level不能单独证明remote接收能力。未验证能力不提高客户端广告。
- 正式性能用Release服务，记录720p/1080p、每租户viewport/DPR/view数量、独享或共享带宽，单组GPU负载，暖机3–5s+有效20s；端到端p50/p95/p99、每秒FPS，按p95<100ms与平均>50评估，输入到观测另列。

首流已抓到并修复 `AddTransceiver` 创建的未关联sender不被JSEP复用、answer变inactive的问题；改为AddTrack再设sendonly。第二轮Chrome89已真实接收1288×728视频并读出输入刺激marker，详见[客户端能力证据](chrome89-h264-receive-capability.md)。原capture QPC与每次submit媒体时间已分离，idle refresh获得新RTP；layout_epoch完整携入编码job。C ABI encoded输出真实wire RTP（callback Result.frame_id，含随机offset），供接收端rVFC与layout epoch关联。新SDK日志打印options/Init/SetRates及首SPS，码率分析区分初始值与持续目标。
