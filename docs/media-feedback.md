# 客户端媒体反馈

此协议是本轮自适应源帧率的接口设计，正在实现。反馈走已有认证WebRTC DataChannel，不经过Control产品状态，也不添加browser与Endpoint逐帧通信。

客户端连接存活时最多每1500ms发送一份`media.feedback`：

```json
{"type":"media.feedback","version":1,"seq":1,"layoutEpoch":"1","outputGeneration":"1","visible":true,"windowMs":1500,"rafSamples":90,"displayHzEstimate":60,"decodedFrames":90,"videoFrames":89,"planes":[{"view":"view-1","frames":89}],"roundTripTimeMs":10}
```

- `seq`为本连接递增整数；连接替换时重新计数。代次必须匹配当前布局与输出；Endpoint按自己的接收时间计算年龄，不能跨机器直接相减客户端时钟。
- `windowMs`为实际采样窗口。`decodedFrames`、`videoFrames`和每个plane的`frames`都是该窗口增量；缺少可靠前值或计数回退时省略字段，不用0表示未知。每个plane只计新视频帧，重绘不计；多plane不相加当作视频FPS。
- `visible`是document可见性，不改变Control的active tab/split产品状态。`planes`来自实际注册的可见布局渲染器，不能只上报选中页。
- `displayHzEstimate`由有效RAF间隔估计，是当前回调能力而不是物理显示器刷新率。后台、样本不足时省略；报告`rafSamples`供判断。独立RAF只采样，不驱动canvas绘制。
- `roundTripTimeMs`为可选RTC candidate-pair RTT。允许另报可选窗口`packetsLost`、`framesDropped`，字段缺测时省略。
- Endpoint检查消息类型/版本、当前peer、单调seq、代次、有限数值与边界，过量反馈合并为最新一份；不占输入队列、不计入inputRejected。未知字段可忽略。

初始实现只接通观测与常态编码队列计数，反馈不自动改变源帧率。随后由独立策略以≤1Hz、仅值变化时调用现有`output.configure {render_fps, fps}`，不携带几何或device_scale，不修改QSV名义帧率。低实际帧率本身不代表压力，静态页面不能据此降速；策略及参数的选择必须用实验验证。
