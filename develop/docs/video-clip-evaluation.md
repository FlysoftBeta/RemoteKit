# video + clip-path呈现候选评估

2026-11-02。批准的初次4×12秒已实际完成，未追加或重跑。结论：**暂不替换产品后端**。固定单plane下video减少接收端3D工作，但未观察到帧提交优势；rVFC回调及presentedFrames跨度低于约50FPS的canvas提交。直接video的逐帧布局授权、输入关联仍未解决。本机为157，不是用户Chrome138；不能声称解决旧版46/20→12/12回归。

## 条件与隔离

证据：`develop/tmp/video-clip-20261102-1745`。原始分块`metrics/client-metrics.jsonl`已离线完整重组为`case*.json`；`summary.json`保存资源重合窗口；四张PNG为实际截图。独占GPU/host，无并行构建或其它媒体QA。

- 接收端157.0.8103.15，headless、fake60、DPR1。同一RTC peer、receiver SSRC、track、H264 codec、源页面贯穿四case，无交互。viewport1920×888，实际内容1920×800；source/atlas/coded/decoded1936×816，epoch10/generation3、mediaScale1恒定。
- codec `video/H264`、PT108、`level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e034`，Endpoint实际level52。不是用户Chrome138的codec ceiling50现场。
- 原型用现有Endpoint启动参数`--fps=50 --browser-render-fps=50 --adaptive-fps=off`。wrapper拦截Control的`session.mediaPolicy`并ACK；ACK只用于隔离，生效依据是四case真实stats：`adaptiveFps.enabled=false`、`actualAppliedRenderFps=50`、`samplingFpsBudget=50`、`mediaPolicy.applied.adaptive=false/targetFps=50`。生产RPC明确拒绝adaptive:false，原准备wrapper已修正。Control仍显示auto/requested52，**本组是固定策略实验，不是普通auto现场**。
- 编码器nominal/appliedFps为60，实际编码约50，不能声称codec ceiling50；固定的是源/采样节拍。BWE保留；四case前后实际编码bitrate均44934Kbps、max48000，动态源码流远低于该上限。
- 全部case统一抑制Control feedback、DC `media.feedback`，保留clock、layout、wire RTP/frame metadata和stats。
- 2D/WebGL保留MSTP不可变帧及RTP/epoch授权，仅替换生产draw。video两组显式`stopProcessorPump()`，取消reader、关闭待呈现/持有帧，不stop接收track；MSTP read delta、候选canvas frames/draws均0，生产video未附track。每元素引用**同一原track对象**，未clone。保留DC metadata/rVFC gate观察，不授予产品input。
- 每case700ms预热、一次12秒等待，stats往返后实际窗口约12.20秒。没有补跑。

## 帧节拍结果

| Case | wire metadata FPS | receiver decode FPS | canvas JS提交 FPS | rVFC回调 FPS | presentedFrames跨度/秒 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 单plane 2D | 50.00 | 50.08 | 49.75 | — | — |
| 单plane WebGL实验 | 50.01 | 50.01 | 49.93 | — | — |
| 单video clip | 50.01 | 50.01 | 0 | 43.53 | 47.55 |
| 同atlas双video DOM | 50.05 | 50.05 | 0 | 40.14 / 38.50 | 47.67 / 47.67 |

四组inbound dropped delta均0，codec/尺寸/receiver/策略无变化，runner invalid均为空。Endpoint用自身sender stats时间跨度归一化的encodeCompleted节拍49.96/50.02/49.95/50.03FPS，atlasDelivered节拍50.05/50.02/49.95/49.95。端点stats每秒更新，不能把其计数差简单除以本地窗口；wire metadata和receiver counters给出同窗对照，源编码节拍可比。

canvas终点是JS提交，rVFC是compositor提交相关观察，**不是同一个paint终点，也都不是物理屏幕点亮**。rVFC会跳过多个presentedFrames，回调次数不能直接当显示FPS，presentedFrames跨度也不证明每帧实际可见。本组video无胜出信号，不计算FPS收益倍率。2D/WebGL平均JS绘制调用约0.366/0.329ms，不含GPU完成时间。

第四组只把同一产品plane切成左右960×800 ROI再拼回原位置，测试元素fanout，**不是真实双Window packing**。单video clip只能裁切，不能把任意atlas的多个ROI重排到不同UI位置，一般仍需N个video分别定位/缩放/裁切。

## CPU/GPU与解码fanout

表中为正式窗口内重合的接收端进程和，CPU单位逻辑核；GPU是Windows引擎计数器和，受驱动口径影响。

| Case | 有效样本 / 首尾跨度 | CPU核 | 3D % | VideoDecode % |
| --- | --- | ---: | ---: | ---: |
| 2D | 4 / 3.04秒 | 0.500 | 13.54 | 8.78 |
| WebGL | 11 / 10.13秒 | 0.343 | 11.50 | 8.71 |
| 单video | 11 / 10.15秒 | 0.291 | 0.00 | 8.70 |
| 双video DOM | 11 / 10.13秒 | 0.281 | 4.12 | 8.84 |

首case并行工具实际调度导致sampler先启动，仅末4样本与正式窗口重合；后三组改成隐藏后台sampler后调用浏览器。首case资源**不能与其它整窗严格配对或计算收益倍率**，没有补跑。WebGL→video的3D下降支持保留候选；0%仅指采到的接收端3D计数，不表示GPU零工作，不证明overlay/零拷贝。

单video、双video每个元素webkitDecodedFrameCount均36→646；双元素值一致，receiver decode约50，VideoDecode约8.7–8.8%，未见双倍信号。双元素458个RTP被双方回调共同观察，presentationTime差median0/p95 0.1ms/max0.2ms，支持本固定布局观察同一接收帧；不证明每帧同步无缝。

CDP单组新增1个player、双组新增2个player；player数不是物理解码器数。没有playerPropertiesChanged或明确decoder实例属性。`VideoPlaybackQuality`原型getter被Playwright序列化为空对象，故本次**没有有效元素quality dropped指标**；保留了receiver drop、webkitDecodedFrameCount、rVFC及GPU数据。原型已显式复制quality字段以便未来复用，仅语法检查、不补跑。因此只能说“**未见重复解码信号**”，不能说“证明只有一个decoder”。

## 实际截图检查

Sol逐张检查四张1920×888截图：内容ROI完整、文字方向/大小一致，无翻转或内容内错误黑边；双元素x960接缝截图未见缝隙。video两张顶端88px黑条是实验holder遮盖产品浏览器栏，不是解码letterbox，不是产品UI。截图不能验收动态接缝、逐帧同步、延迟或输入。

## 产品化边界

暂时保留产品canvas后端。若未来另有明确价值，须由root先确定最小安全契约：

1. 布局/source/track代次切换发起时同步隐藏旧video、使input无效，继续拒绝旧epoch；不能等rVFC事后发现再隐藏。
2. 恢复显示须有清除旧流/解码队列的明确边界，并绑定新代次完整几何及RTP；同尺寸重排不能靠宽高识别。可研究每布局独立接收track代次或严格停流/排空事务，本原型未实现。
3. 一次合格rVFC后，video仍可在JS前独立提交后续未知epoch帧；rVFC不是逐帧拒绝API。须有媒体生命周期契约保证后续帧都属于授权代次，才能关联实际呈现plane和input。
4. N元素要处理DIP/DPR/mediaScale/letterbox/screen坐标，并验证动态同步、旧布局输入门禁和Chrome89，不能为FPS放松现有wire RTP/layout/input gate。

当前结果不复现Chrome138的12FPS问题，也不定位旧版decode/paint回归，不能以157新路径结果覆盖用户现场。

## 工具与清理

独立原型`tools/viewer-video-clip-{server.mts,candidate.js,browser.js}`复用正式baseline fixture/helper/resources，产品client/server/native未因本评估改动。两JS语法通过；MTS wrapper实际启动且真实stats验证策略。

已dispose恢复回调/feedback并detach CDP，关闭自建唯一157 context；fixture `/shutdown`、PTY exit0，sampler均退出，33271/33272无监听。最后host-managed `browser_close`关闭本代理默认host页，避免profile锁。原始Profile/数据库仅在develop/tmp证据目录，不提交、不打包。
