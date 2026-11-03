# 媒体反馈、时钟与WebRTC适配

网络适配由WebRTC负责。Control与Endpoint保留诊断，不再运行延迟降DPR、质量码率预设或独立网络分辨率控制器。

## 控制路径

质量三档对应MAINTAIN_RESOLUTION、BALANCED、MAINTAIN_FRAMERATE。Control策略只有degradationPreference和客户端maxFps。SDK保持screenshare身份，仅为RemoteKit开启原生screenshare平衡/质量适配门禁，算法与阈值保持上游实现。

Endpoint每次fresh/force帧提交前调用SDK原生AdaptFrame，以原始atlas尺寸取得丢帧、编码尺寸及max_fps，再建立匹配布局屏障。GPU缩放完整atlas，X/Y比例分别传播，不裁plane或修改页面DPR。

SetRates提供硬件目标码率/FPS。Comp根据Slot占用、客户端能力及WebRTC限制发送Begin。观察输入FPS不是永久源上限，slot空闲时可恢复到官方限制；零码率暂停，恢复请求关键帧。配置及H264上限只是能力边界。

## DataChannel诊断

Client约每1500ms发送layout绑定的media.feedback，包括seq、generation/epoch、visibility、窗口长度、显示回调能力、解码/丢帧及plane新帧增量。Endpoint核对peer、序号、代次和有限值，过量反馈合并，不挤占输入。

缺测省略；多个plane计数不相加当物理解码FPS，静态低FPS不直接判压力。video使用可见期间presentedFrames增量，canvas使用JS新帧提交数；隐藏/屏障撤销基线。这些反馈不自行调整网络码率、DPR或分辨率。

## 完成时戳与呈现估算

只有有效原始源完成QPC才生成captureWallTimeMs、captureMonotonicMs、captureClockUncertaintyMs及sourceCaptureId，与真实wire RTP/epoch配对。新OSR暂未测完成时戳，capture_time_us=0；提交、ready查询和编码时刻不能补作采集时间。

Client分别校准Endpoint媒体时钟与Control产品新鲜度时钟，不混用机器wall。过期、跳变、不确定度超限、隐藏及重复内容样本排除。WS feedback仍可报告p95/窗口/sequence等诊断，但不触发质量对账。

兼容名称capture-end-to-paint的终点为video compositor回调或canvas JS提交，不是物理屏幕点亮，也不含此前渲染等待。缺有效源时戳不产生样本，分段p95不可相加。

receiver支持jitterBufferTarget时设0；Chrome89仅在可用时设playoutDelayHint=0。分别报告能力，不把兼容hint或RTP playout-delay扩展说成标准属性已生效。

反馈sequence终生单调；时钟reset只清校准/样本，保留序号及已见内容身份。
