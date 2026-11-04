# 媒体反馈、时钟与WebRTC适配

网络适配由WebRTC负责。Control与Endpoint保留诊断，不再运行延迟降DPR、质量码率预设或独立网络分辨率控制器。

## 控制路径

质量三档对应MAINTAIN_RESOLUTION、BALANCED、MAINTAIN_FRAMERATE。Control策略只有degradationPreference和客户端maxFps。SDK保持screenshare身份，仅为RemoteKit开启原生screenshare平衡/质量适配门禁，算法与阈值保持上游实现。

Endpoint每次fresh/force帧提交前调用SDK原生AdaptFrame，以原始atlas尺寸取得丢帧、编码尺寸及max_fps，再建立匹配布局屏障。GPU缩放完整atlas，X/Y比例分别传播，不裁plane或修改页面DPR。

SetRates提供目标码率与WebRTC观测的输入FPS，后者不是独立的GCC帧率上限。Comp根据Slot占用、客户端能力及WebRTC限制发送Begin。观察输入FPS不是永久源上限，slot空闲时可恢复到官方限制；Endpoint收到零码率时暂停，恢复请求关键帧。配置及H264上限只是能力边界。

外部硬件编码器不声明可信码率控制器，保留WebRTC原生的编码前超发丢帧保护。硬件速率更新成功不等于实际输出已经跟上预算，仍须观测编码字节和发送包排队。编码前丢弃通过纹理引用释放归还租约，首次/布局刷新仅在有效关键帧发布后完成；不能将源码声明修正直接当作端到端延迟改善的证据。

QSV对观测FPS去抖后才改变H.264/VPP名义时基，避免60→59→58等短时波动制造新序列。名义帧率周围的小变化保持原值；观测持续1秒低于当前值80%时，以该窗最大观测值降低时基；超过当前值125%时一次恢复到Configure确定的合法上限。这个策略只处理硬件每帧预算和重配，不改变WebRTC码率、Comp实际源节拍或官方降级限制。单层maxFps上调不保证触发WebRTC Configure，名义上限以最近一次真正Configure为准。

后端报告低帧率窗口的到期时间，EncoderWorker复用既有循环，在在途编码排空后重放最后有效速率；无需WebRTC重复发送相同参数，也不增加定时线程。暂停取消待处理窗口，新反馈优先。实际时基变化仍使用合法的新序列、VPP更新和IDR恢复；普通码率Reset保持序列。初始化和速率更新均校验驱动读回帧率。固定60FPS及BRC-only缺帧提示曾在本机造成低FPS画质回退，未采用，见[对照记录](../develop/docs/ud710-local-repro-20261104.md)。

QSV在已排空编码任务后更新速率，时基变化和重建前确认VPP输出排空。若Reset返回`MFX_ERR_INCOMPATIBLE_VIDEO_PARAM`，在原oneVPL session/device重新Query/Init编码组件，核对几何、时基、色彩、LowPower与协商level，按需扩充VPP输出池并请求IDR。不得因此永久退出编码线程、重建RTC或回退其他呈现后端；其他错误继续明确报告。[旧逐次观测FPS重配路径的低FPS恢复记录](../develop/docs/file-unlock-investigation-20261104.md)保留为历史证据。

首次呈现和显式刷新不能在SDK接受纹理时视为完成：source可能尚未交给编码器，编码结果也可能被布局屏障拒绝。Comp按peer、授权代次与完整呈现屏障保留刷新请求；只有该请求标记的关键帧通过屏障且SDK编码发布成功，才消费请求。请求合并、单个尝试在途，失败后的强制Begin和重新提交至多每秒一次，仍服从SetRates、Slot背压和可见布局门禁。源等待可以取消，已进入编码的尝试等待实际完成；旧代次结果不能完成新请求。该恢复请求与静态页面的单次idle尾IDR分别记账。

## DataChannel诊断

Client约每1500ms发送layout绑定的media.feedback，包括seq、generation/epoch、visibility、窗口长度、显示回调能力、解码/丢帧及plane新帧增量。Endpoint核对peer、序号、代次和有限值，过量反馈合并，不挤占输入。

缺测省略；多个plane计数不相加当物理解码FPS，静态低FPS不直接判压力。Video使用可见期间presentedFrames增量；隐藏/屏障撤销基线。这些反馈不自行调整网络码率、DPR或分辨率。

Stats同轮采集RTC解码、各video元素收帧/丢帧、compositor提交与rVFC回调，区分四种计数。有效静态窗口显示0，计数器倒退或布局门禁变化重新建立基线。浏览器提供时显示末包receiveTime→presentationTime、提交→实际回调、预计显示超期，以及RTC累计差分的jitterBufferDelay与totalDecodeTime均值。缺字段不填0；旧capture/copy路径空白项不再进入当前叠层。视频提交和预计显示都不是物理屏幕扫描完成。

接收采样另区分video/audio的实际缓冲、目标缓冲和最低目标缓冲差分均值；最低目标不是观测到的最快帧。`totalAssemblyTime / framesAssembledFromMultiplePackets` 的同窗增量只覆盖已解码的多包帧首末包间隔；`totalProcessingDelay / framesDecoded` 的同窗增量包含首包到解码完成的等待，不能作为纯解码耗时。音频使用自己的出缓冲样本计数，不与视频帧数混用。

重传包占比为 `ΔretransmittedPacketsReceived / ΔpacketsReceived`，发送端对应 `Sent` 字段，分母包含重传包；字节占比同理。NACK是反馈计数，不是重传包数。只有字段齐备、窗口连续、计数有效且分母大于零才产生占比；RTP丢包累计值可能因迟到包下修，保留带符号差分。发送端使用Endpoint自身采样时间，重复缓存报告不产生伪速率。`totalPacketSendDelay`记录发送前累计等待，不单独证明网络单向耗时或纯pacer耗时。

低RTT不能排除帧到达抖动、重传或组帧等待；带宽估计也不能代替连续的实际包时序。用户现场可通过[设置内诊断收集](diagnostic-collection.md)生成服务端tar.zst诊断包，不再从Stats下载JSON。

Video是唯一串流呈现后端。缺少首帧或当前RTP元数据时，保持门禁并在原连接上限频请求刷新；能力、协议或播放错误单独报告，不回退Canvas。解码FPS、接收码率是窗口增量，0不代表连接从未接收过视频；编码耗时也不表示对应码流已经发布。

## 完成时戳与呈现估算

只有有效原始源完成QPC才生成captureWallTimeMs、captureMonotonicMs、captureClockUncertaintyMs及sourceCaptureId，与真实wire RTP/epoch配对。新OSR暂未测完成时戳，capture_time_us=0；提交、ready查询和编码时刻不能补作采集时间。

Client分别校准Endpoint媒体时钟与Control产品新鲜度时钟，不混用机器wall。过期、跳变、不确定度超限、隐藏及重复内容样本排除。WS feedback仍可报告p95/窗口/sequence等诊断，但不触发质量对账。

兼容名称capture-end-to-paint的终点为video compositor回调，不是物理屏幕点亮，也不含此前渲染等待。历史Canvas报告以当时JS提交为终点，不与Video直接混用。缺有效源时戳不产生样本，分段p95不可相加。

receiver支持jitterBufferTarget时设0；Chrome89仅在可用时设playoutDelayHint=0。分别报告能力，不把兼容hint或RTP playout-delay扩展说成标准属性已生效。

Endpoint默认另请求RTP playout-delay min0/max50ms，使支持的接收端使用WebRTC原生低延迟呈现策略，保留有界合成队列。`--rtc-playout-max-ms=-1`可在创建peer前显式保持未设置，合法非负10ms整数倍可覆盖默认。该值是best-effort请求，不是实际缓冲或端到端50ms保证；jitterBufferTarget=0也不取消解码、抖动或音视频同步所需等待。GCC、原生媒体适配和三档降级偏好保持原职责。

反馈sequence终生单调；时钟reset只清校准/样本，保留序号及已见内容身份。
