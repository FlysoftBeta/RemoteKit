# 离屏 pacer 背压信号

无窗口宿主60fps四租户源吞吐提高，编码仍约11fps、3D busy约99.8%，因此需要约束过量源工作。当前先做独立pacer 60/30/20有界对照；自适应政策尚未选定。

## 已核对的接口

- `browser/gpu_atlas.cc`约698行：`consumed_->GetCompletedValue()`和`slot_values_[3]`可判断真实可复用输出槽。未初始化不是槽满，UINT64_MAX是设备错误。
- `dirty_`表示stage待发布更新，可能来自清空/元数据/stale变化，不是renderer积压帧数。
- `leases_`是已到browser并提交source→stage读取、仍等待ready Fence完成的capture lease。它看不到尚在Viz里的CopyOutput；当前没有view ID，要逐页归因需加本地字段。
- `capture_callbacks_/captured_/dropped_/mutex_drops_`是回调或桥接事后计数。
- `VideoFrameMetadata.capture_begin_time/capture_end_time`包含捕获排队、GPU及完成观察，不等于纯copy；`reference_time`是capturer event_time，不是GPU完成。
- **`VideoFrameMetadata.source_id/frame_sequence`已有精确renderer BeginFrame关联**：官方`FrameSinkVideoCapturerImpl.cc`约1029行从renderer `begin_frame_ack.frame_id`写入。browser当前可读但尚未保存/导出。可与各Host source ID及已发送sequence核对已到capture。

## 不应推导的等式

一次`ACK.has_damage`不保证有一次capture：oracle、帧率限制、资源不足、CopyOutput失败和静态复用都会打破它。刷新也可能重复旧content/BF关联。因此不能用has_damage扣一个capture credit后无限停止tick，否则可能静态死锁。

现有空闲槽/dirty/lease均是browser端或其后资源的信号，不能完整说明Viz排队。`ProvideFeedback`、min capture period和auto throttling影响capture oracle，不直接节制renderer BeginFrame；consumer接口没有通用“此tick不会产出capture”通知。

## 决策边界

source_id/frame_sequence可用于真实关联与年龄观测，不能据此虚构未到帧的数量。任何新pacer策略只改变browser本地准入；source lease仍由真实GPU读取完成归还，输出槽仍由consumed Fence保护。不能为了背压把BeginFrame ACK或CPU超时冒充GPU完成。
