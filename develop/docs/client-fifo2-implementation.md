# MSTP 有界 FIFO2 刷新候选

2026-11-01。主Agent选定的实验实现：保留rAF对齐，每个rAF最多准入一个VideoFrame；测试专用 `latest1` / `fifo2`，默认仍是latest1。没有新增Viewer产品设置。性能收益和延迟尚待同配置实播，不能把更多draw调用当作已经显示更快。

## 行为与边界

`control/client/transport.ts` 将单pending owner改为容量1或2的队列。latest1满时关闭旧pending并保留新帧，延续旧策略；fifo2按read顺序使用队首，第三帧到来时关闭最旧pending，保留最新两帧及其顺序。一次rAF仅取一个候选；剩余队首再登记下一次rAF。当前latest-painted owner独立保留，供静止重挂载；每次新帧提交后关闭旧latest。

RTP仍读取真实VideoFrame metadata，必须与当前layout epoch、实际尺寸和source一致才排队准入。队首metadata尚未匹配时阻塞，不跳过它绘制第二帧；持续到帧时仍由容量2溢出淘汰最旧项。新read不会撤销上一成功plane的输入资格，layout/epoch/generation/geometry改变会清空pending及latest并撤销旧授权。stop、source replacement、断开和错误均释放持有帧；迟到旧source read仍finally close。重复已显示或已排队RTP不clone、不挪动队列。

fifo2的预期代价是将同一刷新间隔内的第二帧留到后续刷新，在正常60Hz且metadata就绪时比latest1增加约一个16.7ms刷新周期的候选等待；主线程等待、迟metadata和持续overflow时没有这个延迟上限。是否仍满足p95≤100ms必须与真实canvas FPS同组测量。

## 实验参数与有效策略

正式prepare新增：

- `-FrameSource track-processor -ProcessorScheduler latest1`：默认旧行为。
- `-FrameSource track-processor -ProcessorScheduler fifo2`：容量2、FIFO、rAF准入。
- `-ProcessorProfile`：开启有界客户端诊断；默认关闭。

对应config字段为 `processorScheduler`、`processorProfile`。benchmark在connect前设置，scheduler在processor创建时锁定，运行中修改public字段不会静默改变当前队列容量。`presentation.processor.scheduler` 报告实际生效值，`scheduling` 为 `requestAnimationFrame`；旧video路径报告inactive。MSTP的 `callbackRegistration` 现在为 `not-applicable`，避免把before/after-work误当MSTP控制变量；旧video/Chrome89仍报告实际注册策略。

两租户正式A/B只改变latest1→fifo2，source52、原分辨率、CRC1Hz、fake60、全部binary及bundle一致，不追加源帧率矩阵。诊断如开启，两组应一致开启并与无profile验收区分。

## 有界Profile

默认关闭。开启后每Transport固定最多16384条环形事件，不写console；超限覆盖最旧并报告total/overwritten。`getPresentationDiagnostics(true).processorProfile`导出，非raw秒级stats不重复导出事件数组；现有presentation-raw chunk上传机制承载。warmup后的reset只清计数/事件，不改变owner或调度。

事件包括read入口时间、VideoFrame timestamp（微秒源timestamp，不当RTP/网络时间）、真实RTP、已知epoch；metadata到达；RAF request时刻/id；callback参数timestamp与真实entryNow；实际paint起止、view/RTP/epoch；queueDepth；overflow/latest替换、重复、layout清空、stop及准入拒绝/错误原因。paint结束时刻在CRC同步listener之前。可直接计算read→request→entry→draw，不再把旧video的空authorizeWaitMs当0ms。

## 验证

已补有意义的回归：FIFO跨两个独立RAF保持顺序；容量2溢出只关最旧；迟/错误metadata阻塞队首；epoch清空latest+两个pending；paint回调中断开；重复pending；reader failure/迟旧source；subscriber异常；ring有界且reset保留owner。旧latest1及Chrome89 video相关回归一并保留。

主Agent明确释放CPU窗口后执行：`npm.cmd test` **74/74通过**（新增9项FIFO/Profile回归）；`npm.cmd run build`通过TypeScript、Vite、server bundle验证和production startup smoke。`git diff --check`通过。最终bundle为 `control/dist/client/assets/index-BI4yf---.js`，SHA256：`F86A2BA691C5C54A07EFF0D08E362ECB34B5D040EDADFFBC0B05C15DB3F38CD1`。

runtime精确变更为既有B52配置的 `processorScheduler: 'latest1'` → `'fifo2'`，两组 `processorProfile: false`，并固定以上同一个bundle及source/Endpoint binary。若调用prepare，公共追加参数是 `-FrameSource track-processor -PresentationMode snapshot -ProcessorScheduler latest1`，候选组只将最后值改 `fifo2`；两组均不传 `-ProcessorProfile`。既有10秒暖机/45秒采样等B52公共参数照旧，不能用prepare的默认1280×720/单租户/5秒暖机覆盖它们。

本实现未启动浏览器/GPU、未修改Endpoint/Browser或正式当前状态，未提交。CPU测试/build已结束，后续运行窗口由主Agent交runtime安排。
