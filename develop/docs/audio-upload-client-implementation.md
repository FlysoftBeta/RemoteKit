# Viewer 音频、文件与拍照：实施记录

2026-11-02。本记录区分源码/模型检查与真实运行；目前未启动浏览器、媒体或摄像头，等待 root 的资源窗口。

## 已落源码

- `audio-output.ts` 单 Viewer WebAudio graph：先以 speaker 规则明确上混为双声道，再 splitter→独立 L/R Gain→merger，关左/右不会把另一声道复制过去。peer/track 换代停止旧轨道、断开节点并关闭 AudioContext。autoplay blocked 是本地状态；用户手势同步 resume，Control 偏好不变。
- `transport.ts` 增 audio recvonly transceiver；只在 audio section 的 Opus fmtp 加 `stereo=1;sprop-stereo=1`，保留原参数与视频/H264 路径。Workspace 保存完整声道对，所有窗口共享一个保存锁及失败提示。
- 更多菜单使用 Popover，普通操作为分段 MenuList，声音组是 sibling Box，Switch/不播放不放进 MenuItem。阻止播放时有覆盖提示，不占远端内容布局。
- Workspace 只挂一个 FileChooserDialog；可见活跃窗口优先，页面 dialog 与文件请求只显示一个；后台 tab 标记等待请求。全局 Ctrl/Cmd+L 检查 modal。
- 设备文件草稿只在本地内存。明确“使用文件”才 files.begin→逐文件 application/octet-stream POST→files.commit；上传 URL 仅同 origin 的 opaque ticket 路径。HTTP 失败保留草稿，后端自动清 batch；重试 begin 废弃旧未提交 draft。commit 结果未知时只重试同 uploadId，不能重传新 batch。validating 不冒充 selected，500ms 幂等查询；取消调用真实 files.cancel。
- 导航/请求消失/租约失效卸载时清摄像头、Worker、传输与 object URL；hidden 停摄像头而不因普通 blur 误取消系统选择器。getUserMedia 迟到结果按 generation stop。摄像头不请求音频、默认后置 preference，最高请求 1920×1080/15fps。

## 拍照算法与负载原型

root 批准的上限：600ms 内最多6个快照，Worker最多1个评分任务；最多 top3 完整候选，每张≤4Mi pixels、候选合计≤12Mi pixels，另有一个在途完整 canvas≤4Mi pixels。候选保存不可变 Blob，无长期 VideoFrame/ImageBitmap。原始 canvas 快照同时生成160px评分图和最终 Blob，不能回头从活动 video 抓“同一帧”。时间距离<80ms候选仅保留分数更高者。

`snapshotSyncMs` 包含同步 canvas resize/draw/低分辨率 getImageData/灰度转换；`blobWallMs` 是异步编码等待，`workerWallMs` 是 Worker 消息往返等待，`scoreMs` 是 Worker 内算法时间，均不得互相当主线程卡顿。

纯算法首轮平均 Laplacian 残差惩罚误罚锐利边缘，模型失败；改为 median 残差后固定素材通过。未惩罚的 Tenengrad/Laplacian 都把噪声图评得比清晰图高，是保留的失败例。加入曝光/噪声惩罚后的 Tenengrad 分数：清晰88428、模糊12963、运动8346、噪声543、低光168。Laplacian 变体也以清晰为首，但中间劣帧顺序不同；本轮用 Tenengrad 启发式，不保证照片“最佳”。

独立工具 `tools/camera-score-prototype.mjs` 只用固定合成图，不接触用户相机。产物 `develop/tmp/camera-score-prototype/result.json`、`ranking.svg`（每张96px缩略图）、五个14400字节灰度输入。相同输入做一次 loopback HTTP 评分并人工增加0/10/70ms请求延迟：各帧请求有效载荷14400字节，响应约200字节；0ms组wall约7–35ms，10ms组15–44ms，70ms组78–92ms。包含首次fetch/JIT，样本仅各一次，不能当真实网络或 Worker 性能对照。

当前倾向是本地 Worker；浏览器尚未测，不能据 Node VM 时间断言客户端不卡顿。待89/157短组检查同步快照p95≤20ms、无新增>50ms主线程 longtask、排序及取消资源上限；不满足就停止集成并报证据。无需引入 MediaRecorder/WebRTC 远端处理产品路径。Chrome89 基础 canvas/toBlob/Worker/getUserMedia 路径以及不支持/权限错误 fallback 都尚待真实验收。

## 轻量检查

新增8项测试通过：音频 SDP 幂等与视频不变、双声道位置/mono上混和graph销毁、固定素材排序、top3/时间去重/像素预算、文件accept/multiple/体积限制、唯一前台请求、原始Blob上传/同源/取消、旧拍摄取消不伤新Worker与canvas释放。另媒体feedback/共享回退相关7项通过；全 `tsc --noEmit` 通过。尚无生产build、真实文件上传、AV终点、摄像头权限或视觉验收。

## f1b 用户12FPS问题的定向核对

用户条件为Chrome138、单窗口、自动、1936×816，旧decode/paint约46/20，新约12/12，编码上限50。不是已证的高画质/4K原因。

f1b单平面不进入共享WebGL；与24b相比，生产MSTP fifo2/RAF调度和MediaFeedbackSampler均未改。Sampler是独立持续RAF，非按paint/decode回调驱动，但它测的是前台回调节拍，并非物理刷新率。低节拍经DC到Endpoint display ceiling、经WS到Control质量请求，可形成存量反馈风险；缺失新估计时transport旧缓存不失效也是存量问题。不能把这些直接认成本次根因。

A 已定位f1b的相关真实变化：Browser预算开始同时应用 capture fps 与 render_fps；auto新增codec cadence gate恒false，1936×816也不触及4.2宏块率。编码上限50不能排除adaptive render budget12，须看source/feedback/adaptive。

本轮仅补观测：2D原因、请求/生效FPS、源渲染目标/已应用、自适应reason、反馈RAF节拍/样本/年龄、源帧间隔。未为了显示WebGL强开单平面GL，未改变绘制计数或自适应策略；root根据新增数据决定最小复现/修复。
