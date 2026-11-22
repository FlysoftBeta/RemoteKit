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

## 界面缩放与顶部空白

画面始终按设备物理像素串流。设置里的界面缩放（50%–200%）把外壳和网页内容一起放大或缩小，不改变编码像素密度：

- `<body>` 按 `视口 / scale` 排版，再用 `transform: scale()` 放大回视口。不用 CSS `zoom`：Chrome 128 之前 `zoom` 下 `getBoundingClientRect` 与指针坐标不在同一空间，transform 在所有支持版本上都保持二者一致（都是视觉 px）。
- Viewer 上报的内容区尺寸是布局 px，DPR 是 `devicePixelRatio × scale`，所以远端页面的 DIP 等于布局 px，编码像素等于物理像素。`video-plane` 和尺寸过渡快照把视觉 rect 按元素的视觉/布局比例换回布局 px，再与 DIP 比较。
- MUI 的 Modal/Popper 默认挂在 `<body>` 下，直接跟随同一个 transform。不能把它们挂进 React 根容器 `#root`：React 拥有该节点的子树，挂在里面的 Menu 关闭后退出过渡完成却不卸载，残留的 Popover 根会挡住后续交互。Popover/Menu 用 `scaledAnchor` 把锚点 rect 和窗口尺寸换成布局 px；视口单位不跟 transform 走，宽度上限用 `--layout-vw`。断点按布局宽度计算（`html.layout-narrow` ≤600、`layout-compact` ≤760），不用 media query。
- MUI 的 TouchRipple 用 `getBoundingClientRect` 与指针 client 坐标（视觉 px）决定涟漪大小和位置，却按布局 px 写样式。缩放时把涟漪层设为 `scale` 倍大小再 `scale(1/scale)`，层内 px 即视觉 px，层仍正好盖住按钮。外壳的可交互控件因此都建立在 ButtonBase/IconButton 上（标签页是封装好的 `BrowserTab`），不写裸 `<button>`，焦点指示也交给 MUI 的 focus-visible。
- 提示一律用 MUI `Tooltip`，不用原生 `title` 属性：原生提示不跟界面缩放与主题，触屏上也不出现。图标按钮用 `Tooltip` 包裹并给同样的 `aria-label`（窗口工具栏用封装好的 `Tool`）；单行截断文字用 `OverflowText`，只在文字确实被截断时显示全文；`pointer-events: none` 的叠层（连接统计）不放提示，指标含义写在[诊断](diagnostics.md)里。
- 其他按视觉 px 量、按布局 px 写的地方同样要换算：dnd-kit 的排序位移除以 scale；它的拖拽浮层按视觉 rect 定位，所以挂在 `<body>` 之外的 `unscaledLayer()`，内容自己 `scale()`（React 19 会把指向 `<html>` 本身的 portal 移进 `<body>`，所以这一层是单独的元素）；悬浮面板拖动的指针增量除以 scale；`scrollLeft`、分隔条比例同理。下拉选择统一用 `ScaledSelect`（菜单经 `scaledAnchor` 定位），不用 MUI 自带 Select 的内部 Menu。高度用 `--layout-vh` 而不是 `vh`。

界面上方留出不响应操作的条带，高度以视觉 px 计：兼容模式开启时为 `max(env(safe-area-inset-top), 24px)`，关闭时等于安全区。页面声明 `viewport-fit=cover` 才能读到安全区，所以安全区始终由这条空白负责避开。外壳从条带下方开始排版，上报的内容区高度扣除条带。

**兼容模式**是设备级偏好（默认开启），只存在本设备的 `localStorage`（`remotekit.device.preferences`，由 `client/app/device-preferences.ts` 独占读写，读不到按默认值），不进 Control：它描述的是这台设备的系统界面与文件选择器，而不是用户。开启时除了 24px 顶部空白，外壳自己的上传 input（我的文件等）在没有 accept 时使用字面量 `accept="image/*"`——部分设备只有在这个值下才弹出可用的选择器，不展开成具体格式列表。

**减弱动态效果**是用户设置（Control 保存，默认关闭）：根元素带 `data-reduce-motion`，关闭 CSS 过渡与进出场动画、MUI 过渡与涟漪，JS 驱动的动效直接到终态；不确定进度指示保留转动。尺寸过渡只去掉动画，输入门禁不变。

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
- 只缺帧元数据（已收到像素与 RTP，没有匹配的 `frame`）时，Viewer 发 `media.refresh{reason:"metadata", rtpTimestamp, layoutEpoch, authEpoch}`，Endpoint 从缓存（256 条）重发原 `frame`，不重新编码 IDR；发送失败等 DataChannel 可写事件（`REMOTEKIT_RTC_DATA_WRITABLE`）再发，没有定时重试。只缺像素时走原来的呈现刷新。
- Endpoint 在实际调用 `remotekit_rtc_encoded` 发送时持有呈现锁，把屏障和布局更新串行化，覆盖已经进入编码器的旧结果。只在硬件接受纹理时检查门禁会与之后的布局变化或锁定竞争。旧 epoch 的结果被丢弃，并正常结束编码/纹理/尾帧租约。
- `generation:"0", views:[]` 表示输出暂不可用（暂停、故障、重建），立即撤销客户端的旧 ready；它不是"文档已销毁"的证据（见[移动编辑](mobile-editing.md)）。
- 布局换代的字段比较必须是完整规范化的布局身份。曾经候选布局漏了 `clientGestures` 字段，与实际布局永远不相等，2.4 秒内发出约 1000 次 prepare，客户端的两次 rAF 一直被重启，ACK 永远完不成。

## 稳定平面与键盘遮挡

atlas 计划和规范化布局身份只由稳定窗口尺寸、DPR、采样规划、成员顺序、矩形、padding 与对齐决定。`occludedBottom / occlusionRevision` 位于该身份之外；同一平面的矩形不因键盘缩小或移动，其他窗口也不重新打包。Viewer 的 video 保持稳定尺寸，编辑窗口的页面 viewport 在平面顶部原地缩短，下方传白色空带。

**遮挡版本**：`occlusionRevision` 是十进制 u64，值为 `(viewerGeneration << 32) | seq`（`control/shared/occlusion-revision.ts`）。`viewerGeneration` 由 Control 在每次 Viewer 接入时为该租户分配（`viewer_generations` 表持久计数，1..2^32-1，用尽返回 `limit_exceeded`，不回绕），随 `ProductState.viewer.generation` 下发；`seq` 是 Viewer 在该代次内从 1 开始的单调序号，不持久化，用尽同样报 `limit_exceeded`。Control 拒绝高 32 位不等于当前代次或同代次倒退的上报（`conflict` + `stale_generation`）。换设备接管后新代次的值一定大于同一 WebView 上前一个 Viewer 留下的版本，Endpoint 与 Browser 的 u64 比较因此不受设备时钟影响。

仅遮挡变化时 Endpoint 保持输出与编码管线，Browser 原地 resize WebContents；不更新 generation/layoutEpoch、不重发 layout、不触发 prepare/ready，也不为遮挡请求关键帧。`view.viewport` 只更新页面高度和输入边界，不改变呈现 ready。逐帧 `viewports` 将页面高度/revision 绑定真实 RTP，用于判断哪一帧已反映新高度。

窗口 resize、旋转、DPR/UI scale、可见成员或 atlas 规划变化仍按完整布局身份建立新代次和屏障；同时携带当前遮挡，让新代次首帧使用正确的页面高度。

**布局与输出 extent 分开**：编码 extent 在首个可见 atlas 时确定，只有 DPR 变化才重算。extent 不变的布局变化（resize、分栏、切换窗口、可见成员变化）不关闭输出、不重配编码器、不重建共享输出纹理：Browser 收到原地布局事务，只为尺寸变化的 view 换 plane，旧 plane 按 GPU Fence 退休；Endpoint 建立新的 layoutEpoch 与屏障。extent 真变化才完整重配。几何事务的首帧是显式呈现需求：新几何已应用、还没有匹配像素时按身份投递优先 Begin，直到成功，不受低 FPS 节拍留下的旧截止时间约束（见[节拍 · 呈现刷新](pacing.md#呈现刷新首帧与布局补帧)）。纯遮挡更新同样带 revision 级刷新需求。

**几何是瞬态的**：窗口尺寸、DPR、可见性、展示顺序与遮挡都不写入 `session.db`，直接应用、不经持久化事务；只有 view 集合与需要崩溃恢复的拓扑才提交。Endpoint 重启后 view 先用隐藏的 1×1 占位，等 Viewer 重报几何。

**几何优先**：协调线程记住上一次完整收敛的运行中文档的身份（除 revision、quality 与每个 view 的宽高、可见性、遮挡外的全部字段）。新 desired 与它身份相同、Session 运行中且未锁定、Browser 状态允许时，直接把几何应用到已暂存的 view 并走现有输出调和，跳过 prepare、start、完整观察与 `ConvergeDesired`；拓扑、身份、锁定、授权、策略或剪贴板变化，以及几何应用被拒绝（布局冲突、状态不允许）时走完整收敛。协调循环在执行任务后与维护后都检查是否有更新的 desired，有就跳过本轮维护与观察发布让几何先走（最多让出 100ms，防止维护被饿死）；只应用最新的 desired，过时几何自然合并。正在执行的慢步骤不会被打断。

**冲突立即重规划**：`view_transaction_identity_mismatch`、view 正在关闭、页面 viewport 未被接受这类能确定原因的冲突，按最新快照立即重规划，最多 3 次，之后才进入共享重试单元的退避；真正的 unavailable/outcome_unknown 才指数退避。

每个布局事务在 Endpoint 日志写一条 `layout.timeline`（desired 收到、converge、Browser RPC 发出/回执与锁等待、plane 重建、首个匹配 CompositorFrame、prepare、ready、首个匹配帧发送，相对毫秒），Browser 日志带同一关联键；Control 对 viewport 请求写 `viewport.timeline`。都只在几何变化时记录。焦点、文档与授权边界保留各自的输入/呈现门禁。普通尺寸变化使用过渡快照，键盘遮挡直接使用稳定视频。

**过渡快照的释放**：平面被布局换代隐藏时，`ViewportPreviewAdapter` 从该平面最后呈现的帧拷出模糊快照盖住内容区，并立即发布等待状态。快照只在该 view 的 video 真正呈现了当前布局的帧之后释放：它直接查询 `PresentationSession.planeReady`，并订阅该 view 的帧回调来重新确认。不能用 React 传下来的 frame-ready 状态判断：外部 store 的布局更新与普通 setState 不在同一个渲染批次，组件可能先拿到新布局、仍带着旧的 ready=true，提前释放快照，平面已隐藏而新帧未到，内容区会露出底色（深色主题下近似黑屏）闪一下。

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
- 音视频同步默认关闭：视频与音频使用不同的 stream id（`remotekit-video`、`remotekit-audio`），接收端不把它们放进同一同步组。设置开启时音频也用 `remotekit-video`，换取唇音同步。同组时 RtpStreamsSynchronizer 会把视频最小播放延迟抬到 NetEq 的音频延迟（实测音频静音补偿时约 84–99ms，视频最小延迟 60–111ms，而包抖动只有 2–17ms），min 一旦大于 0 就离开上面的低延迟分支。页面静音停发音频 RTP 后，同步器因没有新音频包直接返回，视频保持最后一次设置的同步延迟，不会回落到 0，直到重建 peer。关闭同步的代价是页面内音视频不对齐，音频通常比画面晚几十毫秒。stream id 写在 SDP 里，切换需要重建 peer（见[控制面](control-plane.md)）。
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
- 静音门：混音后的 s16 块全为 0 时，连续 100 块（1 秒）后不再发布，sequence 不前进，样本索引照常推进；环挂上时即处于静音态，不先发 1 秒静音。于是页面没有声音（无输出流、暂停、静音或 AudioContext 只输出 0）时不进 Opus、不发音频 RTP。判断在音源处做，不经 Control 往返，也不用 `IsCurrentlyAudible`：往返会截掉声音开头。1 秒尾巴让编码器和接收端 NetEq 先收到静音再断流，短停顿不反复重启发送器。恢复出声时样本缺口超过 8 块，SDK 走 `restart_gap`（发送器停用再启用，RTP 时钟按真实时间推进），SDP 不变，不需要重新协商，Viewer 的 track 不结束。
- 坑：内嵌音频服务时如果 `AudioServiceOutOfProcess` feature 仍为开启，`enumerateDevices` 会走到只在远端服务里存在的设备通知器并触发 CHECK。修正是在 `BasicStartupComplete` 里于 FeatureList 初始化前关闭该 feature。

**Endpoint 侧**：独立音频线程，不受视频编码停顿影响。

- `AudioRing` 在最新块领先超过 1 块时直接跳到最新，记账缺口；超过 50ms 的块丢弃。
- `AudioTimeline::Plan` 校验 480 样本对齐、QPC 单调、generation 与 sequence，再决定连续、补静音或重启。最多补 8 块（80ms）静音；更大的缺口、epoch 变化和不连续都重启时间线。重启只在实际操作成功后提交。
- SDK 的 `PageAudioSource` 以 16-bit/48kHz/立体声/480 帧和真实 time_ms 喂给 sink，不伪装成麦克风 ADM 设备。

**传输与播放**：同一 PeerConnection 上的 Session 级 Opus 立体声 track；客户端 offer 的音频方向为 recvonly，不接受上行音频。客户端用一个 WebAudio 图：扬声器上混到两声道 → splitter → 左右独立增益 → merger。关闭左声道不会把右声道复制到两边。一个音量为 0 的 audio 元素负责激活远端解码，可听输出只来自 WebAudio，不会重复。增益为 0 时音频流和时钟继续推进，避免本地静音期间积累队列、取消静音时一次性放出。左右声道选择是整个 Viewer 的设置，由 Control 保存。"不播放"（两声道都关）时 Control 的媒体策略 `audio=false`，Endpoint 停用音频发送器并在 SDK 内丢弃 PCM，不发任何音频 RTP；重新选中声道时恢复，不需要重新协商。锁定时音频 RTP 随产品媒体一起被停止，不只是本地静音。
