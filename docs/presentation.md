# 客户端呈现与音频

Viewer 收到一路 H.264 atlas 视频和一路 Opus 音频。本文讲视频如何按 Window 呈现、新旧布局如何交接、输入何时被允许，以及接收端缓冲和音频管线。

## 设计意图

- 用浏览器原生的 `<video>` 解码与合成路径，不在 JS 里逐帧绘制。
- 画面与输入严格对应：绝不允许用户点击一个被贴上新布局标签的旧画面，也不允许旧布局的坐标落到新页面上。
- 布局变化（resize、焦点切换、文档替换、编码尺寸变化、锁定）是协议边界，不是 CSS 更新。
- 稳态没有逐帧握手；只有布局换代时有一次屏障。

## video 平面

一个 Session 一条接收 track。每个可见 Window 的内容区各有一个 `HTMLVideoElement`，通过新的 `MediaStream` 共享同一条 track（不 clone track）。

- 元素：`muted`、`playsInline`、`controls=false`、禁用画中画和远程播放、`tabIndex=-1`、不可拖拽、`pointer-events:none`。不启用任何原生媒体交互。
- CSS 对视频做裁剪、缩放、平移，露出 atlas 中该 plane 的 ROI，并把它放到 Window 内容区的实际 bounds 上。atlas 矩形只决定源裁剪；目标位置和大小来自客户端内容 bounds。
- 输入由叠在上面的透明 canvas 接收（`data-video-input=true`）；它的存在不代表有 canvas 绘制后端。
- 呈现注册以稳定的 `viewId` 为键。焦点、同 view 的文档更新、布局代次变化只更新现有元素的身份与门禁，不拆除视频；只有 viewport 真正移除或接收 track/peer 更换时才更换媒体资源。Chrome89 上把同一个 video 复用到新 peer 会出现只解码不回调 rVFC 的情况，所以新 peer/track 一律新建元素，回调和 promise 都绑定到 attempt。
- 同一条 track 的多个 video 不是多条解码链。Chromium157 与 Chrome89 源码都确认：`VideoReceiveStream2` 解码一次，经 `VideoBroadcaster` 和 Blink `MediaStreamVideoTrack` 分发给每个 `WebMediaPlayerMS`。但每个 video 有自己的 compositor/sink，可能各做一次 GPU 格式转换，所以增加平面仍增加呈现开销；各元素的 decoded 计数不能相加当作物理解码次数。

视频是唯一的串流呈现后端。MSTP、共享 WebGL、Canvas2D 绘制路径和按超时切换后端的回退已删除。尺寸过渡快照、拍照、测试像素读回使用 canvas，但它们不是串流后端。

## 布局屏障

```
Endpoint: layout{generation, epoch, 编码尺寸, views[身份, 矩形, DPR, mediaScaleX/Y]}
Endpoint: presentation.prepare{version:1, barrierId, outputGeneration, layoutEpoch}
Client:   隐藏所有 video，撤销输入 ready
Client:   页面在前台时等两次 rAF（确保隐藏已真正合成）
Client:   presentation.ready{同一个完整 key}
Endpoint: 打开发布门：之后第一个成功发布的帧必须是关键帧
Client:   每个 video 观察到自己的真实 RTP 并匹配当前 epoch → 该平面 ready → 允许该平面输入
```

- 呈现协议先协商：`media.presentation{version:1, backend:"video"}` → `presentation.mode`。未完成协商和当前布局确认之前不发布视频码流。
- 屏障 Key = (barrierId, outputGeneration, layoutEpoch)，全部是十进制字符串。旧 peer 或旧 Key 的 ready 不能放行。重复的同 Key prepare 是幂等的，不会重启已经开始的两次 rAF 等待。
- 页面在后台时 ACK 暂停推进，不存在用超时绕过屏障的路径。
- Endpoint 在实际调用 `remotekit_rtc_encoded` 发送时持有呈现锁，把屏障和布局更新串行化，覆盖已经进入编码器的旧结果。只在硬件接受纹理时检查门禁会与之后的布局变化或锁定竞争。旧 epoch 的结果被丢弃，并正常结束编码/纹理/尾帧租约。
- `generation:"0", views:[]` 表示输出暂不可用（暂停、故障、重建），立即撤销客户端的旧 ready；它不是"文档已销毁"的证据（见[移动编辑](mobile-editing.md)）。
- 布局换代的字段比较必须是完整规范化的布局身份。曾经候选布局漏了 `clientGestures` 字段，与实际布局永远不相等，2.4 秒内发出约 1000 次 prepare，客户端的两次 rAF 一直被重启，ACK 永远完不成。

## 帧与 RTP 匹配

- Endpoint 对每个成功发布的帧发 `frame{rtp, layoutEpoch, 编码信息}`，rtp 取自发布回调的实际 wire RTP 时间戳，不是调用方设定的值。
- 客户端 `FrameEpochGate` 保存精确的 RTP→epoch 映射（容量 256），不做范围推断。
- 每个 video 需要自己第一次观察到的真实 RTP 匹配当前 epoch。别的元素呈现过的帧不能授权本平面的输入。
- 已确认且未变化的布局内，逐帧元数据迟到不会隐藏一个正在稳定播放的视频；未知 RTP 不会被编造成测量样本。
- 迟到的元数据可以匹配同一元素最近一次观察，但必须在同一个已确认屏障、track、attempt 和文档身份范围内。它可以恢复输入资格，但不增加呈现计数，也不声称当前像素就是那个 RTP。
- 隐藏或布局过渡撤销旧观察；恢复后重新等本元素的新帧。

## 接收端缓冲

- 客户端对实际 receiver 设置 `jitterBufferTarget = 0`。Chrome89 没有标准属性，在可用时设置 `playoutDelayHint = 0`。能力、尝试设置的值和读回值分别报告。
- Endpoint 在创建 peer 时请求 RTP playout-delay min 0 / max 50ms。Chromium157 中 min=0 且 0 < max ≤ 500ms 会进入低延迟分支，保留有界的合成队列；50ms 约等于 60Hz 下三帧的合成预算。
- 这些都是请求，不是保证：min=0 时解码调度仍有约 8ms 的最小值；`jitterBufferTarget=0` 也不取消解码和抖动所需的等待。
- 视频与音频使用不同的 stream id（`remotekit-video`、`remotekit-audio`），接收端不把它们放进同一同步组。同组时 RtpStreamsSynchronizer 会把视频最小播放延迟抬到 NetEq 的音频延迟（实测音频静音补偿时约 84–99ms，视频最小延迟 60–111ms，而包抖动只有 2–17ms），min 一旦大于 0 就离开上面的低延迟分支。代价是页面内音视频不做唇音同步，音频通常比画面晚几十毫秒。
- 0/50 对比未设置（同二进制，1936×1008，QSV，48Mbps/10ms）：合成 55.5→57.9FPS，丢帧 58/1172→9/1170，末包→合成 p95 78.5→50.4ms，实际缓冲均值 59.6→28.9ms，marker p95 115→92ms。
- 0/10 被否决：末包→合成 p95 约 39→18ms，但合成帧率 45→38FPS，marker p95 没有改善，首段 rVFC 间隔 p95 38→74ms。更紧的预算导致有用的呈现丢失。
- 0/0 是另一种原生行为，不能和 0/10、0/50 的结果混在一起。

## 统计口径

| 计数 | 来源 | 含义 |
|---|---|---|
| 解码 FPS | RTC inbound stats | 解码器输出 |
| 元素收帧/丢帧 | video 元素 | 进入/被丢弃的帧 |
| 合成提交 | 各 video 的 `presentedFrames` 增量 | compositor 提交，用作显示 FPS |
| rVFC 回调 | `requestVideoFrameCallback` | 主线程回调；多次提交可合并为一次回调 |

rVFC 回调次数不是显示 FPS：Chromium157 一个 10 秒区间里有 600 次 SetCurrentFrame、542 次调度加 284 次合并、93 次 stale 跳过，最终只有 450 次 JS 回调。差距发生在 JS 之前，不代表服务端没有编码这些帧。合成提交也不是物理屏幕点亮。静态窗口的 0 是有效值；计数器倒退或布局门禁变化时重建基线；缺失字段保持缺失，不填 0。更多见[诊断与测量](diagnostics.md)。

## 音频

**Browser 侧**：`TargetManager`（派生自 `AudioManagerBase`）作为本 Session 的音频管理器，通过 `ContentBrowserClient::CreateAudioManager` 安装；音频服务内嵌在 Browser 进程（out-of-process audio 被关闭）。所有页面的输出流在一个时钟上混音/重采样为 48kHz 立体声 s16，每块 480 帧 = 10ms = 1920 字节。不录制系统混音，不经过声卡，不跨 Session 混音。

- 共享音频环 `SharedAudio` v1：8 个槽，每块带 session/generation、sequence、样本索引、首样本 QPC；64 字节对齐的原子/seqlock 发布，读者拒绝撕裂或身份不符的块。稳态不走 IPC。
- 绝对 10ms 调度：错过期限时推进样本索引并标记不连续，不突发补发旧块。时间线属于整个 Session 的混音，与视频节拍无关：静态视频不停音频时钟。
- 坑：内嵌音频服务时如果 `AudioServiceOutOfProcess` feature 仍为开启，`enumerateDevices` 会走到只在远端服务里存在的设备通知器并触发 CHECK。修正是在 `BasicStartupComplete` 里于 FeatureList 初始化前关闭该 feature。

**Endpoint 侧**：独立音频线程，不受视频编码停顿影响。

- `AudioRing` 在最新块领先超过 1 块时直接跳到最新，记账缺口；超过 50ms 的块丢弃。
- `AudioTimeline::Plan` 校验 480 样本对齐、QPC 单调、generation 与 sequence，再决定连续、补静音或重启。最多补 8 块（80ms）静音；更大的缺口、epoch 变化和不连续都重启时间线。重启只在实际操作成功后提交。
- SDK 的 `PageAudioSource` 以 16-bit/48kHz/立体声/480 帧和真实 time_ms 喂给 sink，不伪装成麦克风 ADM 设备。

**传输与播放**：同一 PeerConnection 上的 Session 级 Opus 立体声 track；客户端 offer 的音频方向为 recvonly，不接受上行音频。客户端用一个 WebAudio 图：扬声器上混到两声道 → splitter → 左右独立增益 → merger。关闭左声道不会把右声道复制到两边。一个音量为 0 的 audio 元素负责激活远端解码，可听输出只来自 WebAudio，不会重复。增益为 0 时音频流和时钟继续推进，避免本地静音期间积累队列、取消静音时一次性放出。左右声道选择是整个 Viewer 的设置，由 Control 保存。锁定时音频 RTP 随产品媒体一起被停止，不只是本地静音。
