# 媒体反馈、时钟与自适应

有两条反馈链，各司其职；都不增加browser↔Endpoint逐帧IPC。

## DataChannel源预算反馈

Client约每1500ms发送layout绑定的media.feedback，包含连接内seq、outputGeneration/layoutEpoch、document可见性、实际窗口长度、RAF样本/刷新估计、解码/丢帧/plane新帧增量及可用RTT。

Endpoint校验当前peer、单调seq、代次、有限值和边界，过量反馈合并为最新，不挤占输入队列。缺测省略，不以0代替。plane帧数不相加冒充视频FPS，同帧重绘不计；静态低FPS不直接判压力。显示Hz估计是回调能力，不是物理面板测量。

默认video的plane帧数使用各video可见期间`presentedFrames`增量，不使用rVFC回调次数；canvas回退使用JS新帧提交数。布局屏障和隐藏时撤销观察基线，不把隐藏期间帧数补进前台统计。

源策略在用户媒体targetFps上限内调度，按值变化更新本地BeginFrame/发布预算。网络码率仍由WebRTC拥塞控制；媒体策略设置上限，不反复重置start bitrate或强制高最低码率。

## WS产品质量反馈

SDK在原capture_qpc仍有效时用QPC↔系统UTC配对生成captureWallTimeMs、captureMonotonicMs、captureClockUncertaintyMs和sourceCaptureId，随真实wire RTP/epoch元数据送Client。SDK内部重映射的capture_time_us不是Unix时间，不能直接相减。无有效capture就省略，不能用纹理ready或编码时间冒充。

Client通过Control clock.ping校准双方wall offset；当前Control和Endpoint在同机。以匹配wire RTP/epoch的video compositor回调观察或canvas回退的JS提交计算采集完成→呈现估算。两种终点按后端区分；未知RTP元数据不生成样本。重复sourceCaptureId（包括idle尾帧）、隐藏、陈旧请求、wall/monotonic跳变、过期校准或总不确定度>25ms不进入策略。

每2秒窗口通过WS feedback送p95、sampleCount、windowMs、sequence、sourceCaptureId、sampledAtServerMs、visible、latencySource='capture-end-to-paint'及clockUncertaintyMs，可附displayHzEstimate。Control再次检查范围、去重和新鲜度。

连续3个有效窗口>300ms时分辨率倍率乘0.8，调整冷却5秒；<150ms连续健康30秒逐级恢复。ClientScale与面积预算决定基础倍率，Browser DPR范围0.5–4。实际码率/FPS/编码尺寸受硬件、协商及网络约束，requested/applied分开报告。受控自动化不运行这套产品策略。

Stats显示估算及不确定度；Pixel marker带CRC的render/input端到端值独立显示。协议保留`capture-end-to-paint`名称以兼容现有反馈校验，其实际终点由呈现后端解释；不含此前渲染/捕获等待，drawImage返回和rVFC观察都不是物理屏幕点亮。分段p95不能相加。

同一反馈对象的sequence终生单调。时钟或测量reset只丢弃校准/样本，保留序号与已见源帧身份，避免服务端等待旧序号追平或把静态尾帧重新计样。
